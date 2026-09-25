import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { getConcertHeader } from '../shows/queries';
import {
  listPlayerOptions,
  listRegistrations,
  listSegmentOptions,
  type AttendeeRow,
} from './queries';
import { RegistrationsTable } from './registrations-table';
import { maskForRole } from '@/lib/auth/mask';
import { requireRole } from '@/lib/auth/guards';

export const metadata: Metadata = { title: 'Registrations' };

/**
 * `/admin/concerts/{id}/registrations` — the searchable table and full manual
 * CRUD of spec/admin.md §14.1 and spec/allocation.md §7.6.
 *
 * > Players registering after the form closes are expected, not exceptional.
 *
 * So this screen is not a read-only view of what the forms collected. It is
 * where an admin creates a party against any segment, edits its guests, moves it
 * between segments or shows, and cancels or restores it — every one of those
 * routed through `claim_seats()` or `promote_seats()`, so the counters stay
 * true.
 */
export default async function RegistrationsPage({
  params,
}: {
  params: Promise<{ concertId: string }>;
}) {
  const user = await requireRole('ADMIN', 'VIEWER');
  const { concertId: raw } = await params;
  const concertId = Number(raw);
  if (!Number.isInteger(concertId) || concertId <= 0) notFound();

  const concert = await getConcertHeader(concertId);
  if (!concert) notFound();

  const [registrations, segments, players] = await Promise.all([
    listRegistrations(concertId),
    listSegmentOptions(concertId),
    listPlayerOptions(concertId),
  ]);

  const attendeesByRegistration = await listAttendeesByRegistration(concertId);

  const totals = registrations.reduce(
    (acc, row) => ({
      confirmed: acc.confirmed + row.seats.confirmed,
      pending: acc.pending + row.seats.pending,
      waitlisted: acc.waitlisted + row.seats.waitlisted,
    }),
    { confirmed: 0, pending: 0, waitlisted: 0 },
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Registrations</h1>
          <p className="text-muted-foreground text-sm">
            {registrations.length} part{registrations.length === 1 ? 'y' : 'ies'} ·{' '}
            {totals.confirmed} seat{totals.confirmed === 1 ? '' : 's'} confirmed
            {totals.pending > 0 && `, ${totals.pending} held for review`}
            {totals.waitlisted > 0 && `, ${totals.waitlisted} waiting`}.
          </p>
        </div>
      </div>

      <RegistrationsTable
        concertId={concertId}
        timeZone={concert.timezone}
        registrations={maskForRole(user.role, registrations)}
        attendeesByRegistration={maskForRole(user.role, attendeesByRegistration)}
        segments={segments}
        players={players}
      />
    </div>
  );
}

/**
 * Every seat in the concert, grouped by the party that holds it.
 *
 * One query rather than one per opened sheet: a few hundred parties of two or
 * three seats is a small payload, and it means the detail sheet needs no
 * endpoint of its own — one fewer route to authorize, and `router.refresh()`
 * after an edit is what brings the seats back up to date.
 */
async function listAttendeesByRegistration(
  concertId: number,
): Promise<Record<number, AttendeeRow[]>> {
  const rows = await getDb().execute<{
    registration_id: string;
    id: string;
    full_name: string;
    name_source: 'PROVIDED' | 'PLACEHOLDER';
    email: string | null;
    allocation_type: AttendeeRow['allocationType'];
    status: AttendeeRow['status'];
    ticket_code: string | null;
    ticket_sent_at: string | null;
    needs_reissue: boolean;
  }>(sql`
    select a.registration_id, a.id, a.full_name, a.name_source, a.email,
           a.allocation_type, a.status, a.ticket_code, a.ticket_sent_at,
           a.needs_reissue
      from attendees a
      join shows s on s.id = a.show_id
     where s.concert_id = ${concertId}
       and a.deleted_at is null
     order by a.registration_id, a.id
  `);

  const grouped: Record<number, AttendeeRow[]> = {};
  for (const row of rows) {
    const key = Number(row.registration_id);
    (grouped[key] ??= []).push({
      id: Number(row.id),
      fullName: row.full_name,
      namePlaceholder: row.name_source === 'PLACEHOLDER',
      email: row.email,
      allocationType: row.allocation_type,
      status: row.status,
      ticketCode: row.ticket_code,
      ticketSentAt: row.ticket_sent_at === null ? null : new Date(row.ticket_sent_at),
      needsReissue: row.needs_reissue,
    });
  }
  return grouped;
}
