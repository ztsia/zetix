import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { SortingState } from '@tanstack/react-table';
import { getDb } from '@/db/client';
import { concerts } from '@/db/schema/concerts';
import { shows } from '@/db/schema/shows';
import { requireAdmin } from '@/lib/auth/guards';
import {
  ARRIVAL_BUCKET_MINUTES,
  getArrivalBuckets,
  getCheckinStats,
  getOperatorCounts,
  getScanLog,
  type ScanLogSort,
} from '@/lib/checkin/dashboard';
import { CheckinDashboard } from './checkin-dashboard';

export const metadata: Metadata = { title: 'Check-in' };

/**
 * `/admin/concerts/{id}/checkin` — the live dashboard and the scan log
 * (spec/checkin.md §12.4).
 *
 * **This is the number the door uses to decide when to stop holding seats**, so
 * everything on it is read fresh per request rather than cached: `force-dynamic`
 * plus the client's own poll while the page is open.
 *
 * The scan log pages, sorts and searches **in Postgres** — modules.md §5.2.1
 * names it as one of the three tables that must, and its state travels in the
 * URL so a filtered view is a link someone can send across the foyer.
 */
export const dynamic = 'force-dynamic';

const PAGE_SIZES = [10, 25, 50, 100];
const SORTABLE: ScanLogSort[] = ['scannedAt', 'attendeeName', 'operatorName', 'source'];

type Search = {
  show?: string;
  page?: string;
  size?: string;
  sort?: string;
  dir?: string;
  q?: string;
  reverted?: string;
};

export default async function CheckinPage({
  params,
  searchParams,
}: {
  params: Promise<{ concertId: string }>;
  searchParams: Promise<Search>;
}) {
  await requireAdmin();

  const concertId = Number((await params).concertId);
  if (!Number.isInteger(concertId) || concertId <= 0) notFound();

  const query = await searchParams;
  const db = getDb();

  const [concert] = await db
    .select({ id: concerts.id, name: concerts.name, timezone: concerts.timezone })
    .from(concerts)
    .where(and(eq(concerts.id, concertId), isNull(concerts.deletedAt)))
    .limit(1);
  if (!concert) notFound();

  const showRows = await db
    .select({ id: shows.id, name: shows.name, startsAt: shows.startsAt })
    .from(shows)
    .where(eq(shows.concertId, concertId))
    .orderBy(asc(shows.startsAt), asc(shows.id));

  const showOptions = showRows.map((show) => ({
    id: show.id,
    name: show.name,
    startsAt: show.startsAt?.toISOString() ?? null,
  }));

  // A concert with no shows has nothing to watch; the client renders the empty
  // state rather than this page inventing a showId that cannot exist.
  if (showOptions.length === 0) {
    return (
      <CheckinDashboard
        concertId={concertId}
        concertName={concert.name}
        timeZone={concert.timezone ?? 'UTC'}
        shows={[]}
        showId={null}
        stats={null}
        arrivals={[]}
        bucketMinutes={ARRIVAL_BUCKET_MINUTES}
        operatorCounts={[]}
        scanLog={{ rows: [], total: 0 }}
        pageIndex={0}
        pageSize={25}
        sorting={[]}
        search=""
        includeReverted={false}
      />
    );
  }

  // The requested show, but only if it belongs to this concert — otherwise a
  // hand-edited `?show=` would read another concert's door.
  const requested = Number(query.show);
  const showId = showOptions.some((show) => show.id === requested)
    ? requested
    : showOptions[0]!.id;

  const pageIndex = Math.max(0, Number(query.page ?? 0) || 0);
  const requestedSize = Number(query.size ?? 25);
  const pageSize = PAGE_SIZES.includes(requestedSize) ? requestedSize : 25;
  const sort = SORTABLE.includes(query.sort as ScanLogSort)
    ? (query.sort as ScanLogSort)
    : null;
  const descending = query.dir === 'desc';
  const search = (query.q ?? '').trim();
  const includeReverted = query.reverted === '1';

  const [stats, arrivals, operatorCounts, scanLog] = await Promise.all([
    getCheckinStats(showId),
    getArrivalBuckets(showId),
    getOperatorCounts(showId),
    getScanLog({
      showId,
      pageIndex,
      pageSize,
      sort,
      desc: sort ? descending : true,
      search,
      includeReverted,
    }),
  ]);

  const sorting: SortingState = sort ? [{ id: sort, desc: descending }] : [];

  return (
    <CheckinDashboard
      concertId={concertId}
      concertName={concert.name}
      // Rendered in the concert's zone, never the viewer's (spec/domain.md §6.1).
      // An admin watching from another city must see the door's clock.
      timeZone={concert.timezone ?? 'UTC'}
      shows={showOptions}
      showId={showId}
      stats={stats}
      arrivals={arrivals}
      bucketMinutes={ARRIVAL_BUCKET_MINUTES}
      operatorCounts={operatorCounts}
      scanLog={scanLog}
      pageIndex={pageIndex}
      pageSize={pageSize}
      sorting={sorting}
      search={search}
      includeReverted={includeReverted}
    />
  );
}
