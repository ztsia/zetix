import 'server-only';

import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { writeAuditLog } from '@/lib/audit';
import { createConfiguredTransport } from '@/lib/email/config';
import { dispatchBatch } from '@/lib/email/dispatch';
import type { MailTransport } from '@/lib/mail/transport';
import { markThreadHandled } from './threads';

/**
 * Answering from the record (spec/v3.md §26.6): a reply is an outbox row with
 * purpose `REPLY`, queued and sent at once — no `DRAFT` gate, because a person
 * wrote it — threaded under the message it answers by the dispatcher.
 */

export class ReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplyError';
  }
}

type Inbound = {
  id: number;
  threadId: number;
  subject: string | null;
  isBounce: boolean;
  direction: string;
  messageAt: string;
  registrationId: number | null;
  playerId: number | null;
  /** Where a reply goes now — resolved late (§24.3), never from the message's own `From`. */
  toEmail: string | null;
  toName: string | null;
};

/** One stored message, only if it belongs to this concert. */
async function loadInbound(concertId: number, messageId: number): Promise<Inbound | null> {
  const [row] = await getDb().execute<{
    id: string;
    thread_id: string;
    subject: string | null;
    is_bounce: boolean;
    direction: string;
    message_at: string;
    registration_id: string | null;
    player_id: string | null;
    to_email: string | null;
    to_name: string | null;
  }>(sql`
    select m.id, m.thread_id, m.subject, m.is_bounce, m.direction::text as direction,
           to_json(m.message_at) #>> '{}' as message_at,
           t.registration_id, t.player_id,
           coalesce(r.contact_email, p.email)::text as to_email,
           coalesce(r.contact_name, p.full_name) as to_name
      from email_messages m
      join email_threads t on t.id = m.thread_id and t.deleted_at is null
      left join registrations r on r.id = t.registration_id and r.deleted_at is null
      left join shows s on s.id = r.show_id
      left join players p on p.id = t.player_id and p.deleted_at is null
     where m.id = ${messageId}
       and m.deleted_at is null
       and (s.concert_id = ${concertId} or p.concert_id = ${concertId})`);
  if (!row) return null;
  return {
    id: Number(row.id),
    threadId: Number(row.thread_id),
    subject: row.subject,
    isBounce: row.is_bounce,
    direction: row.direction,
    messageAt: row.message_at,
    registrationId: row.registration_id === null ? null : Number(row.registration_id),
    playerId: row.player_id === null ? null : Number(row.player_id),
    toEmail: row.to_email,
    toName: row.to_name,
  };
}

function entity(m: Inbound) {
  return m.registrationId !== null
    ? { entityType: 'registration', entityId: m.registrationId }
    : { entityType: 'player', entityId: m.playerId! };
}

/** `Re: ` once, however many times the thread has gone back and forth. */
export function replySubject(subject: string | null): string {
  const base = (subject ?? '').trim();
  if (base === '') return 'Re: your message';
  return /^re:/i.test(base) ? base : `Re: ${base}`;
}

export type ReplyResult = {
  outboxId: number;
  /** False when the message is queued but could not go out now; the next tick sends it. */
  sent: boolean;
  note: string | null;
};

export async function sendReply(input: {
  concertId: number;
  messageId: number;
  body: string;
  actorId: string;
  /** Injected by tests; production uses the configured Gmail transport. */
  transport?: MailTransport;
}): Promise<ReplyResult> {
  const body = input.body.trim();
  if (body.length === 0) throw new ReplyError('Write something before sending.');

  const inbound = await loadInbound(input.concertId, input.messageId);
  if (!inbound) throw new ReplyError('That message is no longer in this concert.');
  if (inbound.direction !== 'INBOUND' || inbound.isBounce) {
    throw new ReplyError('Only a reply from a guest can be answered. A bounce means the address does not work.');
  }
  if (!inbound.toEmail) throw new ReplyError('This party has no email address to reply to.');

  const outboxId = await getDb().transaction(async (tx) => {
    const [row] = await tx.execute<{ id: string }>(sql`
      insert into email_outbox (registration_id, player_id, purpose, template_key, to_email, to_name,
                                subject, body_md, status, in_reply_to_message_id)
      values (${inbound.registrationId}, ${inbound.playerId}, 'REPLY', null, ${inbound.toEmail}, ${inbound.toName},
              ${replySubject(inbound.subject)}, ${body}, 'QUEUED', ${inbound.id})
      returning id`);
    // Answering is handling (§26.5): the flag drops now, not when Gmail accepts it.
    await markThreadHandled(tx, inbound.threadId, input.actorId, { messageId: inbound.id });
    await writeAuditLog(
      {
        action: 'email.reply_sent',
        ...entity(inbound),
        after: { outboxId: Number(row.id), inReplyTo: inbound.id, to: inbound.toEmail },
        actorId: input.actorId,
      },
      tx,
    );
    return Number(row.id);
  });

  /**
   * Sent at once (§26.6). The transport is built *before* the dispatcher
   * claims the row: an environment with no mail credential then leaves it
   * `QUEUED` for the next tick, rather than claimed and stranded in `SENDING`.
   */
  try {
    const transport = input.transport ?? createConfiguredTransport();
    const result = await dispatchBatch({ transport, onlyIds: [outboxId] });
    if (result.sent === 1) return { outboxId, sent: true, note: null };
    if (result.dailyCapReached) {
      return { outboxId, sent: false, note: 'The daily sending limit is reached; it goes out tomorrow.' };
    }
    const [row] = await getDb().execute<{ last_error: string | null }>(sql`
      select last_error from email_outbox where id = ${outboxId}`);
    return { outboxId, sent: false, note: row?.last_error ?? 'It is queued and will be retried.' };
  } catch (error) {
    return {
      outboxId,
      sent: false,
      note: `Queued; it could not be sent now (${error instanceof Error ? error.message : String(error)}).`,
    };
  }
}

/** "No answer needed" (§26.5): clears the wait on this message and any before it. */
export async function markHandled(input: { concertId: number; messageId: number; actorId: string }): Promise<number> {
  const inbound = await loadInbound(input.concertId, input.messageId);
  if (!inbound) throw new ReplyError('That message is no longer in this concert.');
  return getDb().transaction(async (tx) => {
    const count = await markThreadHandled(tx, inbound.threadId, input.actorId, { messageId: inbound.id });
    if (count > 0) {
      await writeAuditLog(
        { action: 'email.reply_handled', ...entity(inbound), after: { messageId: inbound.id, count }, actorId: input.actorId },
        tx,
      );
    }
    return count;
  });
}
