import 'server-only';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  defineCommand,
  SkipItem,
  type AnyCommand,
  type BlastLine,
  type CommandContext,
  type RunContext,
  type TargetRow,
  type Tx,
} from '@/lib/commands/define';
import { idSchema } from '@/lib/commands/selection';
import { audienceFilterSchema } from '@/lib/audience/filter';
import { matchPartyIds } from '@/lib/audience/queries';
import { partyRecipient } from '@/lib/email/queue';
import { escapeMergeValues, renderTemplate } from '@/lib/email/render';
import { draftSuperseding, MessageInFlightError } from '@/lib/email/supersede';
import { TEMPLATE_PURPOSE } from '@/lib/email/templates';
import { toNameCase } from '@/lib/names';
import { chosenDesign, designForSegment } from '@/lib/tickets/design';
import { mintIdentifiers } from '@/lib/tickets/mint';
import { deliveryFacts, type DeliveryFacts } from './facts';
import { defaultTemplateFor } from './purposes';

/**
 * Delivery — spec/v3.md §23.2, §24.1: **Send tickets**, **Resend**, **Mark
 * delivered by hand** and **Cancel sending**, each a command over the Audience
 * workspace's party selection.
 *
 * Send tickets is the one the wizard runs. Per party, in the party's own
 * transaction: issue any confirmed seat that has no ticket (so the run
 * finishes the job, §20.1), render the message after issuing so its links
 * include every seat, and queue it — superseding whatever ticket email was
 * pending (§24.2). The wizard is the review decision 23 asks for, so the
 * message is `QUEUED`, not `DRAFT` (decision 48).
 *
 * **Pressing it twice sends once.** A party whose pending ticket email already
 * says what this run would say is skipped, and every other pending one is
 * superseded, never sent beside the new one. The dispatcher's stamping
 * (`ticket_sent_at`, set only on delivery) and the pending index are the rest
 * of V1's guarantee (§11.4), unchanged.
 */

const templateKeySchema = z.string().min(1).max(100);
const wordingSchema = z
  .object({ subject: z.string().trim().min(1).max(500), bodyMd: z.string().trim().min(1).max(50_000) })
  .strict();

/**
 * The wizard's choices. Keys are segment ids (JSON object keys are strings):
 * a design and a template per segment, and this send's own wording per
 * template, which changes this run's messages and never the library (§24.1).
 */
export const sendParams = z
  .object({
    designs: z.record(z.string().regex(/^\d+$/), idSchema).default({}),
    templates: z.record(z.string().regex(/^\d+$/), templateKeySchema).default({}),
    wording: z.record(templateKeySchema, wordingSchema).default({}),
  })
  .strict();

export type SendParams = z.infer<typeof sendParams>;

type Mode = 'send' | 'resend';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The template this party's message will be worded with. */
export function ticketTemplateFor(party: DeliveryFacts, params: SendParams): string {
  return (
    params.templates[String(party.segmentId)] ??
    defaultTemplateFor('TICKETS', party.audienceMode, party.segmentTicketTemplate)!
  );
}

const hasOverrides = (party: DeliveryFacts, params: SendParams) =>
  params.designs[String(party.segmentId)] !== undefined ||
  params.wording[ticketTemplateFor(party, params)] !== undefined;

/**
 * Why a party cannot be sent its tickets, in the order an admin would fix
 * them, or null. The Who step shows these (§24.1); the run asks again under
 * the party's lock.
 */
export function sendSkip(party: DeliveryFacts, params: SendParams, mode: Mode): string | null {
  if (party.status === 'CANCELLED' || party.stage === 'CANCELLED') return 'Cancelled.';
  if (!party.approved) return 'Not approved yet. Approve it first.';
  if (party.confirmed === 0) {
    if (party.waitlisted > 0) return 'Waitlisted: holds no confirmed seat.';
    if (party.pending > 0) return 'Its seats are awaiting review.';
    return 'Holds no confirmed seat.';
  }
  if (party.unverified) return 'Has not verified their email address. Release it or send a reminder.';
  if (!party.contactEmail) return 'Has no email address.';
  if (party.suspicious) return `Suspicious address: ${party.suspicious} Fix it, or accept it as it is.`;

  const templateKey = ticketTemplateFor(party, params);
  if ((TEMPLATE_PURPOSE as Record<string, string>)[templateKey] !== 'TICKETS') {
    return `“${templateKey}” is not a ticket email. Choose a template that carries tickets.`;
  }

  const waiting = party.pendingTickets;
  if (waiting?.status === 'SENDING') return 'A ticket email is being sent right now.';
  if (mode === 'send' && party.delivered >= party.confirmed) {
    return 'Every ticket is already delivered. Use Resend to send them again.';
  }
  if (
    waiting &&
    waiting.status === 'QUEUED' &&
    waiting.templateKey === templateKey &&
    waiting.seatCount === party.confirmed &&
    waiting.toEmail.toLowerCase() === party.contactEmail.toLowerCase() &&
    party.issued === party.confirmed &&
    // Nothing else carrying these tickets is waiting to be replaced.
    party.withdrawable <= 1 &&
    !hasOverrides(party, params)
  ) {
    return 'A ticket email is already waiting to be sent.';
  }
  return null;
}

function sendDetail(party: DeliveryFacts, mode: Mode): string | null {
  const parts: string[] = [];
  const unissued = party.confirmed - party.issued;
  if (unissued > 0) parts.push(`Issues ${plural(unissued, 'ticket', 'tickets')} first.`);
  if (mode === 'resend' && party.delivered > 0) {
    parts.push(`Sends all ${plural(party.confirmed, 'ticket', 'tickets')} again.`);
  }
  if (party.withdrawable > 0) parts.push('Replaces the ticket email waiting to be sent.');
  return parts.length > 0 ? parts.join(' ') : null;
}

const idArray = (ids: number[]) => sql`${`{${ids.join(',')}}`}::bigint[]`;

/**
 * Issue the party's unissued confirmed seats, and repin its undelivered ones
 * when the wizard chose a design other than the default. Delivered seats keep
 * the version they were delivered with (`tickets.md` §10.5).
 */
async function issueParty(
  tx: Tx,
  concertId: number,
  party: DeliveryFacts,
  params: SendParams,
): Promise<{ issued: number; repinned: number; designId: number }> {
  const chosenId = params.designs[String(party.segmentId)];
  const design =
    chosenId !== undefined
      ? await chosenDesign(tx, concertId, chosenId)
      : await designForSegment(tx, party.segmentId);
  if (!design) throw new Error('The chosen ticket design no longer exists. Choose another in the wizard.');

  const unissued = await tx.execute<{ id: string }>(sql`
    select id from attendees
     where registration_id = ${party.id} and status = 'CONFIRMED' and deleted_at is null
       and (qr_token is null or ticket_template_id is null)
     order by id
  `);
  let issued = 0;
  if (unissued.length > 0) {
    await mintIdentifiers({ attendeeIds: unissued.map((row) => Number(row.id)) }, { executor: tx });
    const pinned = await tx.execute(sql`
      update attendees
         set ticket_template_id = ${design.id}, ticket_template_version = ${design.version},
             ticket_issued_at = coalesce(ticket_issued_at, now())
       where id = any(${idArray(unissued.map((row) => Number(row.id)))})
         and ticket_template_id is null and qr_token is not null
      returning id
    `);
    issued = pinned.length;
  }

  let repinned = 0;
  if (chosenId !== undefined) {
    const moved = await tx.execute(sql`
      update attendees
         set ticket_template_id = ${design.id}, ticket_template_version = ${design.version}
       where registration_id = ${party.id} and status = 'CONFIRMED' and deleted_at is null
         and ticket_sent_at is null and qr_token is not null
         and (ticket_template_id is distinct from ${design.id}
              or ticket_template_version is distinct from ${design.version})
      returning id
    `);
    repinned = moved.length;
  }
  return { issued, repinned, designId: design.id };
}

/** Render and queue one party's ticket email. Shared by Send tickets and Resend. */
export async function sendTicketsToParty(
  tx: Tx,
  ctx: RunContext<SendParams>,
  party: DeliveryFacts,
  mode: Mode,
): Promise<Record<string, unknown>> {
  const templateKey = ticketTemplateFor(party, ctx.params);
  const [template] = await tx.execute<{ subject: string; body_md: string }>(sql`
    select subject, body_md from email_templates where key = ${templateKey} and deleted_at is null
  `);
  if (!template) throw new Error(`There is no “${templateKey}” email template. Restore it or choose another.`);

  // A granted-extras email carries the same tickets (§24.2). One in flight
  // would deliver them beside this one, so the party waits for it.
  const [extrasInFlight] = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from email_outbox
     where registration_id = ${party.id} and purpose = 'EXTRAS_DECISION'
       and template_key = 'extras_granted' and status = 'SENDING'
  `);
  if (extrasInFlight.n > 0) throw new SkipItem('An email carrying these tickets is being sent right now.');

  const { issued, repinned, designId } = await issueParty(tx, ctx.concertId, party, ctx.params);

  const recipient = await partyRecipient(tx, party.id);
  if (!recipient) throw new SkipItem('No longer exists in this concert.');
  const context = escapeMergeValues(recipient.context);
  const wording = ctx.params.wording[templateKey] ?? { subject: template.subject, bodyMd: template.body_md };
  const subject = renderTemplate(wording.subject, context);
  const body = renderTemplate(wording.bodyMd, context);
  const unknown = [...new Set([...subject.unknown, ...body.unknown])];

  let queued: { id: number; superseded: number[] };
  try {
    queued = await draftSuperseding(
      tx,
      {
        addressee: { registrationId: party.id },
        purpose: 'TICKETS',
        templateKey,
        toEmail: party.contactEmail!,
        toName: recipient.contactName ? toNameCase(recipient.contactName) : null,
        subject: subject.text,
        bodyMd: body.text,
        context: recipient.context,
        status: 'QUEUED',
      },
      ctx.audit,
    );
  } catch (error) {
    if (error instanceof MessageInFlightError) throw new SkipItem(error.message);
    throw error;
  }

  /**
   * **A waiting granted-extras email is superseded too.** It is another
   * purpose, so the pending index does not see the two as one, but it carries
   * the party's tickets: left alone, the party would get them twice. This
   * message carries every confirmed seat, extras included, so nothing is lost.
   */
  const extras = await tx.execute<{ id: string }>(sql`
    update email_outbox
       set status = 'CANCELLED', superseded_by_id = ${queued.id}, updated_at = now()
     where registration_id = ${party.id} and purpose = 'EXTRAS_DECISION'
       and template_key = 'extras_granted' and status in ('DRAFT', 'QUEUED')
    returning id
  `);
  for (const row of extras) {
    await ctx.audit({
      action: 'email.message_superseded',
      entityType: 'email_outbox',
      entityId: Number(row.id),
      after: { status: 'CANCELLED', supersededById: queued.id, templateKey },
    });
  }
  queued.superseded.push(...extras.map((row) => Number(row.id)));

  await ctx.audit({
    action: mode === 'resend' ? 'email.tickets_resent' : 'email.tickets_queued',
    entityType: 'registration',
    entityId: party.id,
    after: {
      messageId: queued.id,
      templateKey,
      designId,
      issued,
      repinned,
      superseded: queued.superseded,
      ownWording: ctx.params.wording[templateKey] !== undefined,
    },
  });

  const notes: string[] = [];
  if (unknown.length > 0) notes.push(`The wording names ${unknown.join(', ')}, which resolved to nothing.`);
  if (queued.superseded.length > 0) notes.push('Replaced the ticket email that was waiting.');
  return {
    messageId: queued.id,
    issued,
    repinned,
    superseded: queued.superseded.length,
    note: notes.length > 0 ? notes.join(' ') : null,
  };
}

/** A Delivery definition from the parts that differ. */
function deliveryCommand<P>(spec: {
  name: string;
  verb: string;
  params: z.ZodType<P>;
  skip: (party: DeliveryFacts, ctx: CommandContext<P>) => string | null;
  detail?: (party: DeliveryFacts, ctx: CommandContext<P>) => string | null;
  blastRadius?: (tx: Tx, ctx: CommandContext<P>, parties: DeliveryFacts[]) => Promise<BlastLine[]>;
  apply: (tx: Tx, ctx: RunContext<P>, party: DeliveryFacts) => Promise<Record<string, unknown>>;
}): AnyCommand {
  return defineCommand({
    name: spec.name,
    entityType: 'registration',
    verb: spec.verb,
    noun: { one: 'party', many: 'parties' },
    irreversible: false,
    filter: audienceFilterSchema,
    params: spec.params,
    match: (tx, ctx, f) => matchPartyIds(tx, ctx.concertId, f),
    async describe(tx, ctx, ids, { lock }) {
      const facts = await deliveryFacts(tx, ctx.concertId, ids, lock);
      return ids
        .filter((id) => facts.has(id))
        .map((id): TargetRow => {
          const party = facts.get(id)!;
          const skip = spec.skip(party, ctx);
          return { id, label: party.label, skip, detail: skip ? null : (spec.detail?.(party, ctx) ?? null) };
        });
    },
    blastRadius: spec.blastRadius
      ? async (tx, ctx, ids) =>
          spec.blastRadius!(tx, ctx, [...(await deliveryFacts(tx, ctx.concertId, ids, false)).values()])
      : undefined,
    async apply(tx, ctx, row) {
      const party = (await deliveryFacts(tx, ctx.concertId, [row.id], false)).get(row.id);
      if (!party) throw new SkipItem('No longer exists in this concert.');
      const outcome = await spec.apply(tx, ctx, party);
      return JSON.parse(JSON.stringify({ label: row.label, ...outcome }));
    },
  });
}

async function sendBlast(parties: DeliveryFacts[], mode: Mode): Promise<BlastLine[]> {
  const lines: BlastLine[] = [];
  const unissued = parties.reduce((n, p) => n + (p.confirmed - p.issued), 0);
  const tickets = parties.reduce((n, p) => n + p.confirmed, 0);
  const replaced = parties.filter((p) => p.withdrawable > 0).length;
  const again = parties.reduce((n, p) => n + p.delivered, 0);
  lines.push({ count: parties.length, text: `ticket ${parties.length === 1 ? 'email' : 'emails'} queued, carrying ${plural(tickets, 'ticket', 'tickets')}.`, tone: 'neutral' });
  if (unissued > 0) {
    lines.push({ count: unissued, text: 'tickets are issued first: their QR codes are minted now and never change after.', tone: 'neutral' });
  }
  if (replaced > 0) {
    lines.push({ count: replaced, text: 'ticket emails already waiting are replaced by this send, not sent beside it.', tone: 'neutral' });
  }
  const bounced = parties.filter((p) => p.bounced).length;
  if (bounced > 0) {
    lines.push({ count: bounced, text: 'parties’ last ticket email bounced at this same address, so this may bounce too. Fix the address on the record first if it is wrong.', tone: 'warning' });
  }
  if (mode === 'resend' && again > 0) {
    lines.push({ count: again, text: 'tickets already delivered are sent again. Each guest gets a second copy of the same ticket.', tone: 'warning' });
  }
  return lines;
}

const sendTickets = deliveryCommand({
  name: 'delivery.send_tickets',
  verb: 'Send tickets to',
  params: sendParams,
  skip: (party, ctx) => sendSkip(party, ctx.params, 'send'),
  detail: (party) => sendDetail(party, 'send'),
  blastRadius: async (_tx, _ctx, parties) => sendBlast(parties, 'send'),
  apply: (tx, ctx, party) => sendTicketsToParty(tx, ctx, party, 'send'),
});

/**
 * **Resend** — every confirmed ticket again, to the party's current address:
 * the answer to "they deleted the email" and to the record's question after an
 * address change (§22.4). The same wizard, the same message; it differs from
 * Send tickets only in not skipping a party whose tickets were all delivered.
 */
const resend = deliveryCommand({
  name: 'delivery.resend',
  verb: 'Resend tickets to',
  params: sendParams,
  skip: (party, ctx) => sendSkip(party, ctx.params, 'resend'),
  detail: (party) => sendDetail(party, 'resend'),
  blastRadius: async (_tx, _ctx, parties) => sendBlast(parties, 'resend'),
  apply: (tx, ctx, party) => sendTicketsToParty(tx, ctx, party, 'resend'),
});

const noParams = z.object({}).strict();

/** Ticket-bearing: `TICKETS`, and the granted half of `EXTRAS_DECISION` (§24.2). */
const TICKET_BEARING_PENDING = sql`
  status in ('DRAFT', 'QUEUED')
  and (purpose = 'TICKETS' or (purpose = 'EXTRAS_DECISION' and template_key = 'extras_granted'))
`;

/**
 * **Mark delivered by hand** (§11.6): the ticket reached the guest some other
 * way — a printout, a PDF forwarded by hand. It sends nothing. Only an issued
 * ticket can have been handed over, so unissued seats stay undelivered and the
 * report says so; once every seat is delivered, the ticket email still waiting
 * is withdrawn, since it would only send the same tickets again.
 */
const markDelivered = deliveryCommand({
  name: 'delivery.mark_delivered',
  verb: 'Mark delivered by hand for',
  params: noParams,
  skip: (party) => {
    if (party.confirmed === 0) return 'Holds no confirmed seat.';
    if (party.delivered >= party.confirmed) return 'Every ticket is already delivered.';
    if (party.issued === 0) return 'No ticket is issued yet. Issue or send tickets first.';
    if (party.pendingTickets?.status === 'SENDING') return 'A ticket email is being sent right now.';
    return null;
  },
  detail: (party) =>
    party.issued < party.confirmed
      ? `${plural(party.confirmed - party.issued, 'seat has', 'seats have')} no ticket yet and stay undelivered.`
      : null,
  async blastRadius(_tx, _ctx, parties) {
    const seats = parties.reduce((n, p) => n + Math.max(0, Math.min(p.issued, p.confirmed) - p.delivered), 0);
    return [{ count: seats, text: 'tickets are recorded as delivered by hand. Nothing is emailed.', tone: 'neutral' }];
  },
  async apply(tx, ctx, party) {
    const marked = await tx.execute<{ id: string }>(sql`
      update attendees
         set ticket_sent_at = now(), ticket_sent_source = 'MANUAL', updated_at = now()
       where registration_id = ${party.id} and status = 'CONFIRMED' and deleted_at is null
         and ticket_sent_at is null and qr_token is not null and ticket_template_id is not null
      returning id
    `);
    if (marked.length === 0) throw new SkipItem('No issued ticket was left undelivered.');
    await ctx.audit({
      action: 'attendee.marked_delivered',
      entityType: 'registration',
      entityId: party.id,
      after: { attendeeIds: marked.map((row) => Number(row.id)), source: 'MANUAL' },
    });

    const [left] = await tx.execute<{ n: number }>(sql`
      select count(*)::int as n from attendees
       where registration_id = ${party.id} and status = 'CONFIRMED' and deleted_at is null
         and ticket_sent_at is null
    `);
    let withdrawn = 0;
    if (left.n === 0) {
      const rows = await tx.execute<{ id: string }>(sql`
        update email_outbox set status = 'CANCELLED', updated_at = now()
         where registration_id = ${party.id} and ${TICKET_BEARING_PENDING}
        returning id
      `);
      withdrawn = rows.length;
      for (const row of rows) {
        await ctx.audit({ action: 'email.message_cancelled', entityType: 'email_outbox', entityId: Number(row.id), after: { why: 'delivered by hand' } });
      }
    }
    const notes: string[] = [];
    if (left.n > 0) notes.push(`${plural(left.n, 'seat has', 'seats have')} no ticket yet and stayed undelivered.`);
    if (withdrawn > 0) notes.push('Withdrew the ticket email that was waiting.');
    return { marked: marked.length, withdrawn, note: notes.length > 0 ? notes.join(' ') : null };
  },
});

/**
 * **Cancel sending**: withdraw the party's ticket email waiting to be sent.
 * `SENDING` belongs to the dispatcher and cannot be recalled.
 */
const cancelSending = deliveryCommand({
  name: 'delivery.cancel_sending',
  verb: 'Cancel sending to',
  params: noParams,
  skip: (party) =>
    party.withdrawable > 0
      ? null
      : party.pendingTickets?.status === 'SENDING'
        ? 'Being sent right now; it cannot be recalled.'
        : 'Nothing is waiting to be sent.',
  async apply(tx, ctx, party) {
    const rows = await tx.execute<{ id: string }>(sql`
      update email_outbox set status = 'CANCELLED', updated_at = now()
       where registration_id = ${party.id} and ${TICKET_BEARING_PENDING}
      returning id
    `);
    if (rows.length === 0) throw new SkipItem('Nothing is waiting to be sent.');
    for (const row of rows) {
      await ctx.audit({ action: 'email.message_cancelled', entityType: 'email_outbox', entityId: Number(row.id) });
    }
    return { cancelled: rows.length };
  },
});

export const DELIVERY_COMMANDS: AnyCommand[] = [sendTickets, resend, markDelivered, cancelSending];

