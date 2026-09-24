import type { Metadata } from 'next';
import { sql } from 'drizzle-orm';
import {
  CircleCheckIcon,
  ClockIcon,
  HourglassIcon,
  MailIcon,
  TicketIcon,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { getDb } from '@/db/client';
import { formatDateTime } from '@/lib/portal/format';
import { FormNotFound } from '../states';

/**
 * The confirmation screen (spec/v2.md §8.4).
 *
 * **It reports what the engine did, not what the form offered.** A submit that
 * lost the race against the cached seat indicator gets the segment's real state
 * back, and this is where that is said out loud: base and extra broken out,
 * anything held for review or waitlisted named, and never a silent short grant
 * (§8.3).
 *
 * Reached by `edit_token`, which the submit action mints. It is unguessable and
 * it is the same key the edit screen uses, so a registrant who keeps the link
 * from their confirmation email can come back to it while `allow_edit_until`
 * holds (§8.3.1).
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Registration received',
  robots: { index: false, follow: false },
};

type Row = {
  contact_name: string;
  contact_email: string;
  status: string;
  confirmed_base: number;
  confirmed_extra: number;
  pending: number;
  waitlisted: number;
  show_name: string;
  starts_at: string | null;
  venue: string | null;
  timezone: string | null;
  confirmation_message_md: string | null;
};

export default async function RegistrationDonePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ r?: string | string[] }>;
}) {
  await params;
  const query = await searchParams;
  const editToken = typeof query.r === 'string' ? query.r : null;

  /**
   * The same shape guard the other tokenised reads use: without it a `%00`
   * reaches a parameterised query and Postgres raises `22021`, which is a 500
   * with an empty body on a public route.
   */
  if (editToken === null || !/^[A-Za-z0-9_-]{1,128}$/.test(editToken)) return <FormNotFound />;

  const rows = await getDb().execute<Row>(sql`
    select
      r.contact_name,
      r.contact_email,
      r.status::text as status,
      -- Counted from the seats themselves rather than carried from the claim
      -- outcome: a refresh an hour later should show what the party holds now,
      -- including anything an admin has since granted or cancelled.
      count(*) filter (
        where a.status = 'CONFIRMED' and a.allocation_type = 'BASE')::int as confirmed_base,
      count(*) filter (
        where a.status = 'CONFIRMED' and a.allocation_type <> 'BASE')::int as confirmed_extra,
      count(*) filter (where a.status = 'PENDING_REVIEW')::int as pending,
      count(*) filter (where a.status = 'WAITLIST')::int as waitlisted,
      s.name as show_name,
      s.starts_at::text as starts_at,
      s.venue_name as venue,
      c.timezone,
      f.confirmation_message_md
    from form_responses fr
    join registrations r on r.form_response_id = fr.id
    join registration_forms f on f.id = fr.form_id
    join shows s on s.id = r.show_id
    join concerts c on c.id = s.concert_id
    left join attendees a on a.registration_id = r.id and a.deleted_at is null
    where fr.edit_token = ${editToken}
      and r.deleted_at is null
    group by r.contact_name, r.contact_email, r.status, s.name, s.starts_at, s.venue_name,
             c.timezone, f.confirmation_message_md
    limit 1
  `);

  const row = rows[0];
  if (!row) return <FormNotFound />;

  const confirmed = Number(row.confirmed_base) + Number(row.confirmed_extra);
  const pending = Number(row.pending);
  const waitlisted = Number(row.waitlisted);
  const showTime = formatDateTime(
    row.starts_at ? new Date(row.starts_at) : null,
    row.timezone,
  );

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-primary">
          <CircleCheckIcon className="size-5" aria-hidden />
          <span className="text-sm font-medium">Registration received</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-balance">
          Thank you, {row.contact_name}
        </h1>
        {row.confirmation_message_md ? (
          <p className="text-sm text-muted-foreground">{row.confirmation_message_md}</p>
        ) : null}
      </header>

      <ItemGroup className="gap-2">
        {confirmed > 0 ? (
          <Item variant="outline">
            <ItemMedia variant="icon">
              <TicketIcon />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>
                {confirmed} seat{confirmed === 1 ? '' : 's'} confirmed
              </ItemTitle>
              {/*
                Base and extra broken out, as §8.4 asks — but only where both
                exist. "4 confirmed (0 base, 4 extra)" on a public form is noise
                about a distinction the reader does not have.
              */}
              {Number(row.confirmed_base) > 0 && Number(row.confirmed_extra) > 0 ? (
                <ItemDescription>
                  {row.confirmed_base} from your allocation, {row.confirmed_extra} additional
                </ItemDescription>
              ) : null}
            </ItemContent>
          </Item>
        ) : null}

        {pending > 0 ? (
          <Item variant="outline">
            <ItemMedia variant="icon">
              <HourglassIcon />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>
                {pending} seat{pending === 1 ? '' : 's'} awaiting review
              </ItemTitle>
              <ItemDescription>
                Additional seats are allocated after the deadline. We will email you either way.
              </ItemDescription>
            </ItemContent>
          </Item>
        ) : null}

        {waitlisted > 0 ? (
          <Item variant="outline">
            <ItemMedia variant="icon">
              <ClockIcon />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>
                {waitlisted} seat{waitlisted === 1 ? '' : 's'} waitlisted
              </ItemTitle>
              <ItemDescription>
                There was not room for {waitlisted === 1 ? 'this one' : 'these'} when you submitted.
                We will be in touch if a seat frees up.
              </ItemDescription>
            </ItemContent>
          </Item>
        ) : null}
      </ItemGroup>

      {/*
        The honest line when the engine granted less than the form offered. The
        counts above already say what happened; this says it is not a mistake,
        because a reader who asked for four and sees two needs to know which of
        the two numbers is real (§8.3).
      */}
      {confirmed === 0 ? (
        <Alert>
          <ClockIcon />
          <AlertTitle>No seats were confirmed</AlertTitle>
          <AlertDescription>
            Your registration is recorded and holds its place in the queue. Nothing further is
            needed from you.
          </AlertDescription>
        </Alert>
      ) : null}

      <Alert>
        <MailIcon />
        <AlertTitle>Your tickets go to {row.contact_email}</AlertTitle>
        <AlertDescription>
          Check the spelling — tickets are sent to this address, and it is the only way we can reach
          you.
          {showTime ? ` ${row.show_name} is on ${showTime}${row.venue ? `, ${row.venue}` : ''}.` : ''}
        </AlertDescription>
      </Alert>
    </div>
  );
}
