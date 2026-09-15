import 'server-only';

import { TZDate } from '@date-fns/tz';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { rethrowDbError } from '@/db/errors';
import { MissingSettingError } from '@/db/settings';
import { toNameCase } from '@/lib/names';
import { escapeMergeValues, renderTemplate } from './render';
import { MissingTemplateError, formatInZone, ticketLinks } from './queue';

/**
 * The post-show feedback blast (spec/v2.md §13.5.2).
 *
 * It is `queueBlast`'s sibling and deliberately not a parameter of it: four of
 * the things that define a blast are different here, and a flag for each would
 * make the ticket path — which carries the tickets — harder to read for the sake
 * of the path that carries a link.
 *
 * | | Ticket blast | Feedback blast |
 * |---|---|---|
 * | Target | one segment | one **show**, both its audiences |
 * | Audience | confirmed seats with no `ticket_sent_at` | seats with a **`check_ins` row** |
 * | Queued as | `DRAFT`, for review (decision 23) | **`QUEUED`** (decision 38) |
 * | Due | immediately | the next `portal.feedback_send_hour` |
 *
 * **One email per registration, carrying one link per admitted attendee.**
 * Decision 22 is unchanged: a party of four where three were admitted gets one
 * message with three links, the same shape as the ticket blast carrying N PDFs.
 * The no-show's link is simply not in it.
 */

/** §11.3's table gains a ninth row. Feedback carries no attachment (`TICKET_BEARING`). */
export const FEEDBACK_TEMPLATE_KEY = 'feedback_request';

export type FeedbackBlastResult = {
  queued: number;
  /** Registrations that already received one and were left alone. */
  alreadySent: number;
  unknownTokens: string[];
};

/**
 * When the queued rows become due: the next `portal.feedback_send_hour` in
 * `concert.timezone`, strictly in the future.
 *
 * **This gap is the review window, and it is the safety net decision 38 traded
 * the `DRAFT` gate for.** A show completed at 10:30pm with a send hour of noon
 * leaves thirteen hours in which a wrong template can be caught and the rows
 * `CANCELLED` — longer than the `DRAFT` gate gives in practice — and it is also
 * what stops anyone being emailed at 10:30pm.
 *
 * Exported for the tests, which should not have to reimplement it to check it.
 */
export function nextSendTime(input: {
  hour: number;
  timeZone: string;
  now: Date;
}): Date {
  const local = new TZDate(input.now, input.timeZone);
  const candidate = TZDate.tz(
    input.timeZone,
    local.getFullYear(),
    local.getMonth(),
    local.getDate(),
    input.hour,
    0,
    0,
    0,
  );

  /**
   * **Strictly future.** Completing a show at 2pm with a send hour of noon must
   * not make the rows due two hours ago — that is the 10:30pm email this exists
   * to prevent, only worse, because it would go the moment the next dispatch
   * ran.
   */
  if (candidate.getTime() > input.now.getTime()) return new Date(candidate.getTime());

  const tomorrow = TZDate.tz(
    input.timeZone,
    local.getFullYear(),
    local.getMonth(),
    local.getDate() + 1,
    input.hour,
    0,
    0,
    0,
  );
  return new Date(tomorrow.getTime());
}

/**
 * Queue the feedback email for one show.
 *
 * **Idempotent in two layers, and they cover different halves.**
 * `outbox_no_duplicate_pending` stops a second row while the first is still
 * `DRAFT`/`QUEUED`/`SENDING` — that is the double-press. The `already sent`
 * predicate below is the feedback analogue of `attendees.ticket_sent_at`: it
 * stops a *third* press, a week later, from mailing everyone a second time once
 * the first batch has left. Without it the pending index is no protection at
 * all, because a `SENT` row conflicts with nothing.
 *
 * A `FAILED` row is deliberately not covered: nothing retries it and it was
 * never delivered, so a re-run should pick it up.
 */
export async function queueFeedbackBlast(input: {
  showId: number;
  now?: Date;
}): Promise<FeedbackBlastResult> {
  const db = getDb();
  const now = input.now ?? new Date();

  const [context] = await db.execute<{
    concert_id: string;
    timezone: string | null;
    send_hour: unknown;
  }>(sql`
    select s.concert_id,
           c.timezone,
           resolve_setting('portal.feedback_send_hour', null, s.id, c.id) as send_hour
      from shows s
      join concerts c on c.id = s.concert_id
     where s.id = ${input.showId}
       and s.deleted_at is null
  `);
  if (!context) return { queued: 0, alreadySent: 0, unknownTokens: [] };

  /**
   * **Both are refusals, not defaults** (spec/README.md §2.1). Without a zone
   * there is no such thing as "noon", and the only fallback available —
   * `scheduled_for` null, which the dispatcher reads as due now — is exactly the
   * 10:30pm email the send hour exists to prevent. A concert with no timezone
   * cannot render a show time either, so this is the same configuration error
   * surfacing in a second place.
   */
  if (!context.timezone) throw new MissingSettingError('concert.timezone');
  const hour = Number(context.send_hour);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new MissingSettingError('portal.feedback_send_hour');
  }

  const scheduledFor = nextSendTime({ hour, timeZone: context.timezone, now });

  const templates = await db.execute<{ subject: string; body_md: string }>(sql`
    select subject, body_md from email_templates where key = ${FEEDBACK_TEMPLATE_KEY}
  `);
  const template = templates[0];
  if (!template) throw new MissingTemplateError(FEEDBACK_TEMPLATE_KEY);

  const recipients = await loadFeedbackRecipients(input.showId);
  if (recipients.length === 0) {
    return { queued: 0, alreadySent: await countAlreadySent(input.showId), unknownTokens: [] };
  }

  const unknownTokens = new Set<string>();
  const rendered = recipients.map((recipient) => {
    const context_ = escapeMergeValues(recipient.context);
    const subject = renderTemplate(template.subject, context_);
    const body = renderTemplate(template.body_md, context_);
    for (const token of [...subject.unknown, ...body.unknown]) unknownTokens.add(token);
    return { recipient, subject: subject.text, bodyMd: body.text };
  });

  try {
    const values = sql.join(
      rendered.map(
        (r) =>
          sql`(${r.recipient.registrationId}::bigint, ${r.subject}::text, ${r.bodyMd}::text, ${JSON.stringify(r.recipient.context)}::jsonb, ${
            r.recipient.contactName ? toNameCase(r.recipient.contactName) : null
          }::text)`,
      ),
      sql`, `,
    );

    const inserted = await db.execute<{ id: string }>(sql`
      insert into email_outbox (
        registration_id, template_key, to_email, to_name, subject, body_md, context,
        status, scheduled_for
      )
      select r.id, ${FEEDBACK_TEMPLATE_KEY}, r.contact_email, v.to_name,
             v.subject, v.body_md, v.context,
             -- QUEUED, not DRAFT: decision 38 narrows decision 23 for this one
             -- message. It carries no attachment, no per-person merge beyond a
             -- name and a link, and nothing irreplaceable -- and the real
             -- review window is the gap between queueing now and sending at
             -- portal.feedback_send_hour, which is longer than the DRAFT gate
             -- gives in practice.
             -- Bound as an ISO string with an explicit cast: the driver will
             -- not bind a JS Date, and an untyped string would be inferred as
             -- text against a timestamptz column.
             'QUEUED', ${scheduledFor.toISOString()}::timestamptz
        from (values ${values}) as v(registration_id, subject, body_md, context, to_name)
        join registrations r on r.id = v.registration_id
       where r.status = 'CONFIRMED'
         and r.deleted_at is null
         and ${NOT_ALREADY_SENT}
      on conflict do nothing
      returning id
    `);

    return {
      queued: inserted.length,
      alreadySent: await countAlreadySent(input.showId),
      unknownTokens: [...unknownTokens],
    };
  } catch (error) {
    rethrowDbError(error);
  }
}

/**
 * The feedback analogue of `attendees.ticket_sent_at` — see
 * {@link queueFeedbackBlast}. Alias `r` is `registrations`.
 */
const NOT_ALREADY_SENT = sql`
  not exists (
    select 1 from email_outbox o
     where o.registration_id = r.id
       and o.template_key = ${FEEDBACK_TEMPLATE_KEY}
       and o.status = 'SENT'
  )
`;

async function countAlreadySent(showId: number): Promise<number> {
  const rows = await getDb().execute<{ n: number }>(sql`
    select count(*)::int as n
      from email_outbox o
      join registrations r on r.id = o.registration_id
     where r.show_id = ${showId}
       and o.template_key = ${FEEDBACK_TEMPLATE_KEY}
       and o.status = 'SENT'
  `);
  return rows[0]?.n ?? 0;
}

type FeedbackRecipient = {
  registrationId: number;
  contactName: string | null;
  context: Record<string, string>;
};

/**
 * **Admitted only, computed now** (§13.5.1).
 *
 * The audience is attendees with a live `check_ins` row. No new state is needed
 * — a scan happened or it did not — and **a manual or override admission
 * counts**, because `checkin.md` §12.1 writes a `check_ins` row for an
 * admit-by-name and for an amber/red override alike, and those people were in
 * the hall. Scoping feedback to clean scans would punish the guest whose PDF
 * would not load.
 *
 * **The list is built at send time, never frozen at completion time.** An
 * usher's phone that stayed offline all evening may not drain its queue until
 * the next morning (`checkin.manifest_ttl_hours` is 12), and a list frozen two
 * hours after the show would silently omit everyone on that device. Nobody would
 * ever find out — which is why this is a query and not a stored audience.
 *
 * A reverted admission does not count: `check_ins` is append-only and a revert
 * stamps `reverted_at` rather than deleting (decision 7), so the same
 * `reverted_at is null` filter the portal uses applies here. An admin who undid
 * a mis-scan should not have emailed that person about an evening they never
 * attended.
 */
async function loadFeedbackRecipients(showId: number): Promise<FeedbackRecipient[]> {
  const rows = await getDb().execute<{
    registration_id: string;
    contact_name: string | null;
    contact_email: string;
    concert_name: string;
    show_name: string;
    starts_at: string | null;
    timezone: string;
    admitted_count: number;
    link_names: string[] | null;
    qr_tokens: string[] | null;
  }>(sql`
    select r.id as registration_id, r.contact_name, r.contact_email,
           c.name as concert_name, c.timezone,
           s.name as show_name, s.starts_at,
           admitted.admitted_count, admitted.link_names, admitted.qr_tokens
      from registrations r
      join shows s on s.id = r.show_id
      join concerts c on c.id = s.concert_id
      join lateral (
        select count(*)::int as admitted_count,
               -- Both aggregates carry the same filter and the same ordering,
               -- because ticketLinks zips them by index: filtering one and not
               -- the other puts every later link under the wrong guest's name.
               -- A seat with no qr_token is excluded in SQL, before the array
               -- crosses the wire, because postgres.js reads a NULL element of
               -- a text array back as the string "NULL" -- indistinguishable
               -- from a real token, and mailed out as a live-looking dead link.
               array_agg(a.full_name order by a.id)
                 filter (where a.qr_token is not null) as link_names,
               array_agg(a.qr_token order by a.id)
                 filter (where a.qr_token is not null) as qr_tokens
          from attendees a
         where a.registration_id = r.id
           and a.status = 'CONFIRMED'
           and a.deleted_at is null
           and exists (
             select 1 from check_ins k
              where k.attendee_id = a.id
                and k.reverted_at is null
           )
      ) admitted on true
     where r.show_id = ${showId}
       and r.status = 'CONFIRMED'
       and r.deleted_at is null
       -- A party where nobody came gets no email. The lateral always returns a
       -- row, so this is the filter that makes the blast admitted-only.
       and admitted.admitted_count > 0
       and ${NOT_ALREADY_SENT}
     order by r.requested_at, r.id
  `);

  return rows.map((row) => ({
    registrationId: Number(row.registration_id),
    contactName: row.contact_name,
    context: {
      'concert.name': row.concert_name,
      'show.name': row.show_name,
      'show.starts_at': formatInZone(row.starts_at, row.timezone),
      'registration.contact_name': toNameCase(row.contact_name ?? ''),
      'registration.contact_email': row.contact_email,
      admitted_count: String(row.admitted_count),
      /**
       * Reuses the ticket blast's link builder, which already zips names to
       * tokens, checks each token against its *shape* rather than truthiness,
       * and emits a Markdown list so the links survive both halves of the
       * message. The URL is the same `/t/{token}` — a feedback email points at
       * the portal, where the form now sits first (§13.3).
       */
      feedback_links: ticketLinks((row.link_names ?? []).map(toNameCase), row.qr_tokens),
    },
  }));
}
