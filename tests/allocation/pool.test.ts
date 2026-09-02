import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createPlayers,
  createRegistration,
  createSegment,
  createShow,
  seedAttendees,
} from '../helpers/fixtures';

/**
 * spec/allocation.md §7.3 — the worked example, as the primary test case.
 *
 * "A player segment of 120 seats with 30 active players at a base quota of 3":
 *
 *   | Moment                          | confirmed | unclaimed_base | open | pool |
 *   | Registration opens              |         0 |             90 |  120 |   30 |
 *   | 50 base seats claimed           |        50 |             40 |   70 |   30 |
 *   | Deadline passes, 72 base claimed|        72 |   18 (released)|   48 |   48 |
 *
 * The numbers are illustrative and belong to the spec, not to this concert
 * (spec/context.md holds those) — they are written here because §7.3 names them
 * as the case the engine must satisfy.
 */

const SEGMENT_CAPACITY = 120;
const PLAYER_COUNT = 30;
const BASE_QUOTA = 3;

type Pool = {
  sellable: number;
  confirmed: number;
  unclaimed_base: number;
  open_seats: number;
  extras_pool: number;
  over: number;
};

async function pool(segmentId: number): Promise<Pool> {
  const [row] = await sql<{ segment_pool: Pool }[]>`select segment_pool(${segmentId}::bigint)`;
  return row.segment_pool;
}

/**
 * Claims `total` base seats spread across players without any player exceeding
 * the quota — which is what makes `Σ max(0, quota − claimed)` equal
 * `(players × quota) − total`. A distribution that overshot one player's quota
 * would make the row's arithmetic mean something different.
 */
async function claimBaseSeats(
  showId: number,
  segmentId: number,
  playerIds: number[],
  total: number,
): Promise<void> {
  let remaining = total;
  for (const playerId of playerIds) {
    if (remaining === 0) break;
    const take = Math.min(BASE_QUOTA, remaining);
    const registrationId = await createRegistration({ showId, segmentId, playerId });
    await seedAttendees({
      registrationId,
      showId,
      segmentId,
      count: take,
      allocationType: 'BASE',
    });
    remaining -= take;
  }
  expect(remaining, 'fixture could not place every base seat').toBe(0);
}

describe('segment_pool() — spec/allocation.md §7.3', () => {
  let concertId: number;
  let showId: number;
  let segmentId: number;
  let playerIds: number[];

  beforeEach(async () => {
    await resetDb();
    concertId = await createConcert();
    showId = await createShow(concertId, SEGMENT_CAPACITY);
    segmentId = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: SEGMENT_CAPACITY,
      baseQuota: BASE_QUOTA,
      // Deadline in the future: rows 1 and 2 are both "before the deadline".
      baseClaimDeadline: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      extrasPolicy: 'REVIEW',
    });
    playerIds = await createPlayers(concertId, PLAYER_COUNT);
  });

  it('row 1 — registration opens: pool is capacity minus what players are collectively owed', async () => {
    expect(await pool(segmentId)).toMatchObject({
      sellable: 120,
      confirmed: 0,
      unclaimed_base: 90,
      open_seats: 120,
      extras_pool: 30,
    });
  });

  it('row 2 — 50 base seats claimed: claiming base does not grow the extras pool', async () => {
    await claimBaseSeats(showId, segmentId, playerIds, 50);

    expect(await pool(segmentId)).toMatchObject({
      sellable: 120,
      confirmed: 50,
      unclaimed_base: 40,
      open_seats: 70,
      // Unchanged from row 1. A claimed base seat converts a promise into a
      // booking; it does not release a seat to anybody else.
      extras_pool: 30,
    });
  });

  it('row 3 — deadline passes with 72 claimed: the unclaimed remainder releases', async () => {
    await claimBaseSeats(showId, segmentId, playerIds, 72);
    await sql`
      update show_segments set base_claim_deadline = now() - interval '1 hour'
       where id = ${segmentId}
    `;

    expect(await pool(segmentId)).toMatchObject({
      sellable: 120,
      confirmed: 72,
      // Still reported — the extras review header shows what was released
      // (spec/allocation.md §7.5) — but no longer subtracted.
      unclaimed_base: 18,
      open_seats: 48,
      extras_pool: 48,
    });
  });

  it('before the deadline, extras can never consume a seat a player is still owed', async () => {
    // The degenerate case §7.3 calls out: quota × players exactly equals
    // capacity, so the pool is zero until the deadline. Correct, not a bug —
    // extras are precisely the seats players did not take.
    //
    // Its own show, because `(show_id, audience_mode)` allows only one
    // PLAYER_INVITED segment per show.
    const otherShow = await createShow(concertId, PLAYER_COUNT * BASE_QUOTA);
    const exact = await createSegment(otherShow, {
      audienceMode: 'PLAYER_INVITED',
      name: 'Exactly subscribed',
      capacity: PLAYER_COUNT * BASE_QUOTA,
      baseQuota: BASE_QUOTA,
      baseClaimDeadline: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    });
    // Players are concert-scoped, so the same 30 players are owed seats here.
    expect(await pool(exact)).toMatchObject({
      sellable: 90,
      unclaimed_base: 90,
      open_seats: 90,
      extras_pool: 0,
    });
  });
});

describe('segment_pool() — the max(0, …) floor, spec/allocation.md §7.2', () => {
  it('reads zero and reports the overage when an override pushed confirmed past capacity', async () => {
    await resetDb();
    const concertId = await createConcert();
    const showId = await createShow(concertId, 10);
    const segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 10 });

    const registrationId = await createRegistration({ showId, segmentId });
    await seedAttendees({
      registrationId,
      showId,
      segmentId,
      count: 13,
      allocationType: 'EXTRA',
    });

    const p = await pool(segmentId);

    // "the pool must read zero and the screen must say 'full, N over', never a
    // negative number that some later arithmetic treats as capacity."
    expect(p.extras_pool).toBe(0);
    expect(p.extras_pool).not.toBeLessThan(0);
    expect(p.over).toBe(3);
    // open_seats is the honest signed figure; only the pool is floored.
    expect(p.open_seats).toBe(-3);
  });
});

describe('segment_pool() — a PUBLIC segment has no players, spec/allocation.md §7.2', () => {
  it('carries no unclaimed base, so the pool is simply the open seats', async () => {
    await resetDb();
    const concertId = await createConcert();
    const showId = await createShow(concertId, 300);
    const segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 300 });
    // Active players exist on the concert, but a PUBLIC segment owes them nothing.
    await createPlayers(concertId, 30);

    const registrationId = await createRegistration({ showId, segmentId });
    await seedAttendees({
      registrationId,
      showId,
      segmentId,
      count: 20,
      allocationType: 'EXTRA',
    });

    expect(await pool(segmentId)).toMatchObject({
      confirmed: 20,
      unclaimed_base: 0,
      open_seats: 280,
      extras_pool: 280,
    });
  });
});
