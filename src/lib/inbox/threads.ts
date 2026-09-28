import 'server-only';

import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import type { Tx } from '@/db/tx';
import type { Addressee } from '@/lib/mail/tagging';

/**
 * Threads and the messages in them (spec/v3.md §26.5) — the app side of the
 * inbox, where an `Addressee` from the mail library becomes a row.
 *
 * **Which messages are stored.** A thread's outbound half is the outbox: the
 * record reads sent tickets, reminders and receipts from `email_outbox`
 * directly (`src/lib/audience/record.ts`). Only two kinds of outbound message
 * are copied into `email_messages`: a `REPLY` an admin wrote here, and a reply
 * written in Gmail itself and read back from Sent Mail. Both are people
 * answering, and both are what clears `REPLY_WAITING`, which `party_pipeline`
 * reads as "the newest message in the thread is an unhandled inbound one". A
 * ticket resend is not an answer, so it is not copied, and it cannot quietly
 * clear a question a guest is still waiting on.
 */

type Executor = Tx | ReturnType<typeof getDb>;

/** The thread for an addressee, created on first use. One per addressee (`P`). */
export async function ensureThread(db: Executor, addressee: Addressee): Promise<number> {
  const rows =
    addressee.kind === 'registration'
      ? await db.execute<{ id: string }>(sql`
          insert into email_threads (registration_id) values (${addressee.id})
          on conflict (registration_id) do update
             set deleted_at = null, updated_at = now()
          returning id`)
      : await db.execute<{ id: string }>(sql`
          insert into email_threads (player_id) values (${addressee.id})
          on conflict (player_id) do update
             set deleted_at = null, updated_at = now()
          returning id`);
  return Number(rows[0].id);
}

export type NewMessage = {
  threadId: number;
  direction: 'INBOUND' | 'OUTBOUND';
  outboxId?: number | null;
  messageId: string | null;
  inReplyTo?: string | null;
  referenceIds?: string[];
  fromEmail?: string | null;
  fromName?: string | null;
  toEmail?: string | null;
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  isBounce?: boolean;
  messageAt: Date;
  folder?: string | null;
  uid?: number | null;
  /** Stored already handled: an auto-reply, which nobody needs to answer. */
  handledAt?: Date | null;
};

/**
 * Stores one message, **once**: `message_id` is unique, so a message read from
 * both INBOX and Sent Mail, or by two overlapping syncs, lands a single row.
 * Returns the new row's id, or `null` when it was already there.
 */
/**
 * Text Postgres will store. A `text` column refuses the NUL character, and a
 * quoted-printable `=00` in a stranger's mail decodes to exactly that — one
 * such message would otherwise fail every sync that reached it.
 */
export function storable(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.replace(/\u0000/g, '');
}

export async function appendMessage(db: Executor, input: NewMessage): Promise<number | null> {
  const m: NewMessage = {
    ...input,
    messageId: storable(input.messageId),
    inReplyTo: storable(input.inReplyTo),
    referenceIds: input.referenceIds?.map((r) => storable(r)!).filter((r) => r.length > 0),
    fromEmail: storable(input.fromEmail),
    fromName: storable(input.fromName),
    toEmail: storable(input.toEmail),
    subject: storable(input.subject),
    text: storable(input.text),
    html: storable(input.html),
  };
  const refs =
    m.referenceIds && m.referenceIds.length > 0
      ? sql`array[${sql.join(
          m.referenceIds.map((r) => sql`${r}`),
          sql`, `,
        )}]::text[]`
      : sql`null`;
  const rows = await db.execute<{ id: string }>(sql`
    insert into email_messages
      (thread_id, direction, outbox_id, message_id, in_reply_to, reference_ids,
       from_email, from_name, to_email, subject, text, html, is_bounce,
       message_at, folder, uid, handled_at)
    values
      (${m.threadId}, ${m.direction}, ${m.outboxId ?? null}, ${m.messageId}, ${m.inReplyTo ?? null}, ${refs},
       ${m.fromEmail ?? null}, ${m.fromName ?? null}, ${m.toEmail ?? null}, ${m.subject ?? null},
       ${m.text ?? null}, ${m.html ?? null}, ${m.isBounce ?? false},
       ${m.messageAt.toISOString()}, ${m.folder ?? null}, ${m.uid ?? null},
       ${m.handledAt ? m.handledAt.toISOString() : null})
    on conflict (message_id) do nothing
    returning id`);
  if (rows.length === 0) return null;
  await db.execute(sql`
    update email_threads
       set last_message_at = greatest(coalesce(last_message_at, ${m.messageAt.toISOString()}::timestamptz),
                                      ${m.messageAt.toISOString()}::timestamptz),
           updated_at = now()
     where id = ${m.threadId}`);
  return Number(rows[0].id);
}

/**
 * Marks every waiting reply in a thread handled (§26.5): an admin replied, or
 * said it needs no answer. `upTo` limits it to replies that arrived no later
 * than a moment, or than a given message — a reply that lands after the answer
 * is a new question.
 *
 * A message bound is compared in SQL, never through a JS `Date`: Postgres
 * keeps microseconds and a `Date` does not, so "up to this message" rebuilt
 * from its own timestamp would leave that very message out.
 */
export async function markThreadHandled(
  db: Executor,
  threadId: number,
  by: string | null,
  upTo: Date | { messageId: number } = new Date(),
): Promise<number> {
  const bound =
    upTo instanceof Date
      ? sql`${upTo.toISOString()}::timestamptz`
      : sql`(select message_at from email_messages where id = ${upTo.messageId})`;
  const rows = await db.execute<{ id: string }>(sql`
    update email_messages
       set handled_at = now(), handled_by = ${by}, updated_at = now()
     where thread_id = ${threadId}
       and direction = 'INBOUND'
       and not is_bounce
       and handled_at is null
       and deleted_at is null
       and message_at <= ${bound}
    returning id`);
  return rows.length;
}
