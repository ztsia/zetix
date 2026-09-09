/**
 * The offline manifest — the attendee roster, on the usher's phone
 * (spec/checkin.md §12.3).
 *
 * Seven columns, fixed by `manifest_for_show()` in
 * `drizzle/0003_manifest_rls.sql` and held there by
 * `tests/auth/manifest-rpc.test.ts`. This module is the browser's view of that
 * contract: the shape, the index the door reads at speed, and the hash that
 * joins a scanned token to a row.
 *
 * **No raw `qr_token` is ever in here.** The function hashes server-side, so
 * what lands in IndexedDB on a phone that can be lost, lent or stolen is a set
 * of digests — useless as a ticket. The scanner hashes what it scans and
 * compares, which is why admission still needs no network.
 */

/** `booking_status` (spec/domain.md §5.1). Cancelled rows are in the manifest on purpose. */
export type ManifestStatus = 'CONFIRMED' | 'PENDING_REVIEW' | 'WAITLIST' | 'CANCELLED';

/** One attendee, exactly as `manifest_for_show()` returns them. */
export type ManifestEntry = {
  /** `encode(sha256(convert_to(qr_token, 'UTF8')), 'hex')` — lowercase hex. */
  qrTokenSha256: string;
  ticketCode: string | null;
  name: string;
  playerName: string | null;
  status: ManifestStatus;
  registrationId: number;
  /** Seats in this party, cancelled ones excluded — it drives "Admit remaining". */
  partySize: number;
};

/**
 * The manifest as the door reads it.
 *
 * Built once when the manifest lands and kept in memory. A few hundred rows is
 * small enough that a linear scan would also work, but every scan does a lookup
 * while a queue moves, and `Map` makes the cost of that flat and obviously so.
 */
export type ManifestIndex = {
  entries: readonly ManifestEntry[];
  /** By token digest — the scan path. */
  byHash: ReadonlyMap<string, ManifestEntry>;
  /** By registration — the party path, for "Party of 4 · 1 in, 3 remaining". */
  byRegistration: ReadonlyMap<number, readonly ManifestEntry[]>;
};

export function buildManifestIndex(entries: readonly ManifestEntry[]): ManifestIndex {
  const byHash = new Map<string, ManifestEntry>();
  const byRegistration = new Map<number, ManifestEntry[]>();

  for (const entry of entries) {
    byHash.set(entry.qrTokenSha256, entry);
    const party = byRegistration.get(entry.registrationId);
    if (party) party.push(entry);
    else byRegistration.set(entry.registrationId, [entry]);
  }

  return { entries, byHash, byRegistration };
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
