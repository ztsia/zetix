import { beforeEach, describe, expect, it } from 'vitest';
import { newConnection, resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createPlayers,
  createRegistration,
  createSegment,
  createShow,
  seedAttendees,
} from '../helpers/fixtures';

/**
 * `promote_seats()` — confirming seats that already exist
 * (spec/allocation.md §7.5 commit, §7.9 restore).
 *
 * The property under test is the same one `claim_seats()` exists for: **the
 * ceilings hold**. A review commit that confirmed more than the segment or the
 * hall can seat would oversell exactly as an unguarded insert would, and the
 * promotion trigger in 0001 hands this function the responsibility explicitly.
 */

/** Blocked, rather than merely slow: a statement timeout is how a lock wait is observed. */
const BLOCKED = /canceling statement due to statement timeout/;

/** A promise plus the function that resolves it, for ordering two connections. */
function latch() {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { gate, open };
}

type PromoteResult = {
  confirmed: number;
  skipped: number;
  refused: boolean;
  reason: string | null;
};

async function promote(
  segmentId: number,
  attendeeIds: number[],
  override = false,
): Promise<PromoteResult> {
  const [row] = await sql<{ promote_seats: PromoteResult }[]>`
    select promote_seats(
      ${segmentId}::bigint, ${attendeeIds}::bigint[], ${override}::boolean)
  `;
  return row.promote_seats;
}

async function pendingIds(registrationId: number): Promise<number[]> {
  const rows = await sql<{ id: string }[]>`
    select id from attendees
     where registration_id = ${registrationId} and status = 'PENDING_REVIEW'
     order by id
  `;
  return rows.map((r) => Number(r.id));
}

async function statusCounts(segmentId: number): Promise<Record<string, number>> {
  const rows = await sql<{ status: string; n: number }[]>`
    select status, count(*)::int as n from attendees
     where segment_id = ${segmentId} group by status
  `;
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

describe('promote_seats', () => {
  beforeEach(resetDb);

  /** A public segment of `capacity` in a hall of `hall`, with one pending party. */
  async function arrange(opts: {
    hall: number;
    capacity: number;
    pending: number;
    confirmed?: number;
  }) {
    const concertId = await createConcert();
    const showId = await createShow(concertId, opts.hall);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: opts.capacity,
      extrasPolicy: 'REVIEW',
    });

    if (opts.confirmed) {
      const sitting = await createRegistration({ showId, segmentId });
      await seedAttendees({
        registrationId: sitting,
        showId,
        segmentId,
        count: opts.confirmed,
        allocationType: 'EXTRA',
        status: 'CONFIRMED',
      });
    }

    const registrationId = await createRegistration({
      showId,
      segmentId,
      status: 'PENDING_REVIEW',
    });
    await seedAttendees({
      registrationId,
      showId,
      segmentId,
      count: opts.pending,
      allocationType: 'EXTRA',
      status: 'PENDING_REVIEW',
    });

    return { concertId, showId, segmentId, registrationId };
  }

  it('confirms the named rows when the segment has room', async () => {
    const { segmentId, registrationId } = await arrange({
      hall: 10,
      capacity: 10,
      pending: 3,
    });
    const ids = await pendingIds(registrationId);

    const result = await promote(segmentId, ids);

    expect(result).toMatchObject({ confirmed: 3, skipped: 0, refused: false });
    expect(await statusCounts(segmentId)).toEqual({ CONFIRMED: 3 });
  });

  it('refuses the whole selection when it would exceed the segment', async () => {
    const { segmentId, registrationId } = await arrange({
      hall: 10,
      capacity: 4,
      pending: 3,
      confirmed: 2,
    });
    const ids = await pendingIds(registrationId);

    const result = await promote(segmentId, ids);

    expect(result.refused).toBe(true);
    expect(result.confirmed).toBe(0);
    // All or nothing: two of the three would have fit, and confirming those
    // would leave the screen's arithmetic and the database disagreeing.
    expect(await statusCounts(segmentId)).toEqual({
      CONFIRMED: 2,
      PENDING_REVIEW: 3,
    });
    expect(result.reason).toMatch(/2 seats free/);
  });

  /**
   * `Σ segment.capacity <= show.capacity` means two segments' legitimate free
   * seats can never jointly exceed the hall — which is exactly why that
   * invariant exists. The hall ceiling therefore only bites once an **override**
   * has already overfilled a neighbouring segment (§7.6), and that is the state
   * arranged here: the player segment holds two seats in a slice sized for one.
   */
  it('refuses when the segment fits but the hall does not', async () => {
    const concertId = await createConcert();
    const showId = await createShow(concertId, 4);
    const publicSegment = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 3,
      extrasPolicy: 'REVIEW',
      name: 'Public',
    });
    const playerSegment = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 1,
      baseQuota: 1,
      extrasPolicy: 'REVIEW',
      name: 'Player invited',
    });
    await createPlayers(concertId, 1);

    const playerReg = await createRegistration({
      showId,
      segmentId: playerSegment,
      status: 'CONFIRMED',
    });
    await seedAttendees({
      registrationId: playerReg,
      showId,
      segmentId: playerSegment,
      count: 2,
      allocationType: 'BASE',
      status: 'CONFIRMED',
    });

    const registrationId = await createRegistration({
      showId,
      segmentId: publicSegment,
      status: 'PENDING_REVIEW',
    });
    await seedAttendees({
      registrationId,
      showId,
      segmentId: publicSegment,
      count: 3,
      allocationType: 'EXTRA',
      status: 'PENDING_REVIEW',
    });

    // The public segment has all 3 of its own seats free; the hall has 2.
    const result = await promote(publicSegment, await pendingIds(registrationId));

    expect(result.refused).toBe(true);
    expect(result.confirmed).toBe(0);
    expect(result.reason).toMatch(/hall has 2/);
  });

  it('confirms past the ceiling when the override is taken', async () => {
    const { segmentId, registrationId } = await arrange({
      hall: 10,
      capacity: 4,
      pending: 3,
      confirmed: 2,
    });
    const ids = await pendingIds(registrationId);

    const result = await promote(segmentId, ids, true);

    expect(result).toMatchObject({ confirmed: 3, refused: false });
    expect(await statusCounts(segmentId)).toEqual({ CONFIRMED: 5 });
  });

  /**
   * §7.5 sizes the *preselection* from the extras pool, not the commit. Before
   * the base claim deadline the pool sits below `open_seats` by the unclaimed
   * base remainder, and an admin granting an extra into one of those seats is
   * doing something §7.4 allows — so the pool must not refuse it.
   */
  it('allows a commit past the extras pool while inside the segment capacity', async () => {
    const concertId = await createConcert();
    const showId = await createShow(concertId, 10);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 10,
      baseQuota: 1,
      baseClaimDeadline: new Date(Date.now() + 86_400_000),
      extrasPolicy: 'REVIEW',
    });
    // Ten active players, each owed one seat and none claimed: the pool is
    // zero, but the segment has ten free seats.
    await createPlayers(concertId, 10);

    const [pool] = await sql<{ segment_pool: { extras_pool: number } }[]>`
      select segment_pool(${segmentId}::bigint)
    `;
    expect(pool.segment_pool.extras_pool).toBe(0);

    const registrationId = await createRegistration({
      showId,
      segmentId,
      status: 'PENDING_REVIEW',
    });
    await seedAttendees({
      registrationId,
      showId,
      segmentId,
      count: 2,
      allocationType: 'EXTRA',
      status: 'PENDING_REVIEW',
    });

    const result = await promote(segmentId, await pendingIds(registrationId));

    expect(result).toMatchObject({ confirmed: 2, refused: false });
  });

  it('ignores ids from another segment', async () => {
    const { segmentId } = await arrange({ hall: 10, capacity: 10, pending: 1 });
    const otherConcert = await createConcert('Other');
    const otherShow = await createShow(otherConcert, 10);
    const otherSegment = await createSegment(otherShow, {
      audienceMode: 'PUBLIC',
      capacity: 10,
      extrasPolicy: 'REVIEW',
    });
    const otherReg = await createRegistration({
      showId: otherShow,
      segmentId: otherSegment,
      status: 'PENDING_REVIEW',
    });
    await seedAttendees({
      registrationId: otherReg,
      showId: otherShow,
      segmentId: otherSegment,
      count: 1,
      allocationType: 'EXTRA',
      status: 'PENDING_REVIEW',
    });

    const foreign = await pendingIds(otherReg);
    const result = await promote(segmentId, foreign);

    expect(result).toMatchObject({ confirmed: 0, skipped: 1 });
    expect(await statusCounts(otherSegment)).toEqual({ PENDING_REVIEW: 1 });
  });

  it('skips a row whose registration has been cancelled', async () => {
    const { segmentId, registrationId } = await arrange({
      hall: 10,
      capacity: 10,
      pending: 2,
    });
    const ids = await pendingIds(registrationId);
    await sql`update registrations set status = 'CANCELLED' where id = ${registrationId}`;

    const result = await promote(segmentId, ids);

    expect(result).toMatchObject({ confirmed: 0, skipped: 2, refused: false });
  });

  it('counts an already-confirmed row as skipped rather than promoting it twice', async () => {
    const { segmentId, registrationId } = await arrange({
      hall: 10,
      capacity: 10,
      pending: 2,
    });
    const ids = await pendingIds(registrationId);
    await promote(segmentId, ids);

    const again = await promote(segmentId, ids);

    expect(again).toMatchObject({ confirmed: 0, skipped: 2, refused: false });
  });

  it('treats a duplicated id as one seat', async () => {
    const { segmentId, registrationId } = await arrange({
      hall: 10,
      capacity: 10,
      pending: 1,
    });
    const [id] = await pendingIds(registrationId);

    const result = await promote(segmentId, [id, id]);

    expect(result).toMatchObject({ confirmed: 1, skipped: 0 });
  });

  it('accepts an empty selection without touching anything', async () => {
    const { segmentId } = await arrange({ hall: 10, capacity: 10, pending: 1 });
    expect(await promote(segmentId, [])).toMatchObject({
      confirmed: 0,
      refused: false,
    });
    expect(await statusCounts(segmentId)).toEqual({ PENDING_REVIEW: 1 });
  });

  /**
   * The same refusal `claim_seats()` makes. A caller whose snapshot predates
   * the row lock recomputes the ceilings from stale counts and overfills with
   * no error at all, so this must fail loudly rather than trust the caller.
   */
  it('refuses to run outside READ COMMITTED', async () => {
    const { segmentId, registrationId } = await arrange({
      hall: 10,
      capacity: 10,
      pending: 1,
    });
    const ids = await pendingIds(registrationId);

    await expect(
      sql.begin(async (tx) => {
        await tx`set transaction isolation level repeatable read`;
        return tx`select promote_seats(${segmentId}::bigint, ${ids}::bigint[], false)`;
      }),
    ).rejects.toThrow(/READ COMMITTED/);
  });

  /**
   * The lock, observed the only way a lock can be: by contention.
   *
   * A sequential pair of commits passes identically whether the lock is there
   * or not — both read the room after the other has committed. The property
   * §7.8 is actually buying is that a commit **in flight** blocks the next one,
   * so the second recomputes the ceilings from counts that include the first.
   * Without it both read the same free seats, both confirm, and the segment is
   * oversold with no error anywhere.
   *
   * Same shape as `tests/allocation/show-lock.test.ts`: hold one commit open
   * mid-transaction and prove the contender blocks rather than proceeding.
   */
  it('blocks a concurrent commit against the same show', async () => {
    const concertId = await createConcert();
    const showId = await createShow(concertId, 10);
    const a = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 5,
      extrasPolicy: 'REVIEW',
      name: 'Public',
    });
    const b = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 5,
      baseQuota: 1,
      extrasPolicy: 'REVIEW',
      name: 'Player invited',
    });

    const regA = await createRegistration({ showId, segmentId: a, status: 'PENDING_REVIEW' });
    await seedAttendees({
      registrationId: regA,
      showId,
      segmentId: a,
      count: 1,
      allocationType: 'EXTRA',
      status: 'PENDING_REVIEW',
    });
    const regB = await createRegistration({ showId, segmentId: b, status: 'PENDING_REVIEW' });
    await seedAttendees({
      registrationId: regB,
      showId,
      segmentId: b,
      count: 1,
      allocationType: 'EXTRA',
      status: 'PENDING_REVIEW',
    });

    const idsA = await pendingIds(regA);
    const idsB = await pendingIds(regB);

    const holder = newConnection();
    const contender = newConnection({ statement_timeout: '700ms' });
    const { gate: releaseGate, open: released } = latch();
    const { gate: lockTaken, open: lockIsHeld } = latch();

    try {
      const held = holder.begin(async (tx) => {
        await tx`select promote_seats(${a}::bigint, ${idsA}::bigint[], false)`;
        lockIsHeld();
        await releaseGate;
      });

      // Wait until the lock is genuinely held, or the contender can win the
      // race and the test reports timing rather than locking.
      await lockTaken;

      await expect(
        contender`select promote_seats(${b}::bigint, ${idsB}::bigint[], false)`,
      ).rejects.toThrow(BLOCKED);

      released();
      await held;
    } finally {
      // Unconditionally, so a failed assertion is a failed assertion rather
      // than a thirty-second hang on the holder's open transaction.
      released();
      await holder.end().catch(() => {});
      await contender.end().catch(() => {});
    }
  });
});
