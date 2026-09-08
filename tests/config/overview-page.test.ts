import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createSegment, createShow } from '../helpers/fixtures';

/**
 * The concert overview (spec/admin.md §14.1).
 *
 * The screen that answers "is this concert configured?" without opening
 * anything, so what is tested is that it renders in every half-configured state
 * it exists to describe — including the ones where the allocation engine
 * refuses to produce numbers.
 */

class NotFoundSignal extends Error {}

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new NotFoundSignal('notFound');
  },
}));

const OverviewPage = (
  await import('@/app/(admin)/admin/concerts/[concertId]/overview/page')
).default;

const render = (concertId: number | string) =>
  OverviewPage({ params: Promise.resolve({ concertId: String(concertId) }) });

describe('the concert overview', () => {
  let concertId: number;

  beforeEach(async () => {
    await resetDb();
    concertId = await createConcert('September concert');
  });

  it('renders a concert with nothing configured at all', async () => {
    await expect(render(concertId)).resolves.toBeTruthy();
  });

  it('renders a show whose hall has no capacity', async () => {
    await createShow(concertId, null);
    await expect(render(concertId)).resolves.toBeTruthy();
  });

  it('renders a segment with no capacity, where the engine has no pool to give', async () => {
    const showId = await createShow(concertId, 400);
    await createSegment(showId, { audienceMode: 'PUBLIC', capacity: null });
    await expect(render(concertId)).resolves.toBeTruthy();
  });

  it('renders the fully configured 19 Sep shape', async () => {
    await sql`update concerts set timezone = 'Asia/Kuala_Lumpur' where id = ${concertId}::bigint`;
    const showId = await createShow(concertId, 400);
    await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 300 });
    await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 100,
      baseQuota: 1,
    });

    await expect(render(concertId)).resolves.toBeTruthy();
  });

  it('cannot be pushed over the hall in the first place', async () => {
    // `assert_segments_fit_hall` refuses Σ segment capacity > hall with no
    // override flag, so "N over" is a state the database will not produce. The
    // overview renders it defensively anyway; what is worth asserting is the
    // refusal, and that the numbers on screen stay the ones that were valid.
    const showId = await createShow(concertId, 400);
    await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 300 });
    await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 100,
      baseQuota: 1,
    });

    await expect(
      sql`update shows set capacity = 350 where id = ${showId}::bigint`,
    ).rejects.toThrow(/the hall holds 350/);

    const [row] = await sql<{ capacity: number }[]>`
      select capacity from shows where id = ${showId}::bigint
    `;
    expect(row.capacity).toBe(400);
    await expect(render(concertId)).resolves.toBeTruthy();
  });

  it('404s on a concert that does not exist', async () => {
    await expect(render(999999)).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it('404s on a non-numeric id instead of querying with NaN', async () => {
    await expect(render('not-a-number')).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it('404s on a soft-deleted concert', async () => {
    await sql`update concerts set deleted_at = now() where id = ${concertId}::bigint`;
    await expect(render(concertId)).rejects.toBeInstanceOf(NotFoundSignal);
  });
});
