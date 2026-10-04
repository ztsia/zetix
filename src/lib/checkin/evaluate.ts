import type { ManifestEntry, ManifestIndex } from './manifest';

/**
 * What the door decides, and it decides it locally (spec/checkin.md §12.1).
 *
 * **There is one code path and connectivity is not in it.** Decode, hash, look
 * up the manifest, choose a state. Online or offline, the usher gets the same
 * answer in the same time; what the network changes is only when the resulting
 * row reaches the server (§12.3). Keeping this function pure and synchronous is
 * what makes that true — and what makes the whole admission logic testable
 * without a browser, a camera or a database.
 *
 * **Nothing here refuses anybody.** It returns a state; the operator decides.
 * Amber and red are never hard blocks (§12.1) because turning away a real guest
 * at a free concert is worse than a duplicate row that someone reverts later.
 */

/** The five states of §12.1's result table. */
export type ScanOutcome =
  | 'ADMITTED'
  | 'ALREADY_CHECKED_IN'
  | 'CANCELLED'
  /** On the waitlist or awaiting review: not a confirmed seat (spec/v3.md §32.3). */
  | 'ON_HOLD'
  | 'WRONG_SHOW'
  | 'NOT_FOUND';

/**
 * The feedback signature (spec/checkin.md §12.2).
 *
 * Three tones for five states: every red state sounds and feels identical, and
 * only colour and text tell them apart. That collapse is deliberate — in a loud
 * foyer the ear's job is "stop and read the screen", and a guest whose ticket
 * is cancelled and a guest whose ticket is unreadable need the usher's
 * attention in exactly the same way.
 */
export type FeedbackTone = 'admitted' | 'duplicate' | 'error';

/** One scan this device has already recorded, from its own queue and history. */
export type LocalCheckIn = {
  /** The seat, by `entryKey()` (spec/v3.md §32.2) — never the token's digest. */
  key: string;
  /** When the phone read it — preserved through an offline sync (§12.3). */
  scannedAt: string;
  source: 'ONLINE' | 'OFFLINE_SYNC' | 'MANUAL';
  operatorName?: string | null;
  /** Set by the admin dashboard's revert (module `H`); never a delete (decision 7). */
  revertedAt?: string | null;
};

export type PartyContext = {
  size: number;
  admitted: number;
  remaining: number;
};

export type ScanResult = {
  outcome: ScanOutcome;
  tone: FeedbackTone;
  entry?: ManifestEntry;
  /** Present on ALREADY_CHECKED_IN — the earliest scan, so the usher can judge. */
  firstScan?: { at: string; operatorName?: string | null };
  /** Present whenever an attendee was identified; drives "Admit remaining N". */
  party?: PartyContext;
  /**
   * Whether the operator can override into an admission.
   *
   * True for every state that names an attendee, including cancelled — that is
   * §12.1's "amber and red are never hard blocks". False only for NOT_FOUND,
   * and for a structural reason rather than a policy one: `check_ins` requires
   * an `attendee_id` and an unrecognised token has none, so there is no row to
   * write. The usher can still let the person in; the system simply cannot
   * record it, and says so rather than offering a button that would fail.
   */
  canAdmitAnyway: boolean;
  /** Named by the server once a "not found" turns out to belong to another show. */
  wrongShowName?: string | null;
  /**
   * Set when the server reports this attendee was already scanned elsewhere.
   * The result stays ADMITTED — see {@link applyServerOutcome} — and this is
   * the detail the operator reads afterwards rather than a reversal.
   */
  alsoScanned?: ScanResult['firstScan'] | null;
};

const TONES: Record<ScanOutcome, FeedbackTone> = {
  ADMITTED: 'admitted',
  ALREADY_CHECKED_IN: 'duplicate',
  CANCELLED: 'error',
  ON_HOLD: 'error',
  WRONG_SHOW: 'error',
  NOT_FOUND: 'error',
};

export type EvaluateInput = {
  /** The scanned token's digest, or null when the QR carried nothing token-shaped. */
  hash: string | null;
  index: ManifestIndex;
  /** This device's own history for the selected show. */
  checkIns: readonly LocalCheckIn[];
};

export function evaluateScan({ hash, index, checkIns }: EvaluateInput): ScanResult {
  if (hash === null) return red('NOT_FOUND', false);

  const entry = index.byHash.get(hash);
  if (!entry) {
    /**
     * **A token this manifest does not know is "not found", not "wrong show".**
     *
     * The device holds one show's roster, so a ticket for another show is
     * genuinely indistinguishable from an invalid one here — there is nothing
     * offline to tell them apart. §12.1 wants "wrong show" named where it can
     * be, and it can be: the scan still POSTs, and the server, which sees every
     * show, upgrades the result through {@link applyServerOutcome}. Offline it
     * stays "not found", which is honest rather than convenient.
     */
    return red('NOT_FOUND', false);
  }

  const live = checkIns.filter((c) => !c.revertedAt);
  const party = partyContext(entry, index, live);
  const key = index.keyOf(entry);

  /**
   * Cancelled is checked before duplicate, and the order is the whole point of
   * spec/allocation.md §7.9: the door must say "cancelled — refer to desk"
   * rather than anything that sounds like a forgery. A cancelled seat that was
   * also scanned is still, first, cancelled.
   */
  if (entry.status === 'CANCELLED') {
    return { outcome: 'CANCELLED', tone: TONES.CANCELLED, entry, party, canAdmitAnyway: true };
  }

  /**
   * A seat on the waitlist or under review is not admitted by its code
   * (spec/v3.md §32.3): the guest's own page tells them so, and the door must
   * agree with it. Like every red, it is never a hard block — the desk may know
   * better, and "Admit anyway" stays.
   */
  if (entry.status === 'WAITLIST' || entry.status === 'PENDING_REVIEW') {
    return { outcome: 'ON_HOLD', tone: TONES.ON_HOLD, entry, party, canAdmitAnyway: true };
  }

  const prior = firstCheckIn(entry, key, live);

  if (prior) {
    return {
      outcome: 'ALREADY_CHECKED_IN',
      tone: TONES.ALREADY_CHECKED_IN,
      entry,
      party,
      firstScan: prior,
      canAdmitAnyway: true,
    };
  }

  return {
    outcome: 'ADMITTED',
    tone: TONES.ADMITTED,
    entry,
    // This scan is the one being made, so it counts towards the party.
    party: { ...party, admitted: party.admitted + 1, remaining: party.remaining - 1 },
    canAdmitAnyway: true,
  };
}

/**
 * The earliest admission of one seat, from this phone or from the server.
 *
 * The manifest carries the server's first live check-in as of the download
 * (§12.3, spec/v3.md §32.2), so a guest another phone admitted reads as
 * "already checked in" here too, once this phone has refreshed — not only the
 * guests this phone scanned itself.
 */
export function firstCheckIn(
  entry: ManifestEntry,
  key: string,
  live: readonly LocalCheckIn[],
): { at: string; operatorName?: string | null } | null {
  const local = live
    .filter((c) => c.key === key)
    .sort((a, b) => a.scannedAt.localeCompare(b.scannedAt))[0];
  const server = entry.checkedInAt
    ? { at: entry.checkedInAt, operatorName: entry.checkedInBy }
    : null;
  if (local && (!server || local.scannedAt < server.at)) {
    return { at: local.scannedAt, operatorName: local.operatorName ?? null };
  }
  return server;
}

/** The keys of every seat that is in, on this phone's evidence or the server's. */
export function admittedKeys(index: ManifestIndex, live: readonly LocalCheckIn[]): Set<string> {
  const keys = new Set(live.filter((c) => !c.revertedAt).map((c) => c.key));
  for (const entry of index.entries) {
    if (entry.checkedInAt) keys.add(index.keyOf(entry));
  }
  return keys;
}

/**
 * How much of this party is already through.
 *
 * `partySize` comes from the manifest and already excludes cancelled seats,
 * because a cancelled seat is not one of the remaining. Counting is by distinct
 * seat so a party member scanned twice does not consume two of the four.
 */
function partyContext(
  entry: ManifestEntry,
  index: ManifestIndex,
  live: readonly LocalCheckIn[],
): PartyContext {
  const members = index.byRegistration.get(entry.registrationId) ?? [entry];
  const inKeys = admittedKeys(index, live);
  const admitted = members.filter(
    (m) => m.status !== 'CANCELLED' && inKeys.has(index.keyOf(m)),
  ).length;

  return {
    size: entry.partySize,
    admitted,
    remaining: Math.max(entry.partySize - admitted, 0),
  };
}

function red(outcome: 'NOT_FOUND', canAdmitAnyway: boolean): ScanResult {
  return { outcome, tone: TONES[outcome], canAdmitAnyway };
}

/**
 * What the server saw, folded back into a result the door has already shown.
 *
 * The local decision is never delayed for this (§12.3) — the flash, the tone
 * and the buzz have all happened by the time a POST comes back. Two things the
 * phone cannot know, though, are worth showing once they arrive:
 *
 * - **Wrong show.** The device holds one roster, so a ticket for another show
 *   reads locally as "not found". The server sees every show and can name the
 *   one the ticket is actually for, which is what §12.1's table asks for.
 * - **A duplicate from another device.** Two phones both offline resolve only
 *   on sync (§12.3), and by design the server accepts both rather than locking.
 *   The second usher's screen said green and the guest is already inside; this
 *   turns the record straight without rewriting what they were told.
 *
 * **It never downgrades an admission to a refusal.** The guest has walked past
 * by now, so flipping green to red under the usher's thumb would only cost the
 * queue confidence in the device. `ADMITTED` stays `ADMITTED`; what changes is
 * the detail the operator can read afterwards.
 */
export function applyServerOutcome(
  local: ScanResult,
  server: { outcome: ScanOutcome; showName?: string | null; firstScan?: ScanResult['firstScan'] },
): ScanResult {
  if (server.outcome === 'WRONG_SHOW' && local.outcome === 'NOT_FOUND') {
    return { ...local, outcome: 'WRONG_SHOW', tone: TONES.WRONG_SHOW, wrongShowName: server.showName ?? null };
  }

  if (server.outcome === 'ALREADY_CHECKED_IN' && local.outcome === 'ADMITTED') {
    return { ...local, alsoScanned: server.firstScan ?? null };
  }

  return local;
}
