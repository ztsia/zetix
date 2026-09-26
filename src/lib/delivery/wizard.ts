import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import type { Executor } from '@/db/allocation';
import { writeAuditLog } from '@/lib/audit';
import type { AudienceFilter } from '@/lib/audience/filter';
import { matchPartyIds } from '@/lib/audience/queries';
import { isFilterSelection, type Selection } from '@/lib/commands/selection';
import { addressIssue } from '@/lib/email/address';
import { partyRecipient } from '@/lib/email/queue';
import { escapeMergeValues, markdownToEmailHtml, markdownToPlainText, renderTemplate } from '@/lib/email/render';
import { carriesTickets, TEMPLATE_PURPOSE } from '@/lib/email/templates';
import { designForSegment, NoTicketDesignError } from '@/lib/tickets/design';
import { defaultTemplateFor } from './purposes';

/**
 * What the send wizard shows around the command's own preview
 * (spec/v3.md §24.1): the address checks the Who step runs, and for each
 * segment in the selection its default design and template, the longest name
 * to preview the design with, and who the email can be previewed as.
 *
 * The command still decides everything that is sent; this only lays out the
 * choices, and every default here is the default the command resolves.
 */

const idArray = (ids: number[]) => sql`${`{${ids.join(',')}}`}::bigint[]`;

/** The selection's parties in this concert, as the command would resolve them now. */
export async function selectedParties(
  executor: Executor,
  concertId: number,
  selection: Selection<AudienceFilter>,
): Promise<number[]> {
  if (isFilterSelection(selection)) {
    const excluded = new Set(selection.excludedIds);
    return (await matchPartyIds(executor, concertId, selection.filter)).filter((id) => !excluded.has(id));
  }
  if (selection.ids.length === 0) return [];
  const rows = await executor.execute<{ id: string }>(sql`
    select r.id from registrations r join shows s on s.id = r.show_id
     where r.id = any(${idArray([...new Set(selection.ids)])})
       and s.concert_id = ${concertId} and r.deleted_at is null
  `);
  return rows.map((row) => Number(row.id));
}

export type AddressCheckSummary = { checked: number; flagged: number; left: number };

/**
 * §24.6: the address check runs in the wizard's Who step, which is how a
 * party that arrived before V3 — never checked — is checked before its tickets
 * go out. Only parties never checked are looked up; a finding is stored
 * exactly as Check address stores it, so it raises `SUSPICIOUS_ADDRESS` and
 * the preview that follows skips the party with the reason.
 *
 * The MX lookup is a network call, so it runs outside any transaction, a few
 * at a time, within `budgetMs`; whatever is left is reported, not guessed.
 */
export async function checkUncheckedAddresses(
  concertId: number,
  partyIds: number[],
  options: { budgetMs: number; concurrency: number; actorId: string | null },
): Promise<AddressCheckSummary> {
  if (partyIds.length === 0) return { checked: 0, flagged: 0, left: 0 };
  const db = getDb();
  const rows = await db.execute<{ id: string; email: string }>(sql`
    select r.id, r.contact_email::text as email from registrations r
      join shows s on s.id = r.show_id
     where r.id = any(${idArray(partyIds)}) and s.concert_id = ${concertId}
       and r.deleted_at is null and r.contact_email is not null and r.email_checked_at is null
     order by r.id
  `);

  const deadline = Date.now() + options.budgetMs;
  let checked = 0;
  let flagged = 0;
  let next = 0;

  async function worker() {
    while (next < rows.length && Date.now() < deadline) {
      const row = rows[next++];
      const issue = await addressIssue(row.email);
      // Stored only if the address is still the one checked: an edit in the
      // meantime stored its own verdict.
      const updated = await db.execute(sql`
        update registrations
           set email_issue = ${issue}, email_checked_at = now()
         where id = ${Number(row.id)} and contact_email = ${row.email} and email_checked_at is null
        returning id
      `);
      if (updated.length === 0) continue;
      checked += 1;
      if (issue) {
        flagged += 1;
        await writeAuditLog({
          action: 'registration.address_flagged',
          entityType: 'registration',
          entityId: Number(row.id),
          after: { issue, by: 'send wizard' },
          actorId: options.actorId,
        });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency, rows.length) }, worker));
  return { checked, flagged, left: rows.length - checked };
}

export type WizardSegment = {
  id: number;
  label: string;
  audienceMode: 'PLAYER_INVITED' | 'PUBLIC';
  parties: number;
  defaultDesignId: number | null;
  defaultTemplate: string;
  /** The longest confirmed seat name among the selected parties, for the design preview. */
  longest: { attendeeId: number; name: string } | null;
};

export type WizardSetup = {
  segments: WizardSegment[];
  designs: { id: number; label: string }[];
  templates: { key: string; name: string; subject: string; bodyMd: string }[];
  /** Parties the email can be previewed as, first come first. */
  recipients: { id: number; label: string; segmentId: number }[];
};

/** A render limit on the "preview as" list, not an operational value. */
const RECIPIENTS_SHOWN = 100;

export async function wizardSetup(concertId: number, partyIds: number[]): Promise<WizardSetup> {
  const db = getDb();
  const ids = partyIds.length > 0 ? partyIds : [0];

  const segments = await db.execute<{
    id: string;
    label: string;
    audience_mode: 'PLAYER_INVITED' | 'PUBLIC';
    parties: number;
    stored_template: string | null;
    longest_id: string | null;
    longest_name: string | null;
  }>(sql`
    select g.id, s.name || ' · ' || g.name as label, g.audience_mode,
           count(distinct r.id)::int as parties, d.template_key as stored_template,
           l.id as longest_id, l.full_name as longest_name
      from registrations r
      join show_segments g on g.id = r.segment_id
      join shows s on s.id = g.show_id
      left join segment_message_defaults d
        on d.segment_id = g.id and d.purpose = 'TICKETS' and d.deleted_at is null
      left join lateral (
        select a.id, a.full_name from attendees a
         where a.segment_id = g.id and a.registration_id = any(${idArray(ids)})
           and a.status = 'CONFIRMED' and a.deleted_at is null
         order by length(a.full_name) desc, a.id
         limit 1
      ) l on true
     where r.id = any(${idArray(ids)}) and s.concert_id = ${concertId}
     group by g.id, s.name, g.name, g.audience_mode, d.template_key, l.id, l.full_name, s.starts_at
     order by s.starts_at nulls last, g.id
  `);

  const withDesigns: WizardSegment[] = [];
  for (const row of segments) {
    let defaultDesignId: number | null = null;
    try {
      defaultDesignId = (await designForSegment(db, Number(row.id))).id;
    } catch (error) {
      if (!(error instanceof NoTicketDesignError)) throw error;
    }
    withDesigns.push({
      id: Number(row.id),
      label: row.label,
      audienceMode: row.audience_mode,
      parties: row.parties,
      defaultDesignId,
      defaultTemplate: defaultTemplateFor('TICKETS', row.audience_mode, row.stored_template)!,
      longest: row.longest_id ? { attendeeId: Number(row.longest_id), name: row.longest_name ?? '' } : null,
    });
  }

  const designs = await db.execute<{ id: string; name: string; version: number; is_default: boolean }>(sql`
    select id, name, version, is_default from ticket_templates
     where concert_id = ${concertId} and deleted_at is null
     order by name, version desc
  `);

  const ticketKeys = Object.entries(TEMPLATE_PURPOSE)
    .filter(([, purpose]) => purpose === 'TICKETS')
    .map(([key]) => key);
  const templates = await db.execute<{ key: string; name: string; subject: string; body_md: string }>(sql`
    select key, name, subject, body_md from email_templates
     where key in (${sql.join(ticketKeys.map((key) => sql`${key}`), sql`, `)}) and deleted_at is null
     order by name
  `);

  const recipients = await db.execute<{ id: string; label: string; segment_id: string }>(sql`
    select r.id, r.contact_name as label, r.segment_id from registrations r
     where r.id = any(${idArray(ids)}) and r.deleted_at is null
     order by r.requested_at, r.id
     limit ${RECIPIENTS_SHOWN}
  `);

  return {
    segments: withDesigns,
    designs: designs.map((row) => ({
      id: Number(row.id),
      label: `${row.name} · v${row.version}${row.is_default ? ' (concert default)' : ''}`,
    })),
    templates: templates.map((row) => ({ key: row.key, name: row.name, subject: row.subject, bodyMd: row.body_md })),
    recipients: recipients.map((row) => ({ id: Number(row.id), label: row.label, segmentId: Number(row.segment_id) })),
  };
}

export type EmailPreview = {
  toEmail: string | null;
  subject: string;
  html: string;
  /** Merge fields the wording names that resolve to nothing. */
  unknown: string[];
  /** Seats whose links will appear only once this run issues them. */
  unissued: number;
};

/**
 * The email step's preview "as any recipient in the selection" (§24.1): the
 * wording as that party would read it, with the same merge values and the
 * same HTML the dispatcher sends. A seat not issued yet has no link until the
 * run issues it, and the preview says how many.
 */
export async function renderEmailPreview(
  concertId: number,
  registrationId: number,
  templateKey: string,
  wording: { subject: string; bodyMd: string } | null,
): Promise<EmailPreview | null> {
  const db = getDb();
  const [party] = await db.execute<{ email: string | null; unissued: number }>(sql`
    select r.contact_email::text as email,
           (select count(*)::int from attendees a
             where a.registration_id = r.id and a.status = 'CONFIRMED' and a.deleted_at is null
               and (a.qr_token is null or a.ticket_template_id is null)) as unissued
      from registrations r join shows s on s.id = r.show_id
     where r.id = ${registrationId} and s.concert_id = ${concertId} and r.deleted_at is null
  `);
  if (!party) return null;
  const [template] = await db.execute<{ subject: string; body_md: string }>(sql`
    select subject, body_md from email_templates where key = ${templateKey} and deleted_at is null
  `);
  if (!template) return null;

  const recipient = await partyRecipient(db, registrationId);
  if (!recipient) return null;
  const context = escapeMergeValues(recipient.context);
  const subject = renderTemplate(wording?.subject ?? template.subject, context);
  const body = renderTemplate(wording?.bodyMd ?? template.body_md, context);
  return {
    toEmail: party.email,
    subject: subject.text,
    html: markdownToEmailHtml(body.text, {
      preheader: markdownToPlainText(body.text).split('\n')[0],
      footer: carriesTickets(templateKey)
        ? 'Your ticket is the attached PDF. Show its QR code to the registration crew at the door — every guest needs their own.'
        : undefined,
    }),
    unknown: [...new Set([...subject.unknown, ...body.unknown])],
    unissued: party.unissued,
  };
}
