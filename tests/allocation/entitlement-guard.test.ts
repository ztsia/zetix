import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createPlayers,
  createSegment,
  createShow,
  json,
} from '../helpers/fixtures';

/**
 * The base-entitlement guard — spec/allocation.md §7.4, decision 17.
 *
 * "Base entitlement may not exceed segment capacity", blocked on **all three**
 * mutations that can breach it: editing segment capacity down, editing base
 * quota up, and adding or reactivating a player. Blocking only one leaves the
 * other two as silent routes to an oversubscribed segment — so each is a
 * separate test here, deliberately.
 *
 * There is no opt-out toggle. An organiser who wants to overbook already has
 * two honest levers: lower the quota, or raise capacity.
 */

/** The §7.4 message, with the numbers and the shortfall named. */
const EXPECTED_MESSAGE =
  '82 active players × 2 base = 164 seats, but the segment holds 100. ' +
  'Reduce the quota to 1, raise capacity to 164, or deactivate 32 players.';

describe('base entitlement guard — spec/allocation.md §7.4', () => {
  let concertId: number;
  let showId: number;
  let segmentId: number;

  beforeEach(async () => {
    await resetDb();
    concertId = await createConcert();
    showId = await createShow(concertId, 400);
    segmentId = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 200,
      baseQuota: 2,
      extrasPolicy: 'REVIEW',
    });
    await createPlayers(concertId, 82);
  });

  it('names the numbers and the shortfall exactly as the spec writes them', async () => {
    await expect(
      sql`update show_segments set capacity = 100 where id = ${segmentId}::bigint`,
    ).rejects.toThrow(EXPECTED_MESSAGE);
  });

  it('route 1 — blocks editing segment capacity down', async () => {
    await expect(
      sql`update show_segments set capacity = 100 where id = ${segmentId}::bigint`,
    ).rejects.toThrow(/but the segment holds 100/);

    const [row] = await sql<{ capacity: number }[]>`
      select capacity from show_segments where id = ${segmentId}::bigint
    `;
    expect(row.capacity).toBe(200);
  });

  it('route 2 — blocks editing base quota up', async () => {
    await expect(
      sql`update show_segments set base_quota = 3 where id = ${segmentId}::bigint`,
    ).rejects.toThrow(/246 seats, but the segment holds 200/);
  });

  it('route 3a — blocks adding a player that would breach the entitlement', async () => {
    // 82 players × 2 = 164 fits in 200. Filling to 100 players is 200, exactly
    // at capacity and therefore allowed; the 101st breaches it.
    await createPlayers(concertId, 18);

    await expect(
      sql`
        insert into players (concert_id, full_name, email, invite_token, is_active)
        values (${concertId}::bigint, 'One Too Many', 'toomany@example.test', 'tok-x', true)
      `,
    ).rejects.toThrow(/101 active players × 2 base = 202 seats, but the segment holds 200/);
  });

  it('route 3b — blocks reactivating a player that would breach the entitlement', async () => {
    await createPlayers(concertId, 18);
    const [row] = await sql<{ id: number }[]>`
      insert into players (concert_id, full_name, email, invite_token, is_active)
      values (${concertId}::bigint, 'Dormant', 'dormant@example.test', 'tok-d', false)
      returning id
    `;

    await expect(
      sql`update players set is_active = true where id = ${row.id}::bigint`,
    ).rejects.toThrow(/101 active players/);
  });

  it('route 4 — blocks raising the quota through the cascade, not just on the segment', async () => {
    // `concerts.defaults` supplies `allocation.base_quota` to every segment that
    // does not override it, so editing it *is* editing the quota up — at a
    // different level. Without this the cascade is a silent fourth route to an
    // oversubscribed segment, which is the exact failure §7.4 describes.
    await sql`update show_segments set base_quota = null where id = ${segmentId}::bigint`;

    await expect(
      sql`
        update concerts set defaults = ${json({ 'allocation.base_quota': 5 })}::text::jsonb
         where id = ${concertId}::bigint
      `,
    ).rejects.toThrow(/82 active players × 5 base = 410 seats, but the segment holds 200/);
  });

  it('route 5 — blocks a per-player override that would breach the entitlement', async () => {
    // `player_allocations` is the one place a single player can be promised
    // more than the segment quota (decision 2). `segment_pool()` honours the
    // override, so if the guard used only the flat quota the two would disagree
    // — and the disagreement is an oversubscription nobody is warned about.
    const [player] = await sql<{ id: number }[]>`
      select id from players where concert_id = ${concertId}::bigint order by id limit 1
    `;

    await expect(
      sql`
        insert into player_allocations (player_id, segment_id, base_quota_override)
        values (${player.id}::bigint, ${segmentId}::bigint, 100)
      `,
    ).rejects.toThrow(/promised 262 seats between them \(1 with a per-player override\)/);
  });

  it('allows an override that still fits, and counts it as what it really is', async () => {
    const [player] = await sql<{ id: number }[]>`
      select id from players where concert_id = ${concertId}::bigint order by id limit 1
    `;
    // 81 players at 2 plus one at 20 = 182, inside the segment's 200.
    await sql`
      insert into player_allocations (player_id, segment_id, base_quota_override)
      values (${player.id}::bigint, ${segmentId}::bigint, 20)
    `;

    // And the pool agrees with the guard about what is owed.
    const [row] = await sql<{ segment_pool: { unclaimed_base: number } }[]>`
      select segment_pool(${segmentId}::bigint)
    `;
    expect(row.segment_pool.unclaimed_base).toBe(182);
  });

  it('allows the two honest levers — lowering the quota and raising capacity', async () => {
    await sql`update show_segments set base_quota = 1 where id = ${segmentId}::bigint`;
    await sql`update show_segments set capacity = 100 where id = ${segmentId}::bigint`;

    const [row] = await sql<{ capacity: number; base_quota: number }[]>`
      select capacity, base_quota from show_segments where id = ${segmentId}::bigint
    `;
    expect(row).toMatchObject({ capacity: 100, base_quota: 1 });
  });

  it('allows deactivating a player out of the way', async () => {
    await sql`update show_segments set capacity = 164 where id = ${segmentId}::bigint`;
    const [player] = await sql<{ id: number }[]>`
      select id from players where concert_id = ${concertId}::bigint order by id limit 1
    `;
    await sql`update players set is_active = false where id = ${player.id}::bigint`;

    await sql`update show_segments set capacity = 162 where id = ${segmentId}::bigint`;
    const [row] = await sql<{ capacity: number }[]>`
      select capacity from show_segments where id = ${segmentId}::bigint
    `;
    expect(row.capacity).toBe(162);
  });

  it('leaves a PUBLIC segment alone — it owes players nothing', async () => {
    const publicSegment = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 10,
      extrasPolicy: 'AUTO_FCFS',
    });
    await sql`update show_segments set capacity = 1 where id = ${publicSegment}::bigint`;

    const [row] = await sql<{ capacity: number }[]>`
      select capacity from show_segments where id = ${publicSegment}::bigint
    `;
    expect(row.capacity).toBe(1);
  });

  it('applies to a quota inherited from the cascade, not only one set on the segment', async () => {
    // A segment with no quota of its own resolves upward (spec/README.md §2.2);
    // the guard must see the resolved value, or the cascade becomes a way round
    // it. A second show, because `(show_id, audience_mode)` is unique.
    const otherShow = await createShow(concertId, 400);
    const inherited = await createSegment(otherShow, {
      audienceMode: 'PLAYER_INVITED',
      name: 'Inherits its quota',
      capacity: 300,
      baseQuota: null,
    });
    await sql`
      update concerts set defaults = ${json({ 'allocation.base_quota': 3 })}::text::jsonb
       where id = ${concertId}::bigint
    `;

    await expect(
      sql`update show_segments set capacity = 100 where id = ${inherited}::bigint`,
    ).rejects.toThrow(/82 active players × 3 base = 246 seats, but the segment holds 100/);
  });
});
