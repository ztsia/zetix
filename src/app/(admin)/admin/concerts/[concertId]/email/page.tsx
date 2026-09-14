import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { requireAdmin } from '@/lib/auth/guards';
import { blastSplit } from '@/lib/email/queue';
import { TEMPLATE_KEYS, carriesTickets } from '@/lib/email/templates';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty';
import { BlastControls } from './blast-controls';
import { OutboxTable, type OutboxRow } from './outbox-table';

export const metadata: Metadata = { title: 'Email' };

/**
 * `/admin/concerts/{id}/email` — the blast screen (spec/email.md §11.4).
 *
 * **The split is shown before anything is queued**, and the numbers are the
 * ones the blast will act on: `blastSplit()` and `queueBlast()` share their
 * eligibility predicate, so an admin who confirms against these figures is
 * confirming against the real set.
 *
 * **The page guards itself with `requireAdmin()`.** The layout above does too,
 * but a page that relies on an ancestor breaks silently when the ancestor
 * changes (decision 20, modules.md §5.2.1).
 */
type Search = { segment?: string; template?: string };

export default async function EmailPage({
  params,
  searchParams,
}: {
  params: Promise<{ concertId: string }>;
  searchParams: Promise<Search>;
}) {
  await requireAdmin();

  const { concertId: rawConcertId } = await params;
  const concertId = Number(rawConcertId);
  if (!Number.isInteger(concertId) || concertId <= 0) notFound();

  const search = await searchParams;
  const db = getDb();

  const concerts = await db.execute<{ name: string; timezone: string }>(sql`
    select name, timezone from concerts where id = ${concertId} and deleted_at is null
  `);
  if (concerts.length === 0) notFound();
  const concert = concerts[0];

  const segments = await db.execute<{
    id: string;
    name: string;
    audience_mode: string;
    show_name: string;
  }>(sql`
    select seg.id, seg.name, seg.audience_mode, s.name as show_name
      from show_segments seg
      join shows s on s.id = seg.show_id
     where s.concert_id = ${concertId} and s.deleted_at is null
     order by s.starts_at, seg.display_order, seg.id
  `);

  if (segments.length === 0) {
    return (
      <div className="p-6">
        <Empty>
          <EmptyTitle>No segments yet</EmptyTitle>
          <EmptyDescription>
            Email is addressed per registration within a segment. Create a show and a segment first.
          </EmptyDescription>
        </Empty>
      </div>
    );
  }

  const segmentId = Number(search.segment ?? segments[0].id);
  const segment = segments.find((s) => Number(s.id) === segmentId) ?? segments[0];
  const templateKey = TEMPLATE_KEYS.includes(search.template as never)
    ? (search.template as string)
    : 'public_ticket';

  const split = await blastSplit({ segmentId: Number(segment.id), templateKey });

  /**
   * §11.4's "Round attribution": `registrations.round_label` is copied from the
   * form that captured the booking "so the blast screen, exports and reports can
   * group by round without inferring it from timestamps". The spec's own example
   * of this screen is headed `Player invited · Round 2`, and a second blast that
   * cannot say which round it is addressing is the one an admin most needs to
   * read carefully.
   */
  const rounds = await db.execute<{ round_label: string | null; pending: number }>(sql`
    select r.round_label, count(*)::int as pending
      from registrations r
     where r.segment_id = ${Number(segment.id)}
       and r.status = 'CONFIRMED'
       and r.deleted_at is null
       and exists (
         select 1 from attendees a
          where a.registration_id = r.id
            and a.status = 'CONFIRMED'
            and a.ticket_sent_at is null
            and a.deleted_at is null)
     group by r.round_label
     order by r.round_label nulls last
  `);

  const outbox = await db.execute<{
    id: string;
    to_email: string;
    to_name: string | null;
    subject: string;
    body_md: string;
    status: OutboxRow['status'];
    attempts: number;
    last_error: string | null;
    sent_at: string | null;
  }>(sql`
    select o.id, o.to_email, o.to_name, o.subject, o.body_md, o.status,
           o.attempts, o.last_error, o.sent_at
      from email_outbox o
      join registrations r on r.id = o.registration_id
     where r.segment_id = ${Number(segment.id)} and o.template_key = ${templateKey}
     order by o.created_at, o.id
  `);

  const rows: OutboxRow[] = outbox.map((row) => ({
    id: Number(row.id),
    toEmail: row.to_email,
    toName: row.to_name,
    subject: row.subject,
    bodyMd: row.body_md,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    sentAt: row.sent_at,
  }));

  const drafts = rows.filter((r) => r.status === 'DRAFT').length;
  const queued = rows.filter((r) => r.status === 'QUEUED').length;

  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Email</h1>
          <p className="text-muted-foreground text-sm">
            {concert.name} — messages are addressed per registration, never per seat.
          </p>
        </div>
        <Button variant="outline" render={<Link href={`/admin/concerts/${concertId}/email/templates`} />}>
          Edit templates
        </Button>
      </header>

      <div className="flex flex-wrap gap-2">
        {segments.map((s) => (
          <Button
            key={s.id}
            size="sm"
            variant={Number(s.id) === Number(segment.id) ? 'default' : 'outline'}
            render={
              <Link href={`/admin/concerts/${concertId}/email?segment=${s.id}&template=${templateKey}`} />
            }
          >
            {s.show_name} · {s.name}
          </Button>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        {TEMPLATE_KEYS.map((key) => (
          <Button
            key={key}
            size="sm"
            variant={key === templateKey ? 'secondary' : 'ghost'}
            render={
              <Link href={`/admin/concerts/${concertId}/email?segment=${segment.id}&template=${key}`} />
            }
          >
            {key}
            {carriesTickets(key) ? <Badge variant="outline">tickets</Badge> : null}
          </Button>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {segment.name} · {templateKey}
            {rounds.length > 0 ? (
              <span className="text-muted-foreground ml-2 font-normal">
                ·{' '}
                {rounds
                  .map((r) => `${r.round_label ?? 'No round'} (${r.pending})`)
                  .join(', ')}
              </span>
            ) : null}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {/*
            §11.4's split, in the spec's own order. `pending` is the number the
            blast acts on, and it counts *seats*; the button below counts
            messages, because one party is one email (decision 22).
          */}
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Confirmed attendees" value={split.confirmedAttendees} />
            <Stat label="Already sent (excluded)" value={split.alreadySent} />
            <Stat label="Pending — this blast" value={split.pendingAttendees} emphasis />
            <Stat label="Failed, retryable" value={split.failedRetryable} />
          </dl>

          <p className="text-muted-foreground text-sm">
            {split.pendingRegistrations} message(s) would be prepared — one per party, carrying every
            ticket that party holds.
          </p>

          {/*
            The excluded parties, named rather than left as a gap between two
            numbers. A message is rendered when it is prepared and sent verbatim
            (decision 23), so a party queued before its tickets exist cannot be
            repaired by issuing them afterwards — the draft has to be discarded
            and prepared again. Holding them back is the fix; saying so is what
            stops it reading as a broken blast.
          */}
          {split.unissuedAttendees > 0 ? (
            <Alert>
              <AlertTitle>
                {split.unissuedRegistrations} part{split.unissuedRegistrations === 1 ? 'y is' : 'ies are'} waiting
                for tickets — {split.unissuedAttendees} seat(s) not yet issued
              </AlertTitle>
              <AlertDescription>
                They are excluded from this blast. Issue their tickets, then prepare again — a message
                prepared now would go out without their links.
              </AlertDescription>
            </Alert>
          ) : null}

          {!carriesTickets(templateKey) ? (
            <Alert>
              <AlertTitle>This template carries no tickets</AlertTitle>
              <AlertDescription>
                §11.3 makes this a text-only message, so nothing is attached and no ticket is marked
                delivered by sending it.
              </AlertDescription>
            </Alert>
          ) : null}

          <BlastControls
            segmentId={Number(segment.id)}
            templateKey={templateKey}
            drafts={drafts}
            queued={queued}
            pendingRegistrations={split.pendingRegistrations}
          />
        </CardContent>
      </Card>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Messages</h2>
        <p className="text-muted-foreground text-sm">
          Every message is shown as it will be sent. The dispatcher sends this text verbatim.
        </p>
        <OutboxTable rows={rows} timezone={concert.timezone} />
      </section>
    </div>
  );
}

function Stat({ label, value, emphasis }: { label: string; value: number; emphasis?: boolean }) {
  return (
    <div>
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className={emphasis ? 'text-2xl font-semibold' : 'text-2xl'}>{value}</dd>
    </div>
  );
}
