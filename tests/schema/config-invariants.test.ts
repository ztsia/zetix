import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createPlayers,
  createRegistration,
  createSegment,
  createShow,
  json,
} from '../helpers/fixtures';

/**
 * Configuration invariants, checked through **every level of the cascade**.
 *
 * These tests exist because of a pattern rather than a single bug. Each guard on
 * this branch was added one route at a time as each was found, and each time the
 * *next* route was missed: the segment's own column was guarded while the same
 * value arriving through `shows.defaults`, `concerts.defaults` or
 * `system_settings` was not. Resolving a value walks four levels, so every check
 * on a resolved value has four doors, and a guard on one door is not a guard.
 *
 * `assert_show_configuration()` is the single door they all now go through.
 */

async function fill(showId: number, segmentId: number, count: number): Promise<void> {
  const registrationId = await createRegistration({ showId, segmentId });
  await sql`
    select claim_seats(${segmentId}::bigint, ${registrationId}::bigint,
                       ${JSON.stringify(
                         Array.from({ length: count }, (_, i) => ({
                           full_name: `Guest ${i + 1}`,
                           allocation_type: 'EXTRA',
                         })),
                       )}::text::jsonb, false)
  `;
}

describe('a segment cannot shrink below its confirmed count, through any level', () => {
  let concertId: number;
  let showId: number;
  let segmentId: number;

  beforeEach(async () => {
    await resetDb();
    concertId = await createConcert();
    showId = await createShow(concertId, 10);
    // Capacity supplied by the cascade, not by the segment's own column.
    segmentId = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: null,
      extrasPolicy: 'AUTO_FCFS',
    });
    await sql`
      update concerts set defaults = ${json({ 'segment.capacity': 10 })}::text::jsonb
       where id = ${concertId}::bigint
    `;
    await fill(showId, segmentId, 3);
  });

  it('refuses through concerts.defaults', async () => {
    await expect(
      sql`
        update concerts set defaults = ${json({ 'segment.capacity': 1 })}::text::jsonb
         where id = ${concertId}::bigint
      `,
    ).rejects.toThrow(/already has 3 confirmed seats, so its capacity cannot drop to 1/);
  });

  it('refuses through shows.defaults', async () => {
    await expect(
      sql`
        update shows set defaults = ${json({ 'segment.capacity': 2 })}::text::jsonb
         where id = ${showId}::bigint
      `,
    ).rejects.toThrow(/already has 3 confirmed seats, so its capacity cannot drop to 2/);
  });

  it('refuses through system_settings', async () => {
    await sql`update concerts set defaults = null where id = ${concertId}::bigint`;
    await expect(
      sql`
        insert into system_settings (key, value) values ('segment.capacity', ${'1'}::text::jsonb)
      `,
    ).rejects.toThrow(/already has 3 confirmed seats/);
  });

  it('allows a shrink that still covers the confirmed seats', async () => {
    await sql`
      update concerts set defaults = ${json({ 'segment.capacity': 3 })}::text::jsonb
       where id = ${concertId}::bigint
    `;
    const [row] = await sql<{ segment_pool: { sellable: number } }[]>`
      select segment_pool(${segmentId}::bigint)
    `;
    expect(row.segment_pool.sellable).toBe(3);
  });
});

describe('a segment or show holding seats cannot be deleted', () => {
  let showId: number;
  let segmentId: number;

  beforeEach(async () => {
    await resetDb();
    const concertId = await createConcert();
    showId = await createShow(concertId, 10);
    segmentId = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 10,
      extrasPolicy: 'AUTO_FCFS',
    });
    await fill(showId, segmentId, 3);
  });

  it('refuses to soft-delete a segment that holds confirmed seats', async () => {
    // §7.7 refuses to drop a segment below its confirmed count; deleting it is
    // that edit taken to zero, and worse — the hall arithmetic stops counting a
    // deleted segment's capacity while its attendees still occupy seats, so
    // another segment can be raised into space that is not there.
    await expect(
      sql`update show_segments set deleted_at = now() where id = ${segmentId}::bigint`,
    ).rejects.toThrow(/This segment still holds 3 confirmed seats, so it cannot be deleted/);
  });

  it('refuses to soft-delete a show that holds confirmed seats', async () => {
    await expect(
      sql`update shows set deleted_at = now() where id = ${showId}::bigint`,
    ).rejects.toThrow(/This show still holds 3 confirmed seats, so it cannot be deleted/);
  });

  it('allows deletion once the seats are gone', async () => {
    await sql`update registrations set status = 'CANCELLED' where segment_id = ${segmentId}::bigint`;
    await sql`update show_segments set deleted_at = now() where id = ${segmentId}::bigint`;

    const [row] = await sql<{ deleted: boolean }[]>`
      select deleted_at is not null as deleted from show_segments where id = ${segmentId}::bigint
    `;
    expect(row.deleted).toBe(true);
  });
});

describe('moving a show between concerts rechecks who is entitled', () => {
  it('refuses a move into a concert whose players do not fit', async () => {
    await resetDb();
    const quiet = await createConcert('Quiet Concert');
    const crowded = await createConcert('Crowded Concert');
    const showId = await createShow(quiet, 10);
    await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 2,
      baseQuota: 1,
      extrasPolicy: 'REVIEW',
    });
    await createPlayers(crowded, 5);

    // Players are concert-scoped, so moving the show changes *which* players its
    // player segment owes seats to. Nothing else in the row hints at that.
    await expect(
      sql`update shows set concert_id = ${crowded}::bigint where id = ${showId}::bigint`,
    ).rejects.toThrow(/5 active players × 1 base = 5 seats, but the segment holds 2/);
  });

  it('allows a move the destination concert can honour', async () => {
    await resetDb();
    const from = await createConcert('From');
    const to = await createConcert('To');
    const showId = await createShow(from, 10);
    await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 5,
      baseQuota: 1,
      extrasPolicy: 'REVIEW',
    });
    await createPlayers(to, 3);

    await sql`update shows set concert_id = ${to}::bigint where id = ${showId}::bigint`;
    const [row] = await sql<{ concert_id: string }[]>`
      select concert_id from shows where id = ${showId}::bigint
    `;
    expect(Number(row.concert_id)).toBe(to);
  });
});
