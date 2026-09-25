import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { attendees, registrations } from '@/db/schema/registrations';
import { concerts } from '@/db/schema/concerts';
import { showSegments, shows } from '@/db/schema/shows';
import { requireRole } from '@/lib/auth/guards';
import { parseTicketFilters, ticketWhere, type TicketQuery } from './filters';
import { TicketsTable, type TicketRow } from './tickets-table';
import { maskForRole } from '@/lib/auth/mask';

export const metadata: Metadata = { title: 'Tickets' };

/**
 * `/admin/concerts/{id}/tickets` — issue, preview and reissue (§10.5, §10.6).
 *
 * Server-mode `DataTable`, copying `/admin/concerts` (modules.md §5.2.1): a
 * show can hold several hundred attendees, and a browser-paged table would
 * search only the rows on screen.
 *
 * **The page guards itself with `requireRole()`.** The layout above it does
 * too, but the guard is cheap and a page that relies on an ancestor is a page
 * that breaks silently when the ancestor changes (decision 20).
 */
const PAGE_SIZES = [10, 25, 50, 100];

const SORTABLE = {
  fullName: attendees.fullName,
  ticketCode: attendees.ticketCode,
  status: attendees.status,
  ticketIssuedAt: attendees.ticketIssuedAt,
  ticketSentAt: attendees.ticketSentAt,
} as const;

type Search = TicketQuery & {
  page?: string;
  size?: string;
  sort?: string;
  dir?: string;
};

export default async function TicketsPage({
  params,
  searchParams,
}: {
  params: Promise<{ concertId: string }>;
  searchParams: Promise<Search>;
}) {
  const user = await requireRole('ADMIN', 'VIEWER');

  const { concertId: rawConcertId } = await params;
  const concertId = Number(rawConcertId);
  if (!Number.isInteger(concertId) || concertId <= 0) notFound();

  const query = await searchParams;
  const pageIndex = Math.max(0, Number(query.page ?? 0) || 0);
  const requestedSize = Number(query.size ?? 25);
  const pageSize = PAGE_SIZES.includes(requestedSize) ? requestedSize : 25;
  const sortKey = (query.sort ?? '') in SORTABLE ? (query.sort as keyof typeof SORTABLE) : null;
  const descending = query.dir === 'desc';
  const filters = parseTicketFilters(query);

  const db = getDb();

  const [concert] = await db
    .select({ id: concerts.id, name: concerts.name, timezone: concerts.timezone })
    .from(concerts)
    .where(and(eq(concerts.id, concertId), isNull(concerts.deletedAt)))
    .limit(1);
  if (!concert) notFound();

  const concertShows = await db
    .select({ id: shows.id, name: shows.name })
    .from(shows)
    .where(and(eq(shows.concertId, concertId), isNull(shows.deletedAt)))
    .orderBy(asc(shows.startsAt), asc(shows.name));

  /**
   * Segments carry the show's name too: one concert can hold "Public" twice
   * over two nights, and a bare segment name in a dropdown would be a coin
   * toss. Segments, not shows, own audience mode (CLAUDE.md), so this is the
   * filter that matches how the concert is actually divided.
   */
  const concertSegments = await db
    .select({
      id: showSegments.id,
      name: showSegments.name,
      showId: showSegments.showId,
      showName: shows.name,
    })
    .from(showSegments)
    .innerJoin(shows, eq(shows.id, showSegments.showId))
    .where(and(eq(shows.concertId, concertId), isNull(shows.deletedAt)))
    .orderBy(asc(shows.startsAt), asc(shows.name), asc(showSegments.id));

  const where = ticketWhere(concertId, filters);

  const orderBy = sortKey
    ? [descending ? desc(SORTABLE[sortKey]) : asc(SORTABLE[sortKey]), asc(attendees.id)]
    : [asc(attendees.showId), asc(attendees.fullName), asc(attendees.id)];

  const [rows, [tally], [pending]] = await Promise.all([
    db
      .select({
        id: attendees.id,
        fullName: attendees.fullName,
        showId: attendees.showId,
        showName: shows.name,
        segmentId: attendees.segmentId,
        segmentName: showSegments.name,
        status: attendees.status,
        ticketCode: attendees.ticketCode,
        qrToken: attendees.qrToken,
        templateVersion: attendees.ticketTemplateVersion,
        ticketIssuedAt: attendees.ticketIssuedAt,
        ticketSentAt: attendees.ticketSentAt,
        needsReissue: attendees.needsReissue,
        contactName: registrations.contactName,
      })
      .from(attendees)
      .innerJoin(registrations, eq(registrations.id, attendees.registrationId))
      .innerJoin(shows, eq(shows.id, attendees.showId))
      .innerJoin(showSegments, eq(showSegments.id, attendees.segmentId))
      .where(where)
      .orderBy(...orderBy)
      .limit(pageSize)
      .offset(pageIndex * pageSize),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(attendees)
      .innerJoin(registrations, eq(registrations.id, attendees.registrationId))
      .innerJoin(shows, eq(shows.id, attendees.showId))
      .innerJoin(showSegments, eq(showSegments.id, attendees.segmentId))
      .where(where),
    // §10.6's "N tickets need reissuing" count — over the whole concert, not
    // the current page, since it is a call to action rather than a column.
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(attendees)
      .innerJoin(shows, eq(shows.id, attendees.showId))
      .where(
        and(
          eq(shows.concertId, concertId),
          eq(attendees.needsReissue, true),
          isNull(attendees.deletedAt),
        ),
      ),
  ]);

  const data: TicketRow[] = rows.map((row) => ({
    id: row.id,
    fullName: row.fullName,
    showId: row.showId,
    showName: row.showName,
    segmentId: row.segmentId,
    segmentName: row.segmentName,
    status: row.status,
    ticketCode: row.ticketCode,
    issued: row.qrToken !== null && row.templateVersion !== null,
    templateVersion: row.templateVersion,
    ticketIssuedAt: row.ticketIssuedAt?.toISOString() ?? null,
    ticketSentAt: row.ticketSentAt?.toISOString() ?? null,
    needsReissue: row.needsReissue,
    contactName: row.contactName,
  }));

  return (
    <TicketsTable
      concertId={concertId}
      concertName={concert.name}
      // Every timestamp renders in the concert's zone, never the viewer's
      // (CLAUDE.md). UTC only where a concert has none set yet.
      timeZone={concert.timezone ?? 'UTC'}
      shows={concertShows}
      segments={concertSegments}
      filters={filters}
      rows={maskForRole(user.role, data)}
      rowCount={tally?.n ?? 0}
      needsReissueCount={pending?.n ?? 0}
      pageIndex={pageIndex}
      pageSize={pageSize}
      sorting={sortKey ? [{ id: sortKey, desc: descending }] : []}
    />
  );
}
