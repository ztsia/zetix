import { sql } from 'drizzle-orm';
import { getDb } from './client';

/**
 * The typed doorway to the allocation engine (spec/allocation.md §7).
 *
 * The logic is in Postgres and stays there: `claim_seats()` holds a row lock on
 * the **show** across a read-then-write, which is the only reason oversell is
 * impossible (decision 15, §7.8). This module exists so Server Actions and
 * Route Handlers call it with types rather than hand-written SQL — not to
 * reimplement any part of it.
 *
 * **Every grant routes through `claimSeats`**, including manual and
 * admin-created registrations (§7.6). A path that inserts an `attendees` row
 * directly is a bug: the counters stop meaning anything.
 */

export type AllocationType = 'BASE' | 'EXTRA' | 'HELD' | 'COMP';

/** One seat wanted. A registration is a party of N of these (decision 31). */
export type SeatRequest = {
  fullName?: string | null;
  email?: string | null;
  allocationType: AllocationType;
};

export type ClaimOutcome = {
  granted_base: number;
  granted_extra: number;
  /**
   * HELD and COMP seats granted. Separate from `granted_extra` because they do
   * not come out of the extras pool — §7.8 names four keys and cannot describe
   * them, but writing rows the caller is never told about is worse.
   */
  granted_other: number;
  pending: number;
  waitlisted: number;
};

export type SegmentPool = {
  /** The segment's slice of the hall. */
  sellable: number;
  confirmed: number;
  /** Σ over active players of max(0, quota − claimed). Reported after the deadline too. */
  unclaimed_base: number;
  /** `sellable − confirmed`. Signed: negative means an override went over. */
  open_seats: number;
  /** Floored at zero — never a negative that later arithmetic treats as capacity. */
  extras_pool: number;
  /** How far past capacity an override pushed it, for the "full, N over" line. */
  over: number;
  /** Whether the claim deadline has passed and the unclaimed remainder released. */
  base_released: boolean;
};

/**
 * Grants, holds or waitlists a party of seats, atomically.
 *
 * `override` is the deliberate admin escape hatch of §7.6 — "only the hall
 * ceiling is overridable, and only deliberately". The caller owns the typed
 * confirmation and the `audit_log` row; this flag only tells the engine the
 * decision was made.
 */
export async function claimSeats(
  segmentId: number,
  registrationId: number,
  requests: readonly SeatRequest[],
  options: { override?: boolean } = {},
): Promise<ClaimOutcome> {
  const payload = requests.map((r) => ({
    full_name: r.fullName ?? null,
    email: r.email ?? null,
    allocation_type: r.allocationType,
  }));

  const rows = await getDb().execute<{ claim_seats: ClaimOutcome }>(sql`
    select claim_seats(
      ${segmentId}::bigint,
      ${registrationId}::bigint,
      ${JSON.stringify(payload)}::jsonb,
      ${options.override ?? false}::boolean
    )
  `);
  return rows[0].claim_seats;
}

/** The live §7.2 figures for one segment — the extras review header reads these (§7.5). */
export async function segmentPool(segmentId: number): Promise<SegmentPool> {
  const rows = await getDb().execute<{ segment_pool: SegmentPool }>(sql`
    select segment_pool(${segmentId}::bigint)
  `);
  return rows[0].segment_pool;
}

/**
 * Whether a segment's base entitlement still fits its capacity (§7.4).
 *
 * The database enforces this on all three mutation routes regardless, so this
 * is not the guard — it is how a form shows the failure *inline*, next to the
 * field, instead of letting the save turn into a 500. Call it before saving;
 * trust the database to be the one that actually refuses.
 */
export async function checkBaseEntitlement(
  segmentId: number,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await getDb().execute(sql`select assert_base_entitlement_fits(${segmentId}::bigint)`);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}
