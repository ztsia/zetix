import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { requireAdmin } from '@/lib/auth/guards';
import { Button } from '@/components/ui/button';
import { DeliveryTable, type DeliveryRow } from './delivery-table';

export const metadata: Metadata = { title: 'Ticket delivery' };

/**
 * `/admin/concerts/{id}/email/delivery` — where `ticket_sent_at` is corrected
 * by hand (spec/email.md §11.6).
 *
 * It lives in the Email section rather than on module `D`'s tickets screen for
 * two reasons: the column it edits is the dedup key for blasts, and the tickets
 * screen belongs to another module (modules.md §4).
 */
export default async function DeliveryPage({ params }: { params: Promise<{ concertId: string }> }) {
  await requireAdmin();

  const { concertId: rawConcertId } = await params;
  const concertId = Number(rawConcertId);
  if (!Number.isInteger(concertId) || concertId <= 0) notFound();

  const db = getDb();
  const concerts = await db.execute<{ name: string; timezone: string }>(sql`
    select name, timezone from concerts where id = ${concertId} and deleted_at is null
  `);
  if (concerts.length === 0) notFound();

  const rows = await db.execute<{
    id: string;
    full_name: string;
    contact_name: string | null;
    contact_email: string;
    show_name: string;
    segment_name: string;
    ticket_code: string | null;
    ticket_sent_at: string | null;
    ticket_sent_source: 'EMAIL' | 'MANUAL' | null;
  }>(sql`
    select a.id, a.full_name, r.contact_name, r.contact_email,
           s.name as show_name, seg.name as segment_name,
           a.ticket_code, a.ticket_sent_at, a.ticket_sent_source
      from attendees a
      join registrations r on r.id = a.registration_id
      join shows s on s.id = a.show_id
      join show_segments seg on seg.id = a.segment_id
     where s.concert_id = ${concertId}
       and a.status = 'CONFIRMED'
       and a.deleted_at is null
     order by s.starts_at, r.requested_at, a.id
  `);

  const data: DeliveryRow[] = rows.map((row) => ({
    id: Number(row.id),
    fullName: row.full_name,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    showName: row.show_name,
    segmentName: row.segment_name,
    ticketCode: row.ticket_code,
    ticketSentAt: row.ticket_sent_at,
    ticketSentSource: row.ticket_sent_source,
  }));

  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Ticket delivery</h1>
          <p className="text-muted-foreground text-sm">
            {concerts[0].name} — record a delivery that happened outside the system, or put a ticket
            back in the queue.
          </p>
        </div>
        <Button variant="outline" render={<Link href={`/admin/concerts/${concertId}/email`} />}>
          Back to blast
        </Button>
      </header>

      <DeliveryTable rows={data} timezone={concerts[0].timezone} />
    </div>
  );
}
