import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { concerts } from '@/db/schema/concerts';
import { appUsers } from '@/db/schema/people';
import { shows } from '@/db/schema/shows';
import { requireRole } from '@/lib/auth/guards';
import { OperatorsScreen, type OperatorRow, type ShowOption } from './operators-screen';
import { maskForRole } from '@/lib/auth/mask';

export const metadata: Metadata = { title: 'Operators' };

/**
 * `/admin/concerts/{id}/operators` — provision operators, assign shows, reset
 * codes, deactivate (spec/admin.md §14.3, spec/checkin.md §12.1).
 *
 * **`requireRole()` here and again in every action.** This page lists who can
 * reach an attendee roster and hands out the credential that gets them there;
 * the Server Actions behind it are their own POST entry points, so the guard on
 * this page does not cover them (modules.md §5.2.1).
 *
 * Client-mode `DataTable`, not server mode. There are about six ushers
 * (context.md §6 question 7) — server paging is for registrations, attendees and
 * the scan log, where the row count actually justifies the round trip.
 *
 * **No name is seeded.** Question 7 was still open when this was built, so the
 * list starts empty and the admin types the ushers in when the roster is
 * settled.
 */
export default async function OperatorsPage({
  params,
}: {
  params: Promise<{ concertId: string }>;
}) {
  const user = await requireRole('ADMIN', 'VIEWER');

  const concertId = Number((await params).concertId);
  if (!Number.isInteger(concertId) || concertId <= 0) notFound();

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

  const showOptions: ShowOption[] = showRows.map((show) => ({
    id: show.id,
    name: show.name,
    startsAt: show.startsAt?.toISOString() ?? null,
  }));

  /**
   * One row per operator, with the two counts the screen exists to show.
   *
   * Both aggregates are scoped to **this concert's shows**. The tables are
   * global — an usher can work several concerts — so an unscoped count would
   * report last month's night on this month's screen.
   *
   * `check_ins` excludes reverted rows, because a reverted scan is a mistake
   * that was undone (decision 7) and counting it would overstate what an usher
   * actually admitted.
   */
  const operators = await db
    .select({
      id: appUsers.id,
      displayName: appUsers.displayName,
      email: appUsers.email,
      isActive: appUsers.isActive,
      lastLoginAt: appUsers.lastLoginAt,
      assignedShowIds: sql<number[]>`
        coalesce((
          select array_agg(osa.show_id order by osa.show_id)
          from operator_show_assignments osa
          join shows s on s.id = osa.show_id
          where osa.user_id = app_users.id and s.concert_id = ${concertId}
        ), '{}')
      `,
      checkInCount: sql<number>`
        (
          select count(*)::int
          from check_ins c
          join shows s on s.id = c.show_id
          where c.operator_id = app_users.id
            and s.concert_id = ${concertId}
            and c.reverted_at is null
        )
      `,
    })
    .from(appUsers)
    .where(and(eq(appUsers.role, 'OPERATOR'), isNull(appUsers.deletedAt)))
    .orderBy(asc(appUsers.displayName), asc(appUsers.email));

  const rows: OperatorRow[] = operators.map((operator) => ({
    id: operator.id,
    displayName: operator.displayName ?? operator.email,
    email: operator.email,
    isActive: operator.isActive,
    lastLoginAt: operator.lastLoginAt?.toISOString() ?? null,
    // Postgres hands `bigint` back as a string through postgres.js, so ids that
    // look numeric here would not match the number-keyed checkboxes.
    assignedShowIds: (operator.assignedShowIds ?? []).map(Number),
    checkInCount: Number(operator.checkInCount ?? 0),
  }));

  return (
    <OperatorsScreen
      concertId={concertId}
      concertName={concert.name}
      // Every timestamp on this screen renders in the concert's zone, never the
      // viewer's (spec/domain.md §6.1).
      timeZone={concert.timezone ?? 'UTC'}
      shows={showOptions}
      operators={maskForRole(user.role, rows)}
    />
  );
}
