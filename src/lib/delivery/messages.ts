import 'server-only';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Executor } from '@/db/allocation';
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
import { CommandInputError } from '@/lib/commands/runner';
import { draftSuperseding, MessageInFlightError } from '@/lib/email/supersede';
import { carriesTickets } from '@/lib/email/templates';
import { sendSkip, sendTicketsToParty, type SendParams } from './commands';
import { deliveryFacts } from './facts';
import { MESSAGE_STATUSES, messageFilterSchema, type MessageFilter, type MessageStatus } from './message-filter';
import type { Purpose } from './purposes';

/**
 * Messages — spec/v3.md §24.4: **every message has an exit.** Retry, Cancel,
 * Edit, Delete and Resend, over the Messages view's selection or one message
 * from the party record's Conversation tab.
 *
 * V1 let a person act on a message only while it was a `DRAFT`, and a `FAILED`
 * one that exhausted its attempts sat there for ever (§20, finding 4). Each
 * status now has the exits `MESSAGE_EXITS` lists; `SENDING` alone has none,
 * because the dispatcher holds it and resolves it either way.
 */

const idArray = (ids: number[]) => sql`${`{${ids.join(',')}}`}::bigint[]`;

/** A message in this concert: through its party's show, or its player. */
const IN_CONCERT = (concertId: number) => sql`
  coalesce(s.concert_id, pl.concert_id) = ${concertId}
`;

const FROM_MESSAGES = sql`
  from email_outbox o
  left join registrations r on r.id = o.registration_id
  left join shows s on s.id = r.show_id
  left join players pl on pl.id = o.player_id
`;

function messageWhere(concertId: number, filter: MessageFilter, searchAddresses: boolean): SQL {
  const parts: SQL[] = [IN_CONCERT(concertId), sql`o.deleted_at is null`, sql`coalesce(r.deleted_at, pl.deleted_at) is null`];
  if (filter.status) parts.push(sql`o.status = ${filter.status}::outbox_status`);
  if (filter.purpose) parts.push(sql`o.purpose = ${filter.purpose}::message_purpose`);
  if (filter.registrationId) parts.push(sql`o.registration_id = ${filter.registrationId}`);
  if (filter.search) {
    const like = `%${filter.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    // A viewer searches what they can see unmasked (spec/v3.md §28): never the
    // address, or a row appearing for one guess spells it out.
    parts.push(
      searchAddresses
        ? sql`(o.subject ilike ${like} or coalesce(r.contact_name, pl.full_name) ilike ${like}
               or o.to_email::text ilike ${like} or o.id::text = ${filter.search})`
        : sql`(o.subject ilike ${like} or coalesce(r.contact_name, pl.full_name) ilike ${like}
               or o.id::text = ${filter.search})`,
    );
  }
  return sql.join(parts, sql` and `);
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export type MessageRow = {
  id: number;
  registrationId: number | null;
  playerId: number | null;
  addressee: string;
  toEmail: string;
  purpose: Purpose;
  templateKey: string | null;
  subject: string;
  bodyMd: string;
  status: MessageStatus;
  attempts: number;
  lastError: string | null;
  bounceCode: string | null;
  bounceDetail: string | null;
  supersededById: number | null;
  sentAt: string | null;
  scheduledFor: string | null;
  createdAt: string;
  updatedAt: string;
};

type RawMessage = {
  id: string;
  registration_id: string | null;
  player_id: string | null;
  addressee: string | null;
  to_email: string;
  purpose: Purpose;
  template_key: string | null;
  subject: string;
  body_md: string;
  status: MessageStatus;
  attempts: number;
  last_error: string | null;
  bounce_code: string | null;
  bounce_detail: string | null;
  superseded_by_id: string | null;
  sent_at: string | null;
  scheduled_for: string | null;
  created_at: string;
  updated_at: string;
};

const MESSAGE_COLUMNS = sql`
  o.id, o.registration_id, o.player_id, coalesce(r.contact_name, pl.full_name) as addressee,
  o.to_email::text as to_email, o.purpose, o.template_key, o.subject, o.body_md, o.status, o.attempts,
  o.last_error, o.bounce_code, o.bounce_detail, o.superseded_by_id,
  o.sent_at::text as sent_at, o.scheduled_for::text as scheduled_for,
  o.created_at::text as created_at, o.updated_at::text as updated_at
`;

const toRow = (row: RawMessage): MessageRow => ({
  id: Number(row.id),
  registrationId: row.registration_id ? Number(row.registration_id) : null,
  playerId: row.player_id ? Number(row.player_id) : null,
  addressee: row.addressee ?? '',
  toEmail: row.to_email,
  purpose: row.purpose,
  templateKey: row.template_key,
  subject: row.subject,
  bodyMd: row.body_md,
  status: row.status,
  attempts: row.attempts,
  lastError: row.last_error,
  bounceCode: row.bounce_code,
  bounceDetail: row.bounce_detail,
  supersededById: row.superseded_by_id ? Number(row.superseded_by_id) : null,
  sentAt: row.sent_at,
  scheduledFor: row.scheduled_for,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export async function listMessages(
  executor: Executor,
  concertId: number,
  filter: MessageFilter,
  page: { offset: number; limit: number; searchAddresses: boolean },
): Promise<{ rows: MessageRow[]; total: number; counts: Record<MessageStatus, number> }> {
  const rows = await executor.execute<RawMessage>(sql`
    select ${MESSAGE_COLUMNS}
      ${FROM_MESSAGES}
     where ${messageWhere(concertId, filter, page.searchAddresses)}
     order by o.updated_at desc, o.id desc
     offset ${page.offset} limit ${page.limit}
  `);

  // Counts per status ignore the status filter, so each tab says what it holds.
  const { status: _status, ...rest } = filter;
  void _status;
  const counted = await executor.execute<{ status: MessageStatus; n: number }>(sql`
    select o.status, count(*)::int as n
      ${FROM_MESSAGES}
     where ${messageWhere(concertId, rest, page.searchAddresses)}
     group by o.status
  `);
  const counts = Object.fromEntries(MESSAGE_STATUSES.map((s) => [s, 0])) as Record<MessageStatus, number>;
  for (const row of counted) counts[row.status] = row.n;
  const total = filter.status ? counts[filter.status] : Object.values(counts).reduce((a, b) => a + b, 0);

  return { rows: rows.map(toRow), total, counts };
}

export async function matchMessageIds(executor: Executor, concertId: number, filter: MessageFilter): Promise<number[]> {
  const rows = await executor.execute<{ id: string }>(sql`
    select o.id ${FROM_MESSAGES}
     where ${messageWhere(concertId, filter, true)}
     order by o.id
  `);
  return rows.map((row) => Number(row.id));
}

/** Every live message of one party, oldest first: the record's Conversation (§22.4). */
export async function partyMessages(executor: Executor, concertId: number, registrationId: number): Promise<MessageRow[]> {
  const rows = await executor.execute<RawMessage>(sql`
    select ${MESSAGE_COLUMNS}
      ${FROM_MESSAGES}
     where ${messageWhere(concertId, { registrationId }, true)}
     order by o.created_at, o.id
  `);
  return rows.map(toRow);
}

// ---------------------------------------------------------------------------
// Facts, for the commands
// ---------------------------------------------------------------------------

type MessageFacts = {
  id: number;
  label: string;
  registrationId: number | null;
  playerId: number | null;
  purpose: Purpose;
  templateKey: string | null;
  status: MessageStatus;
  toEmail: string;
  /** Where it would go now: the party's or player's current address (§24.3). */
  currentEmail: string | null;
  ticketBearing: boolean;
  /** The seat count its wording states, for a ticket-bearing message. */
  statedSeats: number | null;
  confirmedSeats: number;
  issuedSeats: number;
  /** Another message of the same purpose to the same addressee is pending. */
  newerPending: boolean;
};

async function messageFacts(
  tx: Tx,
  concertId: number,
  ids: number[],
  lock: boolean,
): Promise<Map<number, MessageFacts>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.execute<{
    id: string;
    registration_id: string | null;
    player_id: string | null;
    addressee: string | null;
    purpose: Purpose;
    template_key: string | null;
    status: MessageStatus;
    to_email: string;
    current_email: string | null;
    stated: string | null;
    confirmed: number;
    issued: number;
    newer_pending: boolean;
  }>(sql`
    select o.id, o.registration_id, o.player_id, coalesce(r.contact_name, pl.full_name) as addressee,
           o.purpose, o.template_key, o.status, o.to_email::text as to_email,
           coalesce(r.contact_email, pl.email)::text as current_email,
           o.context ->> 'attendee_count' as stated,
           (select count(*)::int from attendees a
             where a.registration_id = o.registration_id and a.status = 'CONFIRMED'
               and a.deleted_at is null) as confirmed,
           (select count(*)::int from attendees a
             where a.registration_id = o.registration_id and a.status = 'CONFIRMED'
               and a.deleted_at is null and a.qr_token is not null
               and a.ticket_template_id is not null) as issued,
           exists (
             select 1 from email_outbox n
              where n.id <> o.id and n.purpose = o.purpose and n.purpose <> 'REPLY'
                and n.status in ('DRAFT', 'QUEUED', 'SENDING')
                and (n.registration_id = o.registration_id or n.player_id = o.player_id)
           ) as newer_pending
      ${FROM_MESSAGES}
     where o.id = any(${idArray(ids)})
       and ${IN_CONCERT(concertId)}
       and o.deleted_at is null
       and coalesce(r.deleted_at, pl.deleted_at) is null
     ${lock ? sql`for update of o` : sql``}
  `);
  return new Map(
    rows.map((row) => [
      Number(row.id),
      {
        id: Number(row.id),
        label: `${row.addressee ?? 'Message'} · ${row.template_key ?? row.purpose.toLowerCase()}`,
        registrationId: row.registration_id ? Number(row.registration_id) : null,
        playerId: row.player_id ? Number(row.player_id) : null,
        purpose: row.purpose,
        templateKey: row.template_key,
        status: row.status,
        toEmail: row.to_email,
        currentEmail: row.current_email,
        ticketBearing: row.template_key !== null && carriesTickets(row.template_key),
        statedSeats: row.stated === null ? null : Number(row.stated),
        confirmedSeats: row.confirmed,
        issuedSeats: row.issued,
        newerPending: row.newer_pending,
      },
    ]),
  );
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const noParams = z.object({}).strict();

function messageCommand<P>(spec: {
  name: string;
  verb: string;
  params: z.ZodType<P>;
  /** Edit writes one message's words; it refuses a filter or several ids. */
  single?: boolean;
  skip: (message: MessageFacts, ctx: CommandContext<P>) => string | null;
  blastRadius?: (tx: Tx, ctx: CommandContext<P>, messages: MessageFacts[]) => Promise<BlastLine[]>;
  apply: (tx: Tx, ctx: RunContext<P>, message: MessageFacts) => Promise<Record<string, unknown>>;
}): AnyCommand {
  return defineCommand({
    name: spec.name,
    entityType: 'email_outbox',
    verb: spec.verb,
    noun: { one: 'message', many: 'messages' },
    irreversible: false,
    filter: messageFilterSchema,
    params: spec.params,
    async match(tx, ctx, filter) {
      if (spec.single) throw new CommandInputError(`${spec.verb} one message at a time.`);
      return matchMessageIds(tx, ctx.concertId, filter);
    },
    order: spec.single
      ? async (_tx, _ctx, ids) => {
          if (ids.length > 1) throw new CommandInputError(`${spec.verb} one message at a time.`);
          return ids;
        }
      : undefined,
    async describe(tx, ctx, ids, { lock }) {
      const facts = await messageFacts(tx, ctx.concertId, ids, lock);
      return ids
        .filter((id) => facts.has(id))
        .map((id): TargetRow => {
          const message = facts.get(id)!;
          return { id, label: message.label, skip: spec.skip(message, ctx) };
        });
    },
    blastRadius: spec.blastRadius
      ? async (tx, ctx, ids) =>
          spec.blastRadius!(tx, ctx, [...(await messageFacts(tx, ctx.concertId, ids, false)).values()])
      : undefined,
    async apply(tx, ctx, row) {
      const message = (await messageFacts(tx, ctx.concertId, [row.id], false)).get(row.id);
      if (!message) throw new SkipItem('No longer exists in this concert.');
      const outcome = await spec.apply(tx, ctx, message);
      return JSON.parse(JSON.stringify({ label: row.label, ...outcome }));
    },
  });
}

const statusIs = (message: MessageFacts, allowed: MessageStatus[], what: string) =>
  allowed.includes(message.status) ? null : `${what} This one is ${message.status.toLowerCase()}.`;

/**
 * **Retry** a failed message: attempts reset, due now, addressed to where the
 * party is reached today (§24.3). A ticket email whose party has changed since
 * it was written would be refused by the dispatcher (its wording states the
 * wrong number of tickets), so it is skipped here with the way forward.
 */
const retry = messageCommand({
  name: 'messages.retry',
  verb: 'Retry',
  params: noParams,
  skip(message) {
    const wrong = statusIs(message, ['FAILED'], 'Only a failed message is retried.');
    if (wrong) return wrong;
    if (!message.currentEmail) return 'Has no email address to send to.';
    if (message.newerPending) return 'A newer message for this is already waiting to be sent.';
    if (message.ticketBearing) {
      if (message.confirmedSeats === 0) return 'The party holds no confirmed seat now.';
      if (message.issuedSeats < message.confirmedSeats || message.statedSeats !== message.confirmedSeats) {
        return 'The party’s seats changed since this was written. Send tickets again instead.';
      }
    }
    return null;
  },
  async apply(tx, ctx, message) {
    await tx.execute(sql`
      update email_outbox
         set status = 'QUEUED', attempts = 0, last_error = null, scheduled_for = null,
             to_email = ${message.currentEmail}, updated_at = now()
       where id = ${message.id} and status = 'FAILED'
    `);
    const readdressed = message.currentEmail!.toLowerCase() !== message.toEmail.toLowerCase();
    await ctx.audit({
      action: 'email.message_retried',
      entityType: 'email_outbox',
      entityId: message.id,
      before: { status: 'FAILED', toEmail: message.toEmail },
      after: { status: 'QUEUED', toEmail: message.currentEmail },
    });
    return { note: readdressed ? `Goes to the new address, ${message.currentEmail}.` : null };
  },
});

/** **Cancel** a message that has not gone out. `SENDING` is the dispatcher's. */
const cancel = messageCommand({
  name: 'messages.cancel',
  verb: 'Cancel',
  params: noParams,
  skip: (message) =>
    message.status === 'SENDING'
      ? 'Being sent right now; it cannot be recalled.'
      : statusIs(message, ['DRAFT', 'QUEUED', 'FAILED'], 'Only a message not yet sent can be cancelled.'),
  async apply(tx, ctx, message) {
    await tx.execute(sql`
      update email_outbox set status = 'CANCELLED', updated_at = now()
       where id = ${message.id} and status in ('DRAFT', 'QUEUED', 'FAILED')
    `);
    await ctx.audit({
      action: 'email.message_cancelled',
      entityType: 'email_outbox',
      entityId: message.id,
      before: { status: message.status },
      after: { status: 'CANCELLED' },
    });
    return {};
  },
});

export const editParams = z
  .object({
    subject: z.string().trim().min(1, 'A subject is needed.').max(500),
    bodyMd: z.string().trim().min(1, 'The message is empty.').max(50_000),
  })
  .strict();

/**
 * **Edit** one message's words, in any status before it is sent (§24.4). What
 * the dispatcher sends is exactly what is stored (§11.5), so the edit is what
 * the guest reads. The library template is untouched.
 */
const edit = messageCommand({
  name: 'messages.edit',
  verb: 'Edit',
  params: editParams,
  single: true,
  skip: (message) =>
    message.status === 'SENDING'
      ? 'Being sent right now; it can no longer be changed.'
      : statusIs(message, ['DRAFT', 'QUEUED', 'FAILED'], 'Only a message not yet sent can be edited.'),
  async apply(tx, ctx, message) {
    const [before] = await tx.execute<{ subject: string; body_md: string }>(sql`
      select subject, body_md from email_outbox where id = ${message.id}
    `);
    await tx.execute(sql`
      update email_outbox set subject = ${ctx.params.subject}, body_md = ${ctx.params.bodyMd}, updated_at = now()
       where id = ${message.id}
    `);
    await ctx.audit({
      action: 'email.message_edited',
      entityType: 'email_outbox',
      entityId: message.id,
      before,
      after: { subject: ctx.params.subject, body_md: ctx.params.bodyMd },
    });
    return {};
  },
});

/**
 * **Delete**: into the Trash (§23.6), restorable. A message not yet sent is
 * cancelled first, so the dispatcher can never send something the admin threw
 * away, and a restore brings it back cancelled rather than due.
 */
const remove = messageCommand({
  name: 'messages.delete',
  verb: 'Delete',
  params: noParams,
  skip: (message) => (message.status === 'SENDING' ? 'Being sent right now. Delete it once it is sent.' : null),
  async blastRadius(_tx, _ctx, messages) {
    const lines: BlastLine[] = [];
    const pending = messages.filter((m) => ['DRAFT', 'QUEUED', 'FAILED'].includes(m.status)).length;
    const history = messages.filter((m) => ['SENT', 'BOUNCED'].includes(m.status)).length;
    if (pending > 0) lines.push({ count: pending, text: 'messages not yet sent are cancelled and never go out.', tone: 'warning' });
    if (history > 0) {
      lines.push({ count: history, text: 'sent messages leave the party’s conversation. Their tickets stay valid.', tone: 'neutral' });
    }
    return lines;
  },
  async apply(tx, ctx, message) {
    await tx.execute(sql`
      update email_outbox
         set status = case when status in ('DRAFT', 'QUEUED', 'FAILED') then 'CANCELLED'::outbox_status
                           else status end,
             deleted_at = now(), updated_at = now()
       where id = ${message.id} and status <> 'SENDING'
    `);
    await ctx.audit({
      action: 'email.message_deleted',
      entityType: 'email_outbox',
      entityId: message.id,
      before: { status: message.status },
    });
    return {};
  },
});

/**
 * **Resend** a sent or bounced message as a new one, to the current address.
 *
 * A ticket email is not copied: the party's tickets are sent again as they are
 * now, through the same path as Send tickets, so a seat added since is not
 * left out and a cancelled one is not resent. Anything else is copied word for
 * word, superseding whatever of its purpose is pending.
 */
const resend = messageCommand({
  name: 'messages.resend',
  verb: 'Resend',
  params: noParams,
  skip(message) {
    const wrong = statusIs(message, ['SENT', 'BOUNCED'], 'Only a sent or bounced message is resent.');
    if (wrong) return wrong;
    if (message.purpose === 'REPLY') return 'A reply is not resent. Write another from the record.';
    if (!message.currentEmail) return 'Has no email address to send to.';
    return null;
  },
  async apply(tx, ctx, message) {
    if (message.ticketBearing && message.registrationId) {
      const party = (await deliveryFacts(tx, ctx.concertId, [message.registrationId], true)).get(
        message.registrationId,
      );
      if (!party) throw new SkipItem('The party no longer exists in this concert.');
      const params: SendParams = {
        designs: {},
        templates: message.purpose === 'TICKETS' && message.templateKey
          ? { [String(party.segmentId)]: message.templateKey }
          : {},
        wording: {},
      };
      const why = sendSkip(party, params, 'resend');
      if (why) throw new SkipItem(why);
      return sendTicketsToParty(tx, { ...ctx, params }, party, 'resend');
    }

    const [original] = await tx.execute<{
      subject: string;
      body_md: string;
      context: Record<string, string> | null;
      to_name: string | null;
    }>(sql`select subject, body_md, context, to_name from email_outbox where id = ${message.id}`);
    try {
      const queued = await draftSuperseding(
        tx,
        {
          addressee: message.registrationId
            ? { registrationId: message.registrationId }
            : { playerId: message.playerId! },
          purpose: message.purpose,
          templateKey: message.templateKey,
          toEmail: message.currentEmail!,
          toName: original.to_name,
          subject: original.subject,
          bodyMd: original.body_md,
          context: original.context,
          status: 'QUEUED',
        },
        ctx.audit,
      );
      await ctx.audit({
        action: 'email.message_resent',
        entityType: 'email_outbox',
        entityId: message.id,
        after: { messageId: queued.id, toEmail: message.currentEmail },
      });
      return { messageId: queued.id };
    } catch (error) {
      if (error instanceof MessageInFlightError) throw new SkipItem(error.message);
      throw error;
    }
  },
});

export const MESSAGE_COMMANDS: AnyCommand[] = [retry, cancel, edit, remove, resend];
