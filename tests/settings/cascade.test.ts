import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createSegment,
  createShow,
  json,
  setSystemSetting,
} from '../helpers/fixtures';

/**
 * The four-level configuration cascade — spec/README.md §2.2, spec/domain.md §6.
 *
 *   system_settings → concert.defaults → show.<field> → segment.<field>
 *
 * Every tunable is nullable at the concert, show and segment levels and
 * resolves upward until a value is found. **Never read a raw column for a
 * cascading value.**
 *
 * The resolver lives in Postgres rather than in TypeScript because
 * `claim_seats()` needs it too, and two implementations of one rule drift.
 */

async function resolve(
  key: string,
  ctx: { segmentId?: number | null; showId?: number | null; concertId?: number | null },
): Promise<unknown> {
  const [row] = await sql<{ resolve_setting: unknown }[]>`
    select resolve_setting(
      ${key}::text,
      ${ctx.segmentId ?? null}::bigint,
      ${ctx.showId ?? null}::bigint,
      ${ctx.concertId ?? null}::bigint
    )
  `;
  return row.resolve_setting;
}

describe('resolve_setting() — spec/README.md §2.2', () => {
  let concertId: number;
  let showId: number;
  let segmentId: number;

  beforeEach(async () => {
    await resetDb();
    concertId = await createConcert();
    showId = await createShow(concertId, null);
    segmentId = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: null,
      baseQuota: null,
    });
  });

  it('prefers the segment, which is authoritative', async () => {
    await setSystemSetting('allocation.base_quota', 1);
    await sql`
      update concerts set defaults = ${json({ 'allocation.base_quota': 2 })}::text::jsonb
       where id = ${concertId}::bigint
    `;
    await sql`update show_segments set base_quota = 4 where id = ${segmentId}::bigint`;

    expect(await resolve('allocation.base_quota', { segmentId, showId, concertId })).toBe(4);
  });

  it('falls through the segment to the concert when the segment is null', async () => {
    await setSystemSetting('allocation.base_quota', 1);
    await sql`
      update concerts set defaults = ${json({ 'allocation.base_quota': 2 })}::text::jsonb
       where id = ${concertId}::bigint
    `;

    expect(await resolve('allocation.base_quota', { segmentId, showId, concertId })).toBe(2);
  });

  it('falls all the way through to system_settings', async () => {
    await setSystemSetting('allocation.base_quota', 1);
    expect(await resolve('allocation.base_quota', { segmentId, showId, concertId })).toBe(1);
  });

  it('reads a show-level default between the segment and the concert', async () => {
    // spec/README.md §2.2 promises every tunable is nullable "at the concert,
    // show and segment levels". §5.1 gives `shows` typed columns for only three
    // keys, so `shows.defaults` carries the rest — otherwise a show could not
    // hold one base-claim deadline for both of its segments, which is the
    // obvious way to configure a mixed-mode night.
    await setSystemSetting('allocation.base_quota', 1);
    await sql`
      update concerts set defaults = ${json({ 'allocation.base_quota': 2 })}::text::jsonb
       where id = ${concertId}::bigint
    `;
    await sql`
      update shows set defaults = ${json({ 'allocation.base_quota': 6 })}::text::jsonb
       where id = ${showId}::bigint
    `;

    expect(await resolve('allocation.base_quota', { segmentId, showId, concertId })).toBe(6);

    // And the segment still wins over it.
    await sql`update show_segments set base_quota = 4 where id = ${segmentId}::bigint`;
    expect(await resolve('allocation.base_quota', { segmentId, showId, concertId })).toBe(4);
  });

  it('resolves the hall capacity at show level', async () => {
    await sql`update shows set capacity = 400 where id = ${showId}::bigint`;
    expect(await resolve('capacity', { segmentId, showId, concertId })).toBe(400);
  });

  it('returns null for an operational value nobody has set', async () => {
    // Operational values carry no install-time seed: a missing one is a
    // validation error at save time, never a silent fallback
    // (spec/domain.md §6). The resolver reports absence; it does not invent a
    // number.
    expect(await resolve('allocation.base_quota', { segmentId, showId, concertId })).toBeNull();
  });

  it('a null at one level does not mean zero — it means "not set here"', async () => {
    await setSystemSetting('segment.capacity', 250);
    // The segment's own capacity column is null.
    expect(await resolve('segment.capacity', { segmentId, showId, concertId })).toBe(250);

    // An explicit zero at the segment level, by contrast, is a real answer and
    // stops the walk.
    await sql`update show_segments set capacity = 0 where id = ${segmentId}::bigint`;
    expect(await resolve('segment.capacity', { segmentId, showId, concertId })).toBe(0);
  });

  it('resolves a system-only key with no physical column anywhere below', async () => {
    await setSystemSetting('email.max_per_dispatch', 25);
    expect(await resolve('email.max_per_dispatch', { segmentId, showId, concertId })).toBe(25);
  });

  it('infers the show and concert from the segment when they are not supplied', async () => {
    await sql`update shows set capacity = 400 where id = ${showId}::bigint`;
    // Callers should not have to walk the hierarchy by hand just to read a value.
    expect(await resolve('capacity', { segmentId })).toBe(400);
  });

  it('picks the extras policy per audience mode at the system level', async () => {
    // Decision 4 gives player segments REVIEW and public segments AUTO_FCFS.
    // That is data, not a literal in code: the system-level value is an object
    // keyed by audience mode.
    await setSystemSetting('allocation.extras_policy', {
      PLAYER_INVITED: 'REVIEW',
      PUBLIC: 'AUTO_FCFS',
    });
    const publicSegment = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: null,
    });

    expect(await resolve('allocation.extras_policy', { segmentId })).toBe('REVIEW');
    expect(await resolve('allocation.extras_policy', { segmentId: publicSegment })).toBe(
      'AUTO_FCFS',
    );
  });
});
