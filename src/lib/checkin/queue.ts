import type { QueuedScan, StoredManifest } from './store';

/**
 * The decisions the offline queue makes, as pure functions
 * (spec/checkin.md §12.3).
 *
 * Separated from `store.ts` on purpose: IndexedDB cannot run in the CI test
 * environment, and logic that lives inside a database wrapper is logic nothing
 * regression-tests. Everything that could be *wrong* is here, where a test can
 * reach it without a browser.
 */

/** Scans this device still owes the server. */
export function pendingScans(scans: readonly QueuedScan[]): QueuedScan[] {
  return scans.filter((s) => !s.syncedAt);
}

/**
 * Is this manifest still safe to admit against?
 *
 * §12.3: it expires at show start + `checkin.manifest_ttl_hours`. Both bounds
 * come from the server — the TTL through the settings cascade and the timestamp
 * stamped at fetch — because a device with a wrong clock is most of the reason
 * a TTL fails at a door, and letting the phone decide its own expiry is exactly
 * the failure it causes.
 *
 * **A manifest with no expiry is fresh.** `null` means the cascade holds no
 * value for the key yet, and the concert is not going to be improved by a
 * scanner that refuses to work until an admin fills in a settings field. An
 * expired one is still *readable* — see {@link manifestStaleness} — because
 * refusing to admit anybody is never the safer failure at a door.
 */
export function isManifestFresh(
  manifest: Pick<StoredManifest, 'expiresAt'>,
  now: Date = new Date(),
): boolean {
  if (!manifest.expiresAt) return true;
  return now.getTime() < Date.parse(manifest.expiresAt);
}

export type ManifestStaleness = {
  fresh: boolean;
  /** What the shell tells the operator. Never a refusal to scan. */
  warning: string | null;
};

/**
 * What to say about a manifest that has aged out.
 *
 * The scanner keeps working on a stale manifest, and that is the deliberate
 * choice: the roster it holds is still the roster of everyone who was issued a
 * ticket, and a door that stops admitting because a timestamp passed is a
 * worse failure than one admitting against slightly old data. So expiry
 * produces a warning and a prompt to refresh, not a lock.
 */
export function manifestStaleness(
  manifest: Pick<StoredManifest, 'expiresAt' | 'fetchedAt'> | null,
  now: Date = new Date(),
): ManifestStaleness {
  if (!manifest) return { fresh: false, warning: 'No manifest on this device yet.' };
  if (isManifestFresh(manifest, now)) return { fresh: true, warning: null };
  return {
    fresh: false,
    warning: 'This roster has expired. Scanning still works — refresh when you have signal.',
  };
}

export type ScanReceipt = {
  qrTokenSha256: string;
  outcome: 'RECORDED' | 'ALREADY_SYNCED' | 'WRONG_SHOW' | 'NOT_FOUND';
};

/**
 * Which queued scans a batch of receipts settles.
 *
 * **Every outcome settles the scan, including the two that recorded nothing.**
 * A `NOT_FOUND` or `WRONG_SHOW` receipt is the server's final answer about that
 * token — retrying it on the next reconnect would put it back in the queue for
 * the rest of the night, and a queue that never drains is one that hides the
 * scans that genuinely have not synced yet.
 *
 * Matching is by `(qrTokenSha256, scannedAt)` rather than by digest alone,
 * because a ticket legitimately scanned twice has two queued rows and settling
 * both on one receipt would lose the second.
 */
export function settledScanIds(
  pending: readonly QueuedScan[],
  receipts: readonly ScanReceipt[],
  sentInOrder: readonly QueuedScan[],
): number[] {
  const settled: number[] = [];
  receipts.forEach((receipt, index) => {
    const sent = sentInOrder[index];
    if (!sent || sent.qrTokenSha256 !== receipt.qrTokenSha256) return;
    const match = pending.find(
      (p) => p.id === sent.id && p.qrTokenSha256 === receipt.qrTokenSha256,
    );
    if (match?.id !== undefined) settled.push(match.id);
  });
  return settled;
}

/**
 * Scans this device has made, newest first, for the Stats tab and the queue
 * badge.
 */
export function scanSummary(scans: readonly QueuedScan[]): {
  total: number;
  pending: number;
  synced: number;
} {
  const pending = pendingScans(scans).length;
  return { total: scans.length, pending, synced: scans.length - pending };
}
