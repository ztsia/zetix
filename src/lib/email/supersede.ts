import 'server-only';
import { sql } from 'drizzle-orm';
import type { Tx } from '@/lib/commands/define';
import type { AuditEntry } from '@/lib/audit';
import type { MessagePurpose } from './templates';

/**
 * Drafting a message **supersedes** whatever was pending for the same addressee
 * and purpose (spec/v3.md §24.2, decision 52).
 *
 * The pending index (`outbox_no_duplicate_pending`) allows one `DRAFT`,
 * `QUEUED` or `SENDING` row per `(registration, purpose)`. V1's
 * `queueBlast()` met a conflict with `on conflict do nothing`, which under a
 * per-purpose key means a redraft under a different template is silently
 * *refused* — the old wording goes out. Superseding is the explicit way past:
 * in one transaction the pending row is set `CANCELLED`, the new row is
 * inserted, and the old row's `superseded_by_id` points at the new one, so the
 * history says why it was cancelled and two messages can never both send.
 *
 * **`SENDING` is never superseded.** The dispatcher holds it and may already
 * have handed it to the mail server; cancelling it underneath would record a
 * message as withdrawn that the guest then receives. The caller gets
 * {@link MessageInFlightError} and says so.
 *
 * `REPLY` is outside the pending index (§24.2) and is never superseded: two
 * replies a person wrote are two messages.
 */

export type Addressee = { registrationId: number } | { playerId: number };

export type NewMessage = {
  addressee: Addressee;
  purpose: MessagePurpose;
  templateKey: string | null;
  toEmail: string;
  toName: string | null;
  subject: string;
  bodyMd: string;
  context: Record<string, string> | null;
  /** `DRAFT` waits for a person; `QUEUED` is due for the dispatcher (§24.1: the wizard is the review). */
  status: 'DRAFT' | 'QUEUED';
  scheduledFor?: Date | null;
};

export class MessageInFlightError extends Error {
  constructor() {
    super('A message for this is being sent right now. Wait for it to finish, then try again.');
    this.name = 'MessageInFlightError';
  }
}

const addresseeColumn = (a: Addressee) =>
  'registrationId' in a ? sql`registration_id = ${a.registrationId}` : sql`player_id = ${a.playerId}`;

/**
 * Insert `message`, cancelling and pointing at it every pending row it
 * replaces. Runs in the caller's transaction; `audit` is called once per
 * superseded row, so the Activity log shows what was replaced and by what.
 */
export async function draftSuperseding(
  tx: Tx,
  message: NewMessage,
  audit?: (entry: Omit<AuditEntry, 'actorId' | 'reason' | 'concertId' | 'commandRunId'>) => Promise<void>,
): Promise<{ id: number; superseded: number[] }> {
  if (message.purpose === 'REPLY') throw new Error('A reply is never superseded; insert it directly.');

  const pending = await tx.execute<{ id: string; status: string; template_key: string | null }>(sql`
    select id, status, template_key from email_outbox
     where ${addresseeColumn(message.addressee)}
       and purpose = ${message.purpose}::message_purpose
       and status in ('DRAFT', 'QUEUED', 'SENDING')
     order by id
     for update
  `);
  if (pending.some((row) => row.status === 'SENDING')) throw new MessageInFlightError();

  const superseded = pending.map((row) => Number(row.id));
  if (superseded.length > 0) {
    await tx.execute(sql`
      update email_outbox set status = 'CANCELLED', updated_at = now()
       where id in (${sql.join(superseded.map((id) => sql`${id}`), sql`, `)})
    `);
  }

  const registrationId = 'registrationId' in message.addressee ? message.addressee.registrationId : null;
  const playerId = 'playerId' in message.addressee ? message.addressee.playerId : null;
  const [inserted] = await tx.execute<{ id: string }>(sql`
    insert into email_outbox (
      registration_id, player_id, purpose, template_key, to_email, to_name,
      subject, body_md, context, status, scheduled_for
    ) values (
      ${registrationId}, ${playerId}, ${message.purpose}::message_purpose, ${message.templateKey},
      ${message.toEmail}, ${message.toName}, ${message.subject}, ${message.bodyMd},
      ${message.context ? JSON.stringify(message.context) : null}::jsonb,
      ${message.status}::outbox_status, ${message.scheduledFor?.toISOString() ?? null}::timestamptz
    )
    returning id
  `);
  const id = Number(inserted.id);

  if (superseded.length > 0) {
    await tx.execute(sql`
      update email_outbox set superseded_by_id = ${id}
       where id in (${sql.join(superseded.map((old) => sql`${old}`), sql`, `)})
    `);
    for (const row of pending) {
      await audit?.({
        action: 'email.message_superseded',
        entityType: 'email_outbox',
        entityId: Number(row.id),
        before: { status: row.status, templateKey: row.template_key },
        after: { status: 'CANCELLED', supersededById: id, templateKey: message.templateKey },
      });
    }
  }

  return { id, superseded };
}
