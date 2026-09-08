import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createPlayers,
  createRegistration,
  createSegment,
  createShow,
  seedAttendees,
  setSystemSetting,
} from '../helpers/fixtures';

/**
 * The shows screen, on the server side.
 *
 * No browser: this calls the real page component and the query behind it. A
 * Server Component that throws at runtime passes both `tsc` and `next build`,
 * so "it compiles" is not evidence that the page renders — this is what covers
 * the gap between them. How it *looks* is the QA pass's job.
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

const { getShowsForConcert, getConcertHeader } = await import(
  '@/app/(admin)/admin/concerts/[concertId]/shows/queries'
);
const ShowsPage = (await import('@/app/(admin)/admin/concerts/[concertId]/shows/page'))
  .default;

describe('the shows screen', () => {
  let concertId: number;

  beforeEach(async () => {
    await resetDb();
    concertId = await createConcert('September concert');
    await sql`update concerts set timezone = 'Asia/Kuala_Lumpur' where id = ${concertId}::bigint`;
  });

  it('renders a concert with no shows without throwing', async () => {
    await expect(
      ShowsPage({ params: Promise.resolve({ concertId: String(concertId) }) }),
    ).resolves.toBeTruthy();
  });

  it('renders the 19 Sep shape — one hall, two segments, both audiences', async () => {
    const showId = await createShow(concertId, 400);
    await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 300,
      name: 'Public',
      extrasPolicy: 'AUTO_FCFS',
    });
    await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 100,
      baseQuota: 1,
      name: 'Player invited',
      extrasPolicy: 'REVIEW',
    });

    await expect(
      ShowsPage({ params: Promise.resolve({ concertId: String(concertId) }) }),
    ).resolves.toBeTruthy();

    const [show] = await getShowsForConcert(concertId);
    expect(show.segments).toHaveLength(2);
    // Both audiences in one hall on one night is the normal case, not an
    // exception (decision 5).
    expect(new Set(show.segments.map((s) => s.audienceMode))).toEqual(
      new Set(['PUBLIC', 'PLAYER_INVITED']),
    );
  });

  it('counts held seats as the seats no segment holds (decision 21)', async () => {
    const showId = await createShow(concertId, 400);
    await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 300 });
    await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 90,
      baseQuota: 1,
    });

    const [show] = await getShowsForConcert(concertId);

    expect(show.allocated).toBe(390);
    expect(show.held).toBe(10);
  });

  it('reports held as null when the hall itself is unset, never as zero', async () => {
    // "None held" and "nobody has said how big the room is" need different
    // actions from the admin, so they must not render the same.
    const showId = await createShow(concertId, null);
    await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 100 });

    const [show] = await getShowsForConcert(concertId);

    expect(show.held).toBeNull();
    expect(show.allocated).toBe(100);
  });

  it('separates the raw column from the resolved value and its origin', async () => {
    const showId = await createShow(concertId, 400);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: null,
      baseQuota: null,
    });
    await sql`
      update concerts set defaults = ${JSON.stringify({ 'allocation.base_quota': 2 })}::jsonb
       where id = ${concertId}::bigint
    `;
    await createPlayers(concertId, 3);

    const [show] = await getShowsForConcert(concertId);
    const segment = show.segments.find((s) => s.id === segmentId)!;

    // The column is null — this segment overrides nothing — while the effective
    // quota is the concert's 2. A form that pre-filled "2" here would invite an
    // admin to pin the concert's value onto the segment by accident.
    expect(segment.raw.baseQuota).toBeNull();
    expect(segment.resolved['allocation.base_quota']).toMatchObject({
      value: 2,
      origin: 'concert',
    });
  });

  it('reads the live pool from the engine rather than recomputing it', async () => {
    const showId = await createShow(concertId, 400);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 300,
    });
    const registrationId = await createRegistration({ showId, segmentId });
    await seedAttendees({
      registrationId,
      showId,
      segmentId,
      count: 12,
      allocationType: 'EXTRA',
      status: 'CONFIRMED',
    });

    const [show] = await getShowsForConcert(concertId);
    const segment = show.segments[0];

    expect(segment.pool).not.toBeNull();
    expect(segment.pool!.sellable).toBe(300);
    expect(segment.pool!.confirmed).toBe(12);
    expect(segment.pool!.extras_pool).toBe(288);
    expect(segment.pool!.over).toBe(0);
  });

  it('renders a segment that has no capacity at any level yet', async () => {
    // The state a segment is in the moment it is created: operational values
    // carry no seed anywhere (spec/domain.md §6), so `segment_pool()` refuses
    // rather than inventing a `sellable` every other figure derives from.
    // Asking it regardless made the shows screen throw on the one state it
    // exists to help the admin out of.
    const showId = await createShow(concertId, 400);
    await createSegment(showId, { audienceMode: 'PUBLIC', capacity: null });

    await expect(
      ShowsPage({ params: Promise.resolve({ concertId: String(concertId) }) }),
    ).resolves.toBeTruthy();

    const [show] = await getShowsForConcert(concertId);
    expect(show.segments[0].pool).toBeNull();
    // It allocates nothing, so its seats still read as held rather than
    // silently counting as zero capacity that was deliberately chosen.
    expect(show.allocated).toBe(0);
    expect(show.held).toBe(400);
  });

  it('picks the audience-keyed extras policy up from the root for each segment', async () => {
    await setSystemSetting('allocation.extras_policy', {
      PLAYER_INVITED: 'REVIEW',
      PUBLIC: 'AUTO_FCFS',
    });
    const showId = await createShow(concertId, 400);
    await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 300 });
    await createSegment(showId, {
      audienceMode: 'PLAYER_INVITED',
      capacity: 100,
      baseQuota: 1,
    });

    const [show] = await getShowsForConcert(concertId);
    const byMode = Object.fromEntries(
      show.segments.map((s) => [s.audienceMode, s.resolved['allocation.extras_policy']]),
    );

    expect(byMode['PUBLIC']?.value).toBe('AUTO_FCFS');
    expect(byMode['PLAYER_INVITED']?.value).toBe('REVIEW');
  });

  it('leaves a soft-deleted segment out', async () => {
    const showId = await createShow(concertId, 400);
    const segmentId = await createSegment(showId, {
      audienceMode: 'PUBLIC',
      capacity: 300,
    });
    await sql`update show_segments set deleted_at = now() where id = ${segmentId}::bigint`;

    const [show] = await getShowsForConcert(concertId);

    expect(show.segments).toHaveLength(0);
    // The seats come back as held rather than vanishing from the accounting.
    expect(show.held).toBe(400);
  });

  it('404s on a concert that does not exist, rather than rendering an empty one', async () => {
    await expect(
      ShowsPage({ params: Promise.resolve({ concertId: '999999' }) }),
    ).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it('404s on a non-numeric id instead of querying with NaN', async () => {
    await expect(
      ShowsPage({ params: Promise.resolve({ concertId: 'not-a-number' }) }),
    ).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it('does not return a soft-deleted concert', async () => {
    await sql`update concerts set deleted_at = now() where id = ${concertId}::bigint`;
    await expect(getConcertHeader(concertId)).resolves.toBeNull();
  });
});
