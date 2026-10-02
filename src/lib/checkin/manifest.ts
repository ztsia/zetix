/**
 * The offline manifest — the attendee roster, on the usher's phone
 * (spec/checkin.md §12.3, spec/v3.md §32.2).
 *
 * The columns are fixed by `manifest_for_show()` in
 * `drizzle/0205_walk_ins_and_door_state.sql` and held there by
 * `tests/auth/manifest-rpc.test.ts`. This module is the browser's view of that
 * contract: the shape, the index the door reads at speed, and the hash that
 * joins a scanned token to a row.
 *
 * **No raw `qr_token` is ever in here.** The function hashes server-side, so
 * what lands in IndexedDB on a phone that can be lost, lent or stolen is a set
 * of digests — useless as a ticket. The scanner hashes what it scans and
 * compares, which is why admission still needs no network.
 *
 * **Every row is keyed by its attendee, never by its token** (§32.2). A seat
 * that is confirmed but not yet ticketed has no token and so no digest; keying
 * on the digest made every such seat collide on `null`, vanish from search, and
 * poison the sync queue with rows the server could not accept.
 */

/** `booking_status` (spec/domain.md §5.1). Cancelled rows are in the manifest on purpose. */
export type ManifestStatus = 'CONFIRMED' | 'PENDING_REVIEW' | 'WAITLIST' | 'CANCELLED';

/** One attendee, as `/api/checkin/manifest` returns them. */
export type ManifestEntry = {
  /**
   * The attendee's id: the door's key for a seat. Null only in a manifest a
   * phone saved before 0205, which never carried it — see {@link entryKey}.
   */
  attendeeId: number | null;
  /** `encode(sha256(convert_to(qr_token, 'UTF8')), 'hex')`; null with no ticket. */
  qrTokenSha256: string | null;
  hasTicket: boolean;
  ticketCode: string | null;
  name: string;
  /** `PLACEHOLDER` for a seat the booker did not name ("Guest of …"). */
  nameSource: 'PROVIDED' | 'PLACEHOLDER';
  playerName: string | null;
  status: ManifestStatus;
  registrationId: number;
  /** Seats in this party, cancelled ones excluded — it drives "Admit remaining". */
  partySize: number;
  segmentName: string | null;
  /** The first live check-in on the server, from any phone, as of the download. */
  checkedInAt: string | null;
  checkedInBy: string | null;
};

/**
 * A stable key for one roster row.
 *
 * The attendee id when there is one, which is always, from 0205 on. A manifest
 * saved by an older build has no id, and is keyed by digest until the next
 * refresh replaces it; a row of that vintage with no digest either is keyed by
 * its position, which is unique within that manifest and is all it needs to be.
 */
export function entryKey(entry: Pick<ManifestEntry, 'attendeeId' | 'qrTokenSha256'>, position = 0): string {
  if (entry.attendeeId != null) return `a${entry.attendeeId}`;
  if (entry.qrTokenSha256) return `h${entry.qrTokenSha256}`;
  return `p${position}`;
}

/**
 * A manifest as stored, made safe to read whatever build saved it.
 *
 * A phone that held a roster before 0205 still has it in IndexedDB, and the
 * door must come up on it with no network. The fields it lacks are filled with
 * the answer that changes nothing: no server check-in state, a provided name.
 */
export function normaliseEntries(raw: readonly Partial<ManifestEntry>[]): ManifestEntry[] {
  return raw.map((e) => ({
    attendeeId: e.attendeeId ?? null,
    qrTokenSha256: e.qrTokenSha256 ?? null,
    hasTicket: e.hasTicket ?? Boolean(e.qrTokenSha256),
    ticketCode: e.ticketCode ?? null,
    name: e.name ?? '',
    nameSource: e.nameSource ?? 'PROVIDED',
    playerName: e.playerName ?? null,
    status: e.status ?? 'CONFIRMED',
    registrationId: e.registrationId ?? 0,
    partySize: e.partySize ?? 1,
    segmentName: e.segmentName ?? null,
    checkedInAt: e.checkedInAt ?? null,
    checkedInBy: e.checkedInBy ?? null,
  }));
}

/**
 * The manifest as the door reads it.
 *
 * Built once when the manifest lands and kept in memory. A few hundred rows is
 * small enough that a linear scan would also work, but every scan does a lookup
 * while a queue moves, and `Map` makes the cost of that flat and obviously so.
 */
export type ManifestIndex = {
  entries: readonly ManifestEntry[];
  /** By token digest — the scan path. Seats with no ticket are not in it. */
  byHash: ReadonlyMap<string, ManifestEntry>;
  /** By {@link entryKey} — every seat, ticketed or not. */
  byKey: ReadonlyMap<string, ManifestEntry>;
  /** The key of each entry, by identity, so callers never recompute it. */
  keyOf: (entry: ManifestEntry) => string;
  /** By registration — the party path, for "Party of 4 · 1 in, 3 remaining". */
  byRegistration: ReadonlyMap<number, readonly ManifestEntry[]>;
};

export function buildManifestIndex(entries: readonly ManifestEntry[]): ManifestIndex {
  const byHash = new Map<string, ManifestEntry>();
  const byKey = new Map<string, ManifestEntry>();
  const keys = new Map<ManifestEntry, string>();
  const byRegistration = new Map<number, ManifestEntry[]>();

  entries.forEach((entry, position) => {
    if (entry.qrTokenSha256) byHash.set(entry.qrTokenSha256, entry);
    const key = entryKey(entry, position);
    byKey.set(key, entry);
    keys.set(entry, key);
    const party = byRegistration.get(entry.registrationId);
    if (party) party.push(entry);
    else byRegistration.set(entry.registrationId, [entry]);
  });

  return {
    entries,
    byHash,
    byKey,
    keyOf: (entry) => keys.get(entry) ?? entryKey(entry),
    byRegistration,
  };
}

/**
 * SHA-256 of a scanned token, lowercase hex.
 *
 * Must agree byte for byte with the Postgres side —
 * `encode(sha256(convert_to(a.qr_token, 'UTF8')), 'hex')` — or every scan is a
 * miss. `TextEncoder` is UTF-8 by specification and `sha256()` is core
 * Postgres, so both ends are pinned by their own definitions rather than by
 * configuration. `tests/checkin/manifest.test.ts` compares them against known
 * vectors.
 *
 * `crypto.subtle` needs a secure context. §12.1 already requires HTTPS for the
 * camera, so this adds no constraint the scanner did not have.
 */
export async function hashQrToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
