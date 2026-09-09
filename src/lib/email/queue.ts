import 'server-only';

import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { rethrowDbError } from '@/db/errors';
import { escapeMergeValues, renderTemplate, type MergeContext } from './render';

/**
 * Queueing a blast, and the three mechanisms that make pressing Send twice
 * harmless (spec/email.md §11.4, decision 16).
 *
 * All three are required and none is sufficient alone:
 *
 * 1. **`attendees.ticket_sent_at` is the dedup key**, set only on confirmed
 *    delivery — never on queueing.
 * 2. **Queueing is a filtered insert**, whose `exists` clause selects
 *    *registrations that still hold an undelivered seat*, because a message is
 *    addressed to a registrant and carries the whole party's outstanding
 *    tickets (decision 22).
 * 3. **The partial unique index** on `(registration_id, template_key) where
 *    status in ('DRAFT','QUEUED','SENDING')` is what makes the
 *    `on conflict do nothing` mean anything.
 *
 * `tests/email/idempotency.test.ts` was written before this file and is the
 * primary test case `CLAUDE.md` names.
 */

export type BlastSplit = {
  confirmedAttendees: number;
  alreadySent: number;
  pendingAttendees: number;
  /** How many *messages* a blast would queue — the number that matters. */
  pendingRegistrations: number;
  failedRetryable: number;
};

export type BlastTarget = { segmentId: number; templateKey: string };

/**
 * The eligibility predicate, written once.
 *
 * Both the count on the blast screen and the insert that follows it must mean
 * the same thing by "pending", or the admin confirms against a number the blast
 * does not act on. §11.4 requires the split to be shown before anything is
 * queued, which is only useful if the two agree.
 */
const HAS_UNDELIVERED_SEAT = sql`
  exists (
    select 1 from attendees a
     where a.registration_id = r.id
       and a.status = 'CONFIRMED'
       and a.ticket_sent_at is null
       and a.deleted_at is null
  )
`;

const IS_LIVE_REGISTRATION = sql`
  r.status = 'CONFIRMED' and r.deleted_at is null
`;

/**
 * The numbers §11.4 requires on screen before anything is queued.
 *
 * Reads only. An admin who is shown a split and then queues a different set has
 * been told a lie, so this shares its predicate with {@link queueBlast} above
 * rather than restating it.
 */
export async function blastSplit(target: BlastSplit extends never ? never : BlastTarget): Promise<BlastSplit> {
  try {
    const rows = await getDb().execute<{
      confirmed_attendees: number;
      already_sent: number;
      pending_attendees: number;
      pending_registrations: number;
      failed_retryable: number;
    }>(sql`
      select
        (select count(*)::int from attendees a
           join registrations r on r.id = a.registration_id
          where a.segment_id = ${target.segmentId}
            and a.status = 'CONFIRMED' and a.deleted_at is null
            and ${IS_LIVE_REGISTRATION}) as confirmed_attendees,
        (select count(*)::int from attendees a
           join registrations r on r.id = a.registration_id
          where a.segment_id = ${target.segmentId}
            and a.status = 'CONFIRMED' and a.deleted_at is null
            and a.ticket_sent_at is not null
            and ${IS_LIVE_REGISTRATION}) as already_sent,
        (select count(*)::int from attendees a
           join registrations r on r.id = a.registration_id
          where a.segment_id = ${target.segmentId}
            and a.status = 'CONFIRMED' and a.deleted_at is null
            and a.ticket_sent_at is null
            and ${IS_LIVE_REGISTRATION}) as pending_attendees,
        (select count(*)::int from registrations r
          where r.segment_id = ${target.segmentId}
            and ${IS_LIVE_REGISTRATION}
            and ${HAS_UNDELIVERED_SEAT}) as pending_registrations,
        (select count(*)::int from email_outbox o
           join registrations r on r.id = o.registration_id
          where r.segment_id = ${target.segmentId}
            and o.template_key = ${target.templateKey}
            and o.status = 'FAILED') as failed_retryable
    `);

    const row = rows[0];
    return {
      confirmedAttendees: row?.confirmed_attendees ?? 0,
      alreadySent: row?.already_sent ?? 0,
      pendingAttendees: row?.pending_attendees ?? 0,
      pendingRegistrations: row?.pending_registrations ?? 0,
      failedRetryable: row?.failed_retryable ?? 0,
    };
  } catch (error) {
    rethrowDbError(error);
  }
}

export class MissingTemplateError extends Error {
  constructor(readonly key: string) {
    super(`No email template with key "${key}".`);
    this.name = 'MissingTemplateError';
  }
}

type Recipient = {
  registrationId: number;
  contactName: string | null;
  context: MergeContext;
};

/** Everything a message needs about its recipient, in one query. */
async function loadRecipients(target: BlastTarget): Promise<Recipient[]> {
  const rows = await getDb().execute<{
    registration_id: string;
    contact_name: string | null;
    contact_email: string;
    round_label: string | null;
    concert_name: string;
    show_name: string;
    starts_at: string;
    doors_open_at: string | null;
    venue_name: string | null;
    venue_address: string | null;
    segment_name: string;
    timezone: string;
    attendee_count: number;
    attendee_names: string[];
    qr_tokens: string[];
  }>(sql`
    select r.id as registration_id, r.contact_name, r.contact_email, r.round_label,
           c.name as concert_name, c.timezone,
           s.name as show_name, s.starts_at, s.doors_open_at, s.venue_name, s.venue_address,
           seg.name as segment_name,
           counts.attendee_count, counts.attendee_names, counts.qr_tokens
      from registrations r
      join show_segments seg on seg.id = r.segment_id
      join shows s on s.id = r.show_id
      join concerts c on c.id = s.concert_id
      join lateral (
        select count(*)::int as attendee_count,
               array_agg(a.full_name order by a.id) as attendee_names,
               array_agg(a.qr_token order by a.id) as qr_tokens
          from attendees a
         where a.registration_id = r.id
           and a.status = 'CONFIRMED'
           and a.deleted_at is null
      ) counts on true
     where r.segment_id = ${target.segmentId}
       and ${IS_LIVE_REGISTRATION}
       and ${HAS_UNDELIVERED_SEAT}
     order by r.requested_at, r.id
  `);

  return rows.map((row) => ({
    registrationId: Number(row.registration_id),
    contactName: row.contact_name,
    context: {
      'concert.name': row.concert_name,
      'show.name': row.show_name,
      'show.starts_at': formatInZone(row.starts_at, row.timezone),
      'show.doors_open_at': formatInZone(row.doors_open_at, row.timezone),
      'show.venue_name': row.venue_name ?? '',
      'show.venue_address': row.venue_address ?? '',
      'segment.name': row.segment_name,
      'registration.contact_name': row.contact_name ?? '',
      'registration.contact_email': row.contact_email,
      'registration.round_label': row.round_label ?? '',
      attendee_count: String(row.attendee_count),
      attendee_names: (row.attendee_names ?? []).filter(Boolean).join(', '),
      ticket_links: (row.qr_tokens ?? [])
        .filter(Boolean)
        .map((token) => `${appUrl()}/t/${token}`)
        .join('\n'),
    },
  }));
}

/**
 * `APP_URL` read directly, for the same reason `src/lib/tickets/load.ts` does:
 * validating the whole environment here would make queueing a message require
 * the Supabase keys.
 */
function appUrl(): string {
  return process.env.APP_URL ?? '';
}

/**
 * Show times render in `concert.timezone`, never the viewer's
 * (spec/domain.md §6.1). An audience member travelling must see the time at the
 * venue.
 */
function formatInZone(value: string | null, timezone: string): string {
  if (!value) return '';
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: timezone,
  }).format(new Date(value));
}

/**
 * Renders each recipient's message and queues it as `DRAFT`.
 *
 * **Rendered, not a template reference** (decision 23): the admin reviews and
 * edits actual messages, and the dispatcher later sends `subject` and `body_md`
 * verbatim, so a template edit cannot change a message someone has approved.
 *
 * **Nothing is sent here, and `ticket_sent_at` is not touched.** Rows land in
 * `DRAFT` and only a human moves them out of it (§11.2).
 */
export async function queueBlast(target: BlastTarget): Promise<{ queued: number; unknownTokens: string[] }> {
  const db = getDb();

  const templates = await db.execute<{ subject: string; body_md: string }>(sql`
    select subject, body_md from email_templates where key = ${target.templateKey}
  `);
  const template = templates[0];
  if (!template) throw new MissingTemplateError(target.templateKey);

  const recipients = await loadRecipients(target);
  if (recipients.length === 0) return { queued: 0, unknownTokens: [] };

  const unknownTokens = new Set<string>();
  const rendered = recipients.map((recipient) => {
    // Escaped for the HTML half; the stored Markdown keeps the escaped form so
    // what the admin reviews is what is converted at send time.
    const context = escapeMergeValues(recipient.context);
    const subject = renderTemplate(template.subject, context);
    const body = renderTemplate(template.body_md, context);
    for (const token of [...subject.unknown, ...body.unknown]) unknownTokens.add(token);
    return { recipient, subject: subject.text, bodyMd: body.text };
  });

  try {
    /**
     * One row per recipient: `values ($1,$2,$3,$4), ($5,…)`.
     *
     * Module `C` shipped the failure this shape avoids — joining placeholders
     * bare gives one row of N columns, which Postgres accepts silently and
     * which only misbehaves past the first element. Its lesson was that a test
     * exercising a collection of one is not a test of the collection, so the
     * double-press test queues three parties, not one.
     */
    const values = sql.join(
      rendered.map(
        (r) =>
          sql`(${r.recipient.registrationId}::bigint, ${r.subject}::text, ${r.bodyMd}::text, ${JSON.stringify(r.recipient.context)}::jsonb)`,
      ),
      sql`, `,
    );

    /**
     * **The filtered insert of §11.4.** The eligibility predicate is re-applied
     * here rather than trusted from the select above: between loading the
     * recipients and inserting, a concurrent dispatch may have delivered one of
     * them. `on conflict do nothing` then covers the remaining race — two
     * simultaneous presses both reach this statement and the index lets exactly
     * one row through per (registration, template).
     *
     * **Be honest about what is proved.** Deleting the second `exists` leaves
     * every test in `idempotency.test.ts` green, because `loadRecipients()`
     * has already applied the same filter and nothing in a single-threaded test
     * runs between the two. It is defence against a race the test pool cannot
     * reach — `src/db/client.ts` is `max: 1`, so two `queueBlast()` calls
     * serialise — and it is kept because the cost is one index scan and the
     * failure it guards is a party emailed tickets it has already received.
     * The `on conflict` immediately below is the half that *is* covered:
     * removing it turns three tests red, as does dropping the index.
     */
    const inserted = await db.execute<{ id: string }>(sql`
      insert into email_outbox (
        registration_id, template_key, to_email, to_name, subject, body_md, context, status
      )
      select r.id, ${target.templateKey}, r.contact_email, r.contact_name,
             v.subject, v.body_md, v.context, 'DRAFT'
        from (values ${values}) as v(registration_id, subject, body_md, context)
        join registrations r on r.id = v.registration_id
       where ${IS_LIVE_REGISTRATION}
         and ${HAS_UNDELIVERED_SEAT}
      on conflict do nothing
      returning id
    `);

    return { queued: inserted.length, unknownTokens: [...unknownTokens] };
  } catch (error) {
    rethrowDbError(error);
  }
}
