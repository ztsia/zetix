import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createRegistration,
  createSegment,
  createShow,
  seedAttendees,
} from '../helpers/fixtures';

/**
 * Configuration invariants — spec/domain.md §5.1 and spec/allocation.md §7.7.
 *
 *   Σ segment.capacity <= show.capacity
 *   segment.capacity   >= that segment's confirmed count
 *
 * Neither of these is the §7.6 override. That one lets an admin *seat* more
 * people than the hall holds, deliberately, and `claim_seats()` still enforces
 * the hall at grant time. These are the different question of whether the
 * numbers an admin typed describe a possible evening — because `segment_pool()`
 * sizes the extras pool from `segment.capacity`, and §7.5 draws the FCFS
 * preselection line from that pool.
 */

describe('segments must fit the hall — spec/domain.md §5.1', () => {
  let concertId: number;
  let showId: number;

  beforeEach(async () => {
    await resetDb();
    concertId = await createConcert();
    showId = await createShow(concertId, 400);
  });

  it('refuses a second segment that would overflow the hall', async () => {
    await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 300 });

    await expect(
      createSegment(showId, { audienceMode: 'PLAYER_INVITED', capacity: 150 }),
    ).rejects.toThrow(/total 450 seats, but the hall holds 400/);
  });

  it('refuses raising one segment past what the hall has spare', async () => {
    const publicSegment = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 300,
    });
    await createSegment(showId, { audienceMode: 'PLAYER_INVITED', capacity: 80 });

    await expect(
      sql`update show_segments set capacity = 350 where id = ${publicSegment}::bigint`,
    ).rejects.toThrow(/total 430 seats, but the hall holds 400/);
  });

  it('refuses lowering the hall below what its segments already claim', async () => {
    await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 300 });
    await createSegment(showId, { audienceMode: 'PLAYER_INVITED', capacity: 80 });

    await expect(
      sql`update shows set capacity = 300 where id = ${showId}::bigint`,
    ).rejects.toThrow(/total 380 seats, but the hall holds 300/);
  });

  it('allows §7.7 to move capacity between two segments in one transaction', async () => {
    // The spec's own worked example: "an admin edits both capacities (player 80,
    // public 320)". The intermediate state after the first UPDATE overflows the
    // hall, which is why the guard is deferred to commit and judges the result
    // rather than the keystrokes.
    const playerSegment = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 100,
    });
    const publicSegment = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 300,
    });

    await sql.begin(async (tx) => {
      await tx`update show_segments set capacity = 320 where id = ${publicSegment}::bigint`;
      await tx`update show_segments set capacity = 80 where id = ${playerSegment}::bigint`;
    });

    const [row] = await sql<{ total: number }[]>`
      select sum(capacity)::int as total from show_segments where show_id = ${showId}::bigint
    `;
    expect(row.total).toBe(400);
  });

  it('still refuses when the whole transaction leaves the hall overflowing', async () => {
    const playerSegment = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 100,
    });
    const publicSegment = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 300,
    });

    await expect(
      sql.begin(async (tx) => {
        await tx`update show_segments set capacity = 350 where id = ${publicSegment}::bigint`;
        await tx`update show_segments set capacity = 90 where id = ${playerSegment}::bigint`;
      }),
    ).rejects.toThrow(/total 440 seats, but the hall holds 400/);
  });

  it('leaves held seats alone — segments totalling less than the hall is the point', async () => {
    // "If the hall is 400 and the segments total 390, ten seats are held"
    // (decision 21). Under-allocation is not an error; it is the feature.
    await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 300 });
    await createSegment(showId, { audienceMode: 'PLAYER_INVITED', capacity: 90 });

    const [row] = await sql<{ total: number }[]>`
      select sum(capacity)::int as total from show_segments where show_id = ${showId}::bigint
    `;
    expect(row.total).toBe(390);
  });
});

describe('a segment cannot shed seats people already hold — spec/allocation.md §7.7', () => {
  let showId: number;
  let segmentId: number;

  beforeEach(async () => {
    await resetDb();
    const concertId = await createConcert();
    showId = await createShow(concertId, 400);
    segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 100 });

    const registrationId = await createRegistration({ showId, segmentId });
    await seedAttendees({
      registrationId,
      showId,
      segmentId,
      count: 40,
      allocationType: 'EXTRA',
    });
  });

  it('refuses to drop capacity below the confirmed count', async () => {
    await expect(
      sql`update show_segments set capacity = 30 where id = ${segmentId}::bigint`,
    ).rejects.toThrow(/already has 40 confirmed seats, so its capacity cannot drop to 30/);
  });

  it('allows dropping capacity to exactly the confirmed count', async () => {
    await sql`update show_segments set capacity = 40 where id = ${segmentId}::bigint`;
    const [row] = await sql<{ capacity: number }[]>`
      select capacity from show_segments where id = ${segmentId}::bigint
    `;
    expect(row.capacity).toBe(40);
  });

  it('counts cancelled registrations as freed, so their seats can be given back', async () => {
    // §7.9: cancelling "returns seats to that segment immediately".
    await sql`
      update registrations set status = 'CANCELLED' where segment_id = ${segmentId}::bigint
    `;
    await sql`update show_segments set capacity = 5 where id = ${segmentId}::bigint`;

    const [row] = await sql<{ capacity: number }[]>`
      select capacity from show_segments where id = ${segmentId}::bigint
    `;
    expect(row.capacity).toBe(5);
  });
});
