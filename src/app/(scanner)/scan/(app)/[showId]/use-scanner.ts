'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildManifestIndex, hashQrToken, type ManifestEntry } from '@/lib/checkin/manifest';
import { evaluateScan, type FeedbackTone, type ScanResult } from '@/lib/checkin/evaluate';
import { extractQrToken } from '@/lib/checkin/token';
import { manifestStaleness, pendingScans, scanSummary, settledScanIds } from '@/lib/checkin/queue';
import {
  openCheckinStore,
  toLocalCheckIns,
  type CheckinStore,
  type QueuedScan,
  type StoredManifest,
} from '@/lib/checkin/store';
import { createScanFeedback, type ScanFeedback } from '@/lib/checkin/feedback';

/**
 * The door's state, in one place (spec/checkin.md §12).
 *
 * **Every scan resolves locally and then enqueues.** The network is not on the
 * path to a decision — it decides only when the queued row reaches the server.
 * Online that is immediate; offline the queue waits for `online` and drains.
 * An usher cannot tell the two apart from the screen, which is the point.
 *
 * Feedback is exposed as functions rather than as the ref that holds it, so no
 * component reaches into `.current` during a render. That is not only lint
 * appeasement: a ref read during render is a value React cannot re-run on, and
 * the mute toggle is exactly the state that would then stick.
 */

const DEVICE_KEY = 'zetix.scanner.device';

export type ScannerState = {
  ready: boolean;
  durable: boolean;
  manifest: StoredManifest | null;
  warning: string | null;
  online: boolean;
  refreshing: boolean;
  result: ScanResult | null;
  scans: QueuedScan[];
  summary: { total: number; pending: number; synced: number };
};

type ManifestResponse = { fetchedAt: string; attendees: ManifestEntry[] };
type ReceiptResponse = {
  receipts: {
    qrTokenSha256: string;
    outcome: 'RECORDED' | 'ALREADY_SYNCED' | 'WRONG_SHOW' | 'NOT_FOUND';
  }[];
};

export function useScanner({
  showId,
  manifestExpiresAt,
  scanDebounceMs,
}: {
  showId: number;
  manifestExpiresAt: string | null;
  scanDebounceMs: number;
}) {
  const storeRef = useRef<CheckinStore | null>(null);
  const feedbackRef = useRef<ScanFeedback | null>(null);
  const deviceIdRef = useRef<string>('');
  /** Last time each token fired, for `checkin.scan_debounce_ms` (§12.1). */
  const lastSeenRef = useRef<Map<string, number>>(new Map());
  const drainingRef = useRef(false);

  const [ready, setReady] = useState(false);
  const [durable, setDurable] = useState(true);
  const [manifest, setManifest] = useState<StoredManifest | null>(null);
  const [scans, setScans] = useState<QueuedScan[]>([]);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [online, setOnline] = useState(true);
  const [muted, setMutedState] = useState(false);

  const index = useMemo(() => buildManifestIndex(manifest?.attendees ?? []), [manifest]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch(`/api/checkin/manifest?showId=${showId}`, {
        cache: 'no-store',
      });
      if (!response.ok) return;
      const body = (await response.json()) as ManifestResponse;
      const next: StoredManifest = {
        showId,
        attendees: body.attendees,
        fetchedAt: body.fetchedAt,
        expiresAt: manifestExpiresAt,
      };
      await storeRef.current?.saveManifest(next);
      setManifest(next);
    } catch {
      // Offline, or the venue wifi dropped mid-request. The manifest already on
      // the device is still the roster, and the connection badge is already
      // saying everything there is to say.
    } finally {
      setRefreshing(false);
    }
  }, [showId, manifestExpiresAt]);

  /**
   * Send everything this device owes the server.
   *
   * Guarded against re-entry: `online` firing while a drain is in flight would
   * send the same batch twice. The endpoint is idempotent so that is survivable
   * rather than corrupting, but a door does not need spare requests on a
   * network that is already struggling.
   */
  const drain = useCallback(async () => {
    const store = storeRef.current;
    if (!store || drainingRef.current) return;

    drainingRef.current = true;
    try {
      /**
       * **Loop until the queue is actually empty, not until one batch is sent.**
       *
       * Scans made *while* a drain is in flight are the normal case, not an
       * edge one: "Admit remaining 3" enqueues four rows in a tight loop, and
       * the re-entry guard below turns the last three into no-ops. An earlier
       * version stopped after the first batch, which left three of the four
       * stranded until the network next blipped — at a door, that is three
       * people admitted and unrecorded, and the stats tab wrong for the rest of
       * the night, which is exactly the failure the party control exists to
       * prevent.
       */
      for (;;) {
        const all = await store.allScans(showId);
        const pending = pendingScans(all);
        setScans(all);
        if (pending.length === 0) return;

        const response = await fetch('/api/checkin/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            showId,
            scans: pending.map((s) => ({
              qrTokenSha256: s.qrTokenSha256,
              scannedAt: s.scannedAt,
              source: s.source,
              deviceId: s.deviceId,
              overrideReason: s.overrideReason ?? null,
            })),
          }),
        });
        if (!response.ok) return;

        const body = (await response.json()) as ReceiptResponse;
        const settled = settledScanIds(pending, body.receipts, pending);
        // Nothing settled means another pass would send the same rows forever.
        // Stop and let the next reconnect try again.
        if (settled.length === 0) return;
        await store.markSynced(settled, new Date().toISOString());
      }
    } catch {
      // Still offline. The queue keeps its rows and the next `online` retries.
    } finally {
      drainingRef.current = false;
      const latest = await store.allScans(showId);
      setScans(latest);
    }
  }, [showId]);

  const enqueue = useCallback(
    async (
      qrTokenSha256: string,
      source: 'ONLINE' | 'MANUAL',
      overrideReason: string | null,
    ) => {
      const store = storeRef.current;
      if (!store) return;

      await store.enqueue({
        showId,
        qrTokenSha256,
        // The phone's clock, preserved verbatim through a delayed sync (§12.3).
        scannedAt: new Date().toISOString(),
        source: navigator.onLine ? source : 'OFFLINE_SYNC',
        deviceId: deviceIdRef.current,
        overrideReason,
      });
      setScans(await store.allScans(showId));
      if (navigator.onLine) void drain();
    },
    [showId, drain],
  );

  /**
   * A decoded QR, or a code chosen in Search.
   *
   * Returns the result so the caller can flash it. `null` means the debounce
   * swallowed it and nothing at all should happen — no colour, no sound, no row.
   */
  const submitScan = useCallback(
    async (decoded: string): Promise<ScanResult | null> => {
      const token = extractQrToken(decoded);
      const hash = token ? await hashQrToken(token) : null;

      if (hash) {
        // §12.1: continuous scanning is debounced per token, so a camera
        // holding focus on one QR does not fire repeatedly.
        const now = Date.now();
        const last = lastSeenRef.current.get(hash);
        if (last !== undefined && now - last < scanDebounceMs) return null;
        lastSeenRef.current.set(hash, now);
      }

      const store = storeRef.current;
      const all = store ? await store.allScans(showId) : [];
      const local = evaluateScan({ hash, index, checkIns: toLocalCheckIns(all) });

      setResult(local);
      feedbackRef.current?.play(local.tone);

      // Only an admission becomes a row. A red the operator does not override
      // is not a check-in, and enqueuing it would put a phantom in the log.
      if (local.outcome === 'ADMITTED' && hash) {
        await enqueue(hash, 'ONLINE', null);
      }

      return local;
    },
    [index, showId, scanDebounceMs, enqueue],
  );

  /** "Admit anyway" on an amber or red result, and "Admit remaining N". */
  const admit = useCallback(
    async (entries: readonly ManifestEntry[], overrideReason: string | null) => {
      for (const entry of entries) {
        await enqueue(entry.qrTokenSha256, 'MANUAL', overrideReason);
      }
    },
    [enqueue],
  );

  /**
   * Boot: open storage, load whatever this device already has, and only then
   * reach for the network. A phone that arrives at the venue with no signal
   * must come up fully usable from its own IndexedDB.
   *
   * **Deliberately re-runnable.** An earlier version guarded this with a
   * "have I booted" ref, which deadlocked the screen on a spinner: React mounts,
   * unmounts and remounts in development and may remount at any time in
   * production, so the first pass was cancelled by its own cleanup and the
   * second returned early at the guard — leaving `ready` false forever. Opening
   * IndexedDB twice is cheap and idempotent; a door stuck on a spinner is not.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const store = await openCheckinStore();
      if (cancelled) return;
      storeRef.current = store;
      feedbackRef.current ??= createScanFeedback();
      deviceIdRef.current = deviceId();
      setDurable(store.durable);
      setMutedState(feedbackRef.current.muted());

      const [saved, existing] = await Promise.all([
        store.loadManifest(showId),
        store.allScans(showId),
      ]);
      if (cancelled) return;
      setManifest(saved);
      setScans(existing);
      setReady(true);

      if (navigator.onLine) void refresh();
    })();

    return () => {
      cancelled = true;
    };
  }, [showId, refresh]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  /** Drain whenever the network returns, and once as soon as boot completes. */
  useEffect(() => {
    if (online && ready) void drain();
  }, [online, ready, drain]);

  const unlockAudio = useCallback(async () => {
    await feedbackRef.current?.unlock();
    setMutedState(feedbackRef.current?.muted() ?? false);
  }, []);

  const setMuted = useCallback((next: boolean) => {
    feedbackRef.current?.setMuted(next);
    setMutedState(next);
  }, []);

  const playTone = useCallback((tone: FeedbackTone) => {
    feedbackRef.current?.play(tone);
  }, []);

  const dismissResult = useCallback(() => setResult(null), []);

  const state: ScannerState = {
    ready,
    durable,
    manifest,
    warning: manifestStaleness(manifest).warning,
    online,
    refreshing,
    result,
    scans,
    summary: scanSummary(scans),
  };

  return {
    state,
    index,
    muted,
    submitScan,
    admit,
    refresh,
    drain,
    dismissResult,
    unlockAudio,
    setMuted,
    playTone,
  };
}

/**
 * A stable id for this handset, so the scan log can tell six ushers apart.
 *
 * Not an identity and not a security control — `check_ins.operator_id` is who
 * did it. This answers "which phone", which is what a post-mortem on a
 * duplicated party actually needs.
 */
function deviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY);
    if (existing) return existing;
    const created = `dev-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(DEVICE_KEY, created);
    return created;
  } catch {
    return `dev-ephemeral-${Math.random().toString(36).slice(2, 10)}`;
  }
}
