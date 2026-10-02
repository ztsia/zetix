import type { QueuedScan, QueuedWalkIn, StoredManifest } from './store';

/**
 * The decisions the offline queue makes, as pure functions
 * (spec/checkin.md §12.3).
 *
 * Separated from `store.ts` on purpose: IndexedDB cannot run in the CI test
 * environment, and logic that lives inside a database wrapper is logic nothing
 * regression-tests. Everything that could be *wrong* is here, where a test can
 * reach it without a browser.
 */

/**
 * Scans this device still owes the server.
 *
 * Refused rows are not owed: the server has given its answer, and re-sending
 * one would only refuse it again — or, before §32.2, refuse the whole batch it
 * travelled in.
 */
export function pendingScans(scans: readonly QueuedScan[]): QueuedScan[] {
  return scans.filter((s) => !s.syncedAt && !s.refusedAt);
}

/**
 * Who may send a queued row: the operator who made it (spec/v3.md §32.2).
 *
 * The server stamps `check_ins.operator_id` from the session, so a row sent by
 * the next person to sign in on this phone would be recorded as theirs — and if
 * they are not rostered on the show, refused outright. A row with no tag was
 * queued before the tag existed, and is sent by whoever is signed in, which is
 * what every build before this one did.
 */
export function ownScans(scans: readonly QueuedScan[], operatorId: string): QueuedScan[] {
  return scans.filter((s) => !s.operatorId || s.operatorId === operatorId);
}

/**
 * Unsynced admissions left on this phone by somebody else, by name, so the
 * operator now signed in can be told whose scans are waiting.
 */
export function othersWaiting(
  scans: readonly QueuedScan[],
  operatorId: string,
): { operatorName: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const scan of pendingScans(scans)) {
    if (!scan.operatorId || scan.operatorId === operatorId) continue;
    const name = scan.operatorName || 'another operator';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([operatorName, count]) => ({ operatorName, count }));
}

/** Scans the server refused, or that could never be sent: "couldn't sync". */
export function refusedScans(scans: readonly QueuedScan[]): QueuedScan[] {
  return scans.filter((s) => !s.syncedAt && Boolean(s.refusedAt));
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

/**
 * The server's answer for one row. `REFUSED` is a row it could not read.
 *
 * Each receipt names the position of the row it answers, in the batch as sent,
 * so a receipt list that drifted out of step with the batch can never mark the
 * wrong row synced.
 */
export type ScanReceipt = {
  index: number;
  outcome: 'RECORDED' | 'ALREADY_SYNCED' | 'WRONG_SHOW' | 'NOT_FOUND' | 'REFUSED';
  showName?: string | null;
};

/** The longest an override reason may be, matching the route's schema. */
const MAX_REASON = 500;
const HASH = /^[0-9a-f]{64}$/;

/**
 * Split what is owed into what can be sent and what never could be.
 *
 * A row with neither a seat nor a well-formed digest cannot name anybody, and
 * the route would refuse it — before §32.2, by refusing the whole batch with a
 * 400, every batch, for the rest of the night. Those rows were queued by an
 * older build for a seat with no ticket. They are set aside here so the server
 * never sees them, with a reason the operator can act on.
 */
export function prepareBatch(pending: readonly QueuedScan[]): {
  send: QueuedScan[];
  setAside: { id: number; reason: string }[];
} {
  const send: QueuedScan[] = [];
  const setAside: { id: number; reason: string }[] = [];
  for (const scan of pending) {
    if (scan.id === undefined) continue;
    const named =
      (scan.attendeeId != null && Number.isInteger(scan.attendeeId) && scan.attendeeId > 0) ||
      (typeof scan.qrTokenSha256 === 'string' && HASH.test(scan.qrTokenSha256));
    if (!named || !scan.deviceId || Number.isNaN(Date.parse(scan.scannedAt))) {
      setAside.push({
        id: scan.id,
        reason:
          'This admission does not say which seat it was for, so it cannot be recorded. Tell the desk who it was.',
      });
      continue;
    }
    send.push(
      scan.overrideReason && scan.overrideReason.length > MAX_REASON
        ? { ...scan, overrideReason: scan.overrideReason.slice(0, MAX_REASON) }
        : scan,
    );
  }
  return { send, setAside };
}

/**
 * How one batch's receipts settle the rows that were sent.
 *
 * **Row by row.** A recorded row, or one the server already had, is synced. Any
 * other answer is final for that row and sets it aside as refused, with the
 * reason in words; the rest of the batch settles regardless. A row with no
 * receipt naming it is left pending, to be tried again.
 *
 * `NOT_FOUND` and `WRONG_SHOW` are refusals for a queued admission: the person
 * is in the hall and the server has no seat to record them against, which is
 * exactly what the desk needs to hear about rather than have settle silently.
 */
export function settleReceipts(
  sent: readonly QueuedScan[],
  receipts: readonly ScanReceipt[],
): { synced: number[]; refused: { id: number; reason: string }[] } {
  const synced: number[] = [];
  const refused: { id: number; reason: string }[] = [];
  const byIndex = new Map(receipts.map((r) => [r.index, r]));
  sent.forEach((scan, index) => {
    const receipt = byIndex.get(index);
    if (scan.id === undefined || !receipt) return;
    switch (receipt.outcome) {
      case 'RECORDED':
      case 'ALREADY_SYNCED':
        synced.push(scan.id);
        break;
      case 'WRONG_SHOW':
        refused.push({
          id: scan.id,
          reason: receipt.showName
            ? `The server says this ticket is for ${receipt.showName}.`
            : 'The server says this ticket is for another show.',
        });
        break;
      case 'NOT_FOUND':
        refused.push({
          id: scan.id,
          reason:
            'The server has no such seat any more. It may have been removed, or its QR voided, after this phone downloaded the roster.',
        });
        break;
      default:
        refused.push({ id: scan.id, reason: 'The server could not read this admission.' });
    }
  });
  return { synced, refused };
}

/**
 * Scans this device has made, newest first, for the Stats tab and the queue
 * badge.
 */
export function scanSummary(scans: readonly QueuedScan[]): {
  total: number;
  pending: number;
  synced: number;
  refused: number;
} {
  const pending = pendingScans(scans).length;
  const refused = refusedScans(scans).length;
  return { total: scans.length, pending, synced: scans.length - pending - refused, refused };
}

// ---------------------------------------------------------------------------
// Walk-ins (spec/v3.md §32.2)
// ---------------------------------------------------------------------------

/** This operator's walk-ins the server has not had yet — synced and refused excluded. */
export function pendingWalkIns(rows: readonly QueuedWalkIn[], operatorId: string): QueuedWalkIn[] {
  return rows.filter((w) => !w.syncedAt && !w.refusedAt && w.operatorId === operatorId);
}

export type WalkInReceipt = {
  index: number;
  outcome: 'RECORDED' | 'ALREADY_SYNCED' | 'REFUSED';
  reason?: string;
};

/**
 * How one batch's receipts settle the walk-ins sent, row by row — the same
 * rule as scans: recorded or already there is synced; refused is set aside with
 * the server's reason and never re-sent; no receipt leaves it pending.
 */
export function settleWalkIns(
  sent: readonly QueuedWalkIn[],
  receipts: readonly WalkInReceipt[],
): { synced: string[]; refused: { clientId: string; reason: string }[] } {
  const byIndex = new Map(receipts.map((r) => [r.index, r]));
  const synced: string[] = [];
  const refused: { clientId: string; reason: string }[] = [];
  sent.forEach((walkIn, index) => {
    const receipt = byIndex.get(index);
    if (!receipt) return;
    if (receipt.outcome === 'REFUSED') {
      refused.push({ clientId: walkIn.clientId, reason: receipt.reason ?? 'The server could not record this walk-in.' });
    } else {
      synced.push(walkIn.clientId);
    }
  });
  return { synced, refused };
}
