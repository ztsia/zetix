'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildManifestIndex,
  hashQrToken,
  normaliseEntries,
  type ManifestEntry,
} from '@/lib/checkin/manifest';
import {
  applyServerOutcome,
  evaluateScan,
  type FeedbackTone,
  type ScanResult,
} from '@/lib/checkin/evaluate';
import { extractQrToken } from '@/lib/checkin/token';
import {
  manifestStaleness,
  othersWaiting,
  ownScans,
  pendingScans,
  refusedScans,
  prepareBatch,
  scanSummary,
  settleReceipts,
  type ScanReceipt,
} from '@/lib/checkin/queue';
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

/** spec/v3.md §32.2: an attendee with no ticket is admitted with this reason. */
export const NO_TICKET_REASON = 'No ticket issued';

export type ScannerState = {
  ready: boolean;
  durable: boolean;
  manifest: StoredManifest | null;
  warning: string | null;
  online: boolean;
  refreshing: boolean;
  result: ScanResult | null;
  scans: QueuedScan[];
  summary: { total: number; pending: number; synced: number; refused: number };
  /** True while a drain is in flight, so the header can say "Syncing". */
  syncing: boolean;
  /**
   * The server answered 401: the session expired or was revoked. Said out
   * loud, with the count, rather than leaving a "queued" badge that never
   * clears (spec/v3.md §32.2).
   */
  signedOut: boolean;
  /** Rows the server refused, with their reasons: "couldn't sync". */
  refused: QueuedScan[];
  /** Unsynced admissions somebody else left on this phone, by name. */
  othersWaiting: { operatorName: string; count: number }[];
};

type ManifestResponse = { fetchedAt: string; attendees: ManifestEntry[] };
type ReceiptResponse = { receipts: ScanReceipt[] };

export function useScanner({
  showId,
  manifestExpiresAt,
  scanDebounceMs,
  operatorId,
  operatorName,
}: {
  showId: number;
  manifestExpiresAt: string | null;
  scanDebounceMs: number;
  /** The signed-in operator. Every queued row is tagged with them. */
  operatorId: string;
  operatorName: string;
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
  const [syncing, setSyncing] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [muted, setMutedState] = useState(false);

  const index = useMemo(() => buildManifestIndex(manifest?.attendees ?? []), [manifest]);
  /** The latest index, for `drain`, which must not re-create on every refresh. */
  const indexRef = useRef(index);
  useEffect(() => {
    indexRef.current = index;
  }, [index]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch(`/api/checkin/manifest?showId=${showId}`, {
        cache: 'no-store',
      });
      if (response.status === 401) setSignedOut(true);
      if (!response.ok) return;
      setSignedOut(false);
      const body = (await response.json()) as ManifestResponse;
      const next: StoredManifest = {
        showId,
        attendees: normaliseEntries(body.attendees),
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
    setSyncing(true);
    try {
      /**
       * **Loop until the queue is actually empty, not until one batch is sent.**
       *
       * Scans made *while* a drain is in flight are the normal case, not an
       * edge one: "Admit remaining 3" enqueues four rows in a tight loop, and
       * the re-entry guard below turns the last three into no-ops. An earlier
       * version stopped after the first batch, which left three of the four
       * stranded until the network next blipped.
       *
       * **And one bad row never blocks the rest** (spec/v3.md §32.2). Each
       * receipt settles its own row; a row the server refuses is set aside as
       * "couldn't sync" and never sent again. Before, one row the server could
       * not read made every later batch a 400, for the rest of the night.
       */
      for (;;) {
        const all = await store.allScans(showId);
        setScans(all);
        const { send, setAside } = prepareBatch(pendingScans(ownScans(all, operatorId)));
        if (setAside.length > 0) await store.markRefused(setAside, new Date().toISOString());
        if (send.length === 0) return;

        const response = await fetch('/api/checkin/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            showId,
            scans: send.map((s) => ({
              attendeeId: s.attendeeId ?? attendeeIdFor(s.qrTokenSha256),
              qrTokenSha256: s.qrTokenSha256,
              scannedAt: s.scannedAt,
              source: s.source,
              deviceId: s.deviceId,
              overrideReason: s.overrideReason ?? null,
            })),
          }),
        });

        if (response.status === 404) {
          /**
           * Not assigned to this show any more (§14.3). The server has already
           * put these on the desk's rejected-sync list, so sending them again
           * would only say it twice. Set aside, with the reason.
           */
          await store.markRefused(
            send.flatMap((s) =>
              s.id === undefined
                ? []
                : [
                    {
                      id: s.id,
                      reason:
                        'This account is no longer assigned to this show. The desk has been told about these admissions.',
                    },
                  ],
            ),
            new Date().toISOString(),
          );
          return;
        }
        // Signed out, or the server is struggling: keep everything and retry
        // on the next reconnect. Neither is an answer about any one row.
        if (response.status === 401) setSignedOut(true);
        if (!response.ok) return;
        setSignedOut(false);

        const body = (await response.json()) as ReceiptResponse;
        const { synced, refused } = settleReceipts(send, body.receipts ?? []);
        const at = new Date().toISOString();
        if (synced.length > 0) await store.markSynced(synced, at);
        if (refused.length > 0) await store.markRefused(refused, at);
        // Nothing settled means another pass would send the same rows forever.
        // Stop and let the next reconnect try again.
        if (synced.length + refused.length === 0) return;
      }
    } catch {
      // Still offline. The queue keeps its rows and the next `online` retries.
    } finally {
      drainingRef.current = false;
      setSyncing(false);
      const latest = await store.allScans(showId);
      setScans(latest);
    }
  }, [showId, operatorId]);

  /** A legacy row's seat, found through the manifest, so it can be sent by id. */
  function attendeeIdFor(hash: string | null): number | null {
    if (!hash) return null;
    return indexRef.current.byHash.get(hash)?.attendeeId ?? null;
  }

  const enqueue = useCallback(
    async (entry: ManifestEntry, source: 'ONLINE' | 'MANUAL', overrideReason: string | null) => {
      const store = storeRef.current;
      if (!store) return;

      await store.enqueue({
        showId,
        attendeeId: entry.attendeeId,
        qrTokenSha256: entry.qrTokenSha256,
        // The phone's clock, preserved verbatim through a delayed sync (§12.3).
        scannedAt: new Date().toISOString(),
        /**
         * **A deliberate admission stays MANUAL even with no network.**
         *
         * §12.1 wants the party control and every override recorded as MANUAL;
         * §12.3 wants a delayed drain recorded as OFFLINE_SYNC. There is one
         * column, so they cannot both win, and MANUAL is the one worth keeping:
         * it records *how the admission was decided* — a human deliberately
         * tapped — which is the fact a post-mortem on a duplicated party needs.
         * That it synced late is not lost either, and does not need this column
         * to say so: the gap between `scanned_at` and `synced_at` is exactly
         * that, and is why the schema carries both.
         */
        source: source === 'MANUAL' ? 'MANUAL' : navigator.onLine ? 'ONLINE' : 'OFFLINE_SYNC',
        deviceId: deviceIdRef.current,
        overrideReason,
        operatorId,
        operatorName,
      });
      setScans(await store.allScans(showId));
      if (navigator.onLine) void drain();
    },
    [showId, drain, operatorId, operatorName],
  );

  /**
   * What the server makes of a token this device does not recognise.
   *
   * One scan, posted for its verdict rather than to be recorded — see the call
   * site. Any failure returns the local result untouched: a door does not stop
   * for a question it only asked out of politeness.
   */
  const askServer = useCallback(
    async (qrTokenSha256: string, local: ScanResult): Promise<ScanResult> => {
      try {
        const response = await fetch('/api/checkin/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            showId,
            scans: [
              {
                qrTokenSha256,
                scannedAt: new Date().toISOString(),
                source: 'ONLINE',
                deviceId: deviceIdRef.current,
                overrideReason: null,
              },
            ],
          }),
        });
        if (!response.ok) return local;

        const body = (await response.json()) as ReceiptResponse;
        const receipt = body.receipts[0];
        if (!receipt) return local;

        return applyServerOutcome(local, {
          outcome: receipt.outcome === 'WRONG_SHOW' ? 'WRONG_SHOW' : 'NOT_FOUND',
          showName: receipt.showName ?? null,
        });
      } catch {
        return local;
      }
    },
    [showId],
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
      const local = evaluateScan({ hash, index, checkIns: toLocalCheckIns(all, index) });

      setResult(local);
      feedbackRef.current?.play(local.tone);

      // Only an admission becomes a row. A red the operator does not override
      // is not a check-in, and enqueuing it would put a phantom in the log.
      if (local.outcome === 'ADMITTED' && local.entry) {
        await enqueue(local.entry, 'ONLINE', null);
        return local;
      }

      /**
       * **"Not found" is where the phone runs out of what it can know.**
       *
       * The device holds one show's roster, so a ticket for another show is
       * locally indistinguishable from a forgery — and §12.1's result table
       * asks for "Wrong show", naming the show the ticket is actually for. The
       * server sees every show and can answer, so when there is a network, ask
       * it.
       *
       * Safe to send: the write endpoint resolves the digest first and records
       * **nothing** for a token that is not in this show, so this asks a
       * question without creating a row. And it is strictly an upgrade — the
       * flash, the tone and the buzz have already fired from the local
       * decision, so nothing here delays what the usher sees.
       */
      if (local.outcome === 'NOT_FOUND' && hash && navigator.onLine) {
        const upgraded = await askServer(hash, local);
        if (upgraded !== local) setResult(upgraded);
        return upgraded;
      }

      return local;
    },
    [index, showId, scanDebounceMs, enqueue, askServer],
  );

  /**
   * "Admit anyway" on an amber or red result, and the party sheet — each seat
   * with its own reason, because one tap can admit a guest who is fine beside
   * one who is already in (spec/v3.md §32.2).
   *
   * A seat with no ticket is admitted by its attendee id, and its reason always
   * starts with the one §32.2 names.
   */
  const admit = useCallback(
    async (items: readonly { entry: ManifestEntry; reason: string | null }[]) => {
      for (const { entry, reason } of items) {
        await enqueue(
          entry,
          'MANUAL',
          entry.hasTicket ? reason : reason ? `${NO_TICKET_REASON} · ${reason}` : NO_TICKET_REASON,
        );
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
      // A roster saved by an older build lacks the fields 0205 added.
      setManifest(saved ? { ...saved, attendees: normaliseEntries(saved.attendees) } : null);
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

  /**
   * Make this phone safe to hand back (spec/v3.md §32.2, ref.md §4: "assume at
   * least one usher phone will be left unlocked on a table").
   *
   * One last drain if there is signal, then every roster on the phone goes, and
   * every row the server already holds. What is still unsynced stays, tagged
   * with this operator, for them to send when they next sign in here. The
   * server-side sign-out is the caller's next step.
   */
  const prepareSignOut = useCallback(async () => {
    const store = storeRef.current;
    if (!store) return;
    if (navigator.onLine) await drain();
    await store.wipeForSignOut();
    setManifest(null);
  }, [drain]);

  const state: ScannerState = {
    ready,
    durable,
    manifest,
    warning: manifestStaleness(manifest).warning,
    online,
    refreshing,
    result,
    scans,
    summary: scanSummary(ownScans(scans, operatorId)),
    syncing,
    signedOut,
    refused: refusedScans(ownScans(scans, operatorId)),
    othersWaiting: othersWaiting(scans, operatorId),
  };

  return {
    state,
    index,
    muted,
    submitScan,
    admit,
    refresh,
    drain,
    prepareSignOut,
    dismissResult,
    unlockAudio,
    setMuted,
    playTone,
  };
}

/**
 * A stable id for this handset, so the scan log can tell the door’s phones apart.
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
