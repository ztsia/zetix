import type { Metadata } from 'next';
import { and, asc, count, desc, eq, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { concerts } from '@/db/schema/concerts';
import { shows } from '@/db/schema/shows';
import { ConcertsTable, type ConcertRow } from './concerts-table';
import { ConcertCreateDialog } from './concert-create-dialog';
import { AdminOnly } from '@/components/auth/role';

export const metadata: Metadata = { title: 'Concerts' };

/**
 * `/admin/concerts` — list, create, archive (spec/admin.md §14.1).
 *
 * F2 shipped the list; module `A` added creating and archiving.
 *
 * **This is the reference implementation of `DataTable`'s server mode**
 * (spec/surfaces.md §15.1). Paging, sorting and searching all happen here in
 * Postgres, and the browser is handed exactly one page. The pattern is the one
 * registrations, attendees and the scan log will need at their real volumes, so
 * it is worth copying rather than reinventing — and it means the shared table's
 * server path is exercised by a screen that ships, not by a demo.
 *
 * State travels in the URL rather than React state, so a filtered, sorted page
 * of the list is a link someone can send.
 */
const PAGE_SIZES = [10, 25, 50, 100];

/** Only these can be sorted on — never interpolate a column name from a query string. */
const SORTABLE = {
  name: concerts.name,
  season: concerts.season,
  status: concerts.status,
  startsOn: concerts.startsOn,
} as const;

type Search = { page?: string; size?: string; sort?: string; dir?: string; q?: string };

function readParams(params: Search) {
  const pageIndex = Math.max(0, Number(params.page ?? 0) || 0);
  const requested = Number(params.size ?? 25);
  const pageSize = PAGE_SIZES.includes(requested) ? requested : 25;
  const sortKey = (params.sort ?? '') in SORTABLE ? (params.sort as keyof typeof SORTABLE) : null;
  const desc_ = params.dir === 'desc';
  const search = (params.q ?? '').trim();
  return { pageIndex, pageSize, sortKey, desc: desc_, search };
}

export default async function ConcertsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const { pageIndex, pageSize, sortKey, desc: descending, search } = readParams(await searchParams);
  const db = getDb();

  const filters: SQL[] = [isNull(concerts.deletedAt)];
  if (search) {
    const like = `%${search}%`;
    // `or()` is only undefined with no arguments; these are always three.
    filters.push(
      or(ilike(concerts.name, like), ilike(concerts.season, like), ilike(concerts.slug, like))!,
    );
  }
  const where = and(...filters);

  const orderBy = sortKey
    ? [descending ? desc(SORTABLE[sortKey]) : asc(SORTABLE[sortKey]), asc(concerts.id)]
    : // Default: soonest first, undated last. `nulls last` belongs after the
      // direction, so wrapping this in `asc()` would emit `... nulls last asc`,
      // which Postgres rejects at runtime while typecheck and build both pass.
      [sql`${concerts.startsOn} asc nulls last`, asc(concerts.name)];

  const [rows, [tally]] = await Promise.all([
    db
      .select({
        id: concerts.id,
        name: concerts.name,
        slug: concerts.slug,
        season: concerts.season,
        status: concerts.status,
        startsOn: concerts.startsOn,
        endsOn: concerts.endsOn,
        timezone: concerts.timezone,
        shows: count(shows.id),
      })
      .from(concerts)
      .leftJoin(shows, eq(shows.concertId, concerts.id))
      .where(where)
      .groupBy(concerts.id)
      .orderBy(...orderBy)
      .limit(pageSize)
      .offset(pageIndex * pageSize),
    // Counted separately: the page query groups by concert to count shows, so
    // its row count is the page, not the match.
    db.select({ total: count() }).from(concerts).where(where),
  ]);

  const data: ConcertRow[] = rows.map((row) => ({ ...row, shows: Number(row.shows) }));

  /**
   * Export timestamps render in the concert's zone (`CLAUDE.md`). This list spans
   * concerts that may sit in different zones, so it falls back to the first
   * concert that declares one — and this table's own columns are calendar dates
   * and counts, none of which is zone-dependent.
   */
  const timeZone = data.find((row) => row.timezone)?.timezone ?? 'UTC';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Concerts</h1>
          <p className="text-muted-foreground text-sm">
            Choose a concert to open its console.
          </p>
        </div>
        <AdminOnly>
          <ConcertCreateDialog />
        </AdminOnly>
      </div>
      <ConcertsTable
        concerts={data}
        timeZone={timeZone}
        rowCount={Number(tally?.total ?? 0)}
        pageIndex={pageIndex}
        pageSize={pageSize}
        sorting={sortKey ? [{ id: sortKey, desc: descending }] : []}
        search={search}
      />
    </div>
  );
}
