import { sql } from 'drizzle-orm';
import { getDb } from './client';
import { dbErrorMessage, rethrowDbError } from './errors';

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
 * directly is a bug: the counters stop meaning anything — and the database
 * refuses it outright, so such a path fails loudly rather than quietly.
 *
 * **Callers must be at `READ COMMITTED`**, which is the default. Inside a
 * `REPEATABLE READ` transaction the snapshot predates the row lock, so the
 * engine would recompute the pool from stale counts and oversell with no error;
 * `claim_seats()` refuses rather than allowing that. Do not wrap these calls in
 * a transaction that raises the isolation level.
 */

/**
 * Anything that can run a statement: the pooled client, or a transaction.
 *
 * `claimSeats` defaults to the pooled client, which is right for a single grant.
 * A caller that must commit several grants **as one unit** — the import commit
 * (spec/import.md §9.1) and the extras review commit (§7.5) both do — passes its
 * transaction instead. Without this the call would run on a different connection
 * from the transaction that is supposed to contain it, and with `max: 1` it
 * simply deadlocks against the connection that transaction is holding.
 *
 * Isolation still matters: the transaction must be `READ COMMITTED`, per the
 * note above. Passing one does not change that requirement, it only decides
 * which connection the call lands on.
 */
export type Executor = Pick<ReturnType<typeof getDb>, 'execute'>;

export type AllocationType = 'BASE' | 'EXTRA' | 'HELD' | 'COMP';

/** One seat wanted. A registration is a party of N of these (decision 31). */
export type SeatRequest = {
  fullName?: string | null;
  email?: string | null;
  allocationType: AllocationType;
  /**
   * When this seat was asked for (spec/v3.md §21.3). Omitted, the seat takes
   * its party's `requested_at`. Pass it for a seat added to a party that
   * already exists — a merged submission, an import adding to a party — so the
   * late seat queues behind everything asked for before it.
   */
  requestedAt?: Date | null;
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
  /**
   * Σ over active players of max(0, quota − claimed).
   *
   * Still reported after the deadline, matching the §7.3 table, which shows
   * "18 (released)" in this column once the deadline has passed. It is no
   * longer *subtracted* — `extras_pool` equals `open_seats` then, and
   * `base_released` says so — but the review header wants to show what was
   * released. Read `extras_pool` for what is available; read this only to
   * explain it.
   */
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
/**
 * Take the hall lock **before** inserting anything that references the show.
 *
 * `claim_seats()` locks the show row `for update` to serialise claims per hall
 * (`allocation.md` §7.8). A caller that inserts its `registrations` row first
 * defeats that and deadlocks instead: the insert's foreign key takes
 * `FOR KEY SHARE` on the same `shows` tuple, two concurrent submits both get
 * that shared lock, and then both ask to upgrade to `FOR UPDATE` — which
 * neither can have while the other holds the share. Postgres breaks the tie
 * with `40P01` and one registrant sees a failure for no reason of their own.
 *
 * Acquiring the exclusive lock up front makes the two transactions queue rather
 * than collide, which is what §7.8 asks for in the first place: *"serialise per
 * hall"*. It costs nothing — `claim_seats()` re-taking a lock this transaction
 * already holds is free — and contention at this scale is irrelevant while
 * correctness is not.
 *
 * **Call it as the first statement in any transaction that inserts a
 * registration and then claims seats.** Found by a QA pass driving two
 * connections at once; a single-connection test pool (`max: 1`) serialises the
 * callers and can never reach it.
 */
export async function lockShowForClaim(showId: number, executor: Executor): Promise<void> {
  await executor.execute(sql`select 1 from shows where id = ${showId}::bigint for update`);
}

export async function claimSeats(
  segmentId: number,
  registrationId: number,
  requests: readonly SeatRequest[],
  options: { override?: boolean; executor?: Executor } = {},
): Promise<ClaimOutcome> {
  const payload = requests.map((r) => ({
    full_name: r.fullName ?? null,
    email: r.email ?? null,
    allocation_type: r.allocationType,
    ...(r.requestedAt ? { requested_at: r.requestedAt.toISOString() } : {}),
  }));

  try {
    const rows = await (options.executor ?? getDb()).execute<{ claim_seats: ClaimOutcome }>(sql`
      select claim_seats(
        ${segmentId}::bigint,
        ${registrationId}::bigint,
        ${JSON.stringify(payload)}::text::jsonb,
        ${options.override ?? false}::boolean
      )
    `);
    return rows[0].claim_seats;
  } catch (error) {
    // The engine's refusals are written for a person to read; do not let
    // Drizzle's "Failed query: …" wrapper be what reaches the screen.
    rethrowDbError(error);
  }
}

/**
 * What `promote_seats()` did, or why it did nothing.
 *
 * `refused` is not an error: the engine confirms every named seat or none of
 * them, and a refusal carries the sentence explaining which ceiling was in the
 * way. The caller renders `reason` and either reduces the selection or takes
 * the override.
 */
export type PromoteOutcome = {
  confirmed: number;
  /** Ids that named nothing promotable — another segment, already confirmed, cancelled. */
  skipped: number;
  refused: boolean;
  reason: string | null;
  /**
   * Seats the override was actually needed for, and so flagged
   * `attendees.over_capacity_at` (spec/v3.md §23.5, `0200`).
   */
  over_capacity?: number;
};

/**
 * Confirms seats that **already exist** (§7.5's review commit, §7.9's restore).
 *
 * The counterpart to {@link claimSeats}, and part of the same engine: that one
 * decides seats which do not exist yet and inserts them, this one moves rows
 * already on the table — `PENDING_REVIEW` granted by an admin, or `CANCELLED`
 * returned by a restore. Neither flow can go back through `claim_seats()`,
 * because inserting again would mint a second `qr_token` for a seat that
 * already has one and a guest holding a printed ticket must still get through
 * the door (decision 28).
 *
 * It is a Postgres function for the reason `claim_seats()` is: it holds the
 * **show** row lock across a read-then-write, and the ceilings are checked
 * where no route can go around them. `attendees_promotion_guard` in
 * `drizzle/0001_allocation_engine.sql` refuses this transition to anything that
 * has not deliberately taken responsibility for those checks, and this is what
 * takes it.
 *
 * `override` is the same §7.6 escape hatch as on {@link claimSeats}: the caller
 * owns the typed confirmation and the `audit_log` row.
 *
 * Pass `executor` whenever the promotion belongs to a wider transaction — the
 * review commit is one unit with the WAITLIST writes beside it — for the same
 * `max: 1` reason documented on {@link Executor}.
 */
export async function promoteSeats(
  segmentId: number,
  attendeeIds: readonly number[],
  options: { override?: boolean; executor?: Executor } = {},
): Promise<PromoteOutcome> {
  // Built as an array literal, so every id is coerced to a finite integer on the
  // way in. These arrive from a request body, and the engine's own guard is
  // that it re-derives every row from the ids under the lock — this is the
  // cheaper half of the same care, one layer earlier.
  const ids = Array.from(new Set(attendeeIds.map(Number)));
  if (ids.some((id) => !Number.isSafeInteger(id))) {
    throw new Error('promoteSeats was given something that is not an attendee id.');
  }

  try {
    const rows = await (options.executor ?? getDb()).execute<{
      promote_seats: PromoteOutcome;
    }>(sql`
      select promote_seats(
        ${segmentId}::bigint,
        ${`{${ids.join(',')}}`}::bigint[],
        ${options.override ?? false}::boolean
      )
    `);
    return rows[0].promote_seats;
  } catch (error) {
    rethrowDbError(error);
  }
}

/**
 * The live §7.2 figures for one segment — the extras review header reads these
 * (§7.5).
 *
 * Pass `executor` to read them **inside** a transaction, which the review commit
 * does when it records what the pool looked like at the moment it committed.
 * Without it the read lands on the pooled client, and with `max: 1` that waits
 * for the connection the transaction is already holding: a request that
 * deadlocks against itself rather than failing.
 */
export async function segmentPool(
  segmentId: number,
  options: { executor?: Executor } = {},
): Promise<SegmentPool> {
  try {
    const rows = await (options.executor ?? getDb()).execute<{
      segment_pool: SegmentPool;
    }>(sql`
      select segment_pool(${segmentId}::bigint)
    `);
    return rows[0].segment_pool;
  } catch (error) {
    rethrowDbError(error);
  }
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
    // The whole point of this function is the sentence the database raised.
    return { ok: false, message: dbErrorMessage(error) };
  }
}
