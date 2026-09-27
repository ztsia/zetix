import 'server-only';

import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import type { ParsedMessage } from '@/lib/mail/parse';
import { findPlusTag, type Addressee } from '@/lib/mail/tagging';

/**
 * Who a message belongs to (spec/v3.md §26.4).
 *
 * In order: `In-Reply-To`, then `References` newest first, then our plus tag
 * on any recipient, then — for a reply that lost all three — the sender's
 * address, if we sent that address something within `inbox.match_fallback_days`
 * of the reply. Mail that matches none of these is not ours to store (§26.1).
 */

export type MatchVia = 'in-reply-to' | 'references' | 'plus-tag' | 'sender';

export type Match = {
  addressee: Addressee;
  via: MatchVia;
  /** The outbox row the message refers to, when it names one of ours. */
  outboxId: number | null;
  /** The thread already holding the message it refers to, when there is one. */
  threadId: number | null;
  /**
   * The stored message it refers to, when that is one of ours in a thread
   * rather than an outbox row — a guest's reply that a Gmail-written answer
   * quotes. Handling stops there (§26.5).
   */
  messageRowId: number | null;
};

type Found = Omit<Match, 'via'>;

/**
 * A live addressee, following merges (§25.5): a reply to a party that has
 * since been merged into another belongs to the survivor. A deleted party, or
 * a player who no longer exists, is nobody's.
 */
async function live(addressee: Addressee): Promise<Addressee | null> {
  if (addressee.kind === 'player') {
    const [row] = await getDb().execute<{ id: string }>(sql`
      select id from players where id = ${addressee.id} and deleted_at is null`);
    return row ? addressee : null;
  }
  let id = addressee.id;
  // Bounded: a merge chain longer than this is a data error, not a party.
  for (let hop = 0; hop < 8; hop += 1) {
    const [row] = await getDb().execute<{ merged_into_id: string | null; deleted_at: string | null }>(sql`
      select merged_into_id, deleted_at from registrations where id = ${id}`);
    if (!row) return null;
    if (row.merged_into_id !== null) {
      id = Number(row.merged_into_id);
      continue;
    }
    return row.deleted_at === null ? { kind: 'registration', id } : null;
  }
  return null;
}

function addresseeFrom(registrationId: string | null, playerId: string | null): Addressee | null {
  if (registrationId !== null) return { kind: 'registration', id: Number(registrationId) };
  if (playerId !== null) return { kind: 'player', id: Number(playerId) };
  return null;
}

/**
 * A `Message-ID` we sent (the outbox) or already hold (a thread).
 *
 * `outboundOnly` is for a bounce: only a message *we* sent can bounce back to
 * us, so a delivery notice that quotes a guest's own message id — mail they
 * sent elsewhere that failed — is not ours to record (U's QA, finding 4).
 */
export async function findByMessageId(
  messageId: string,
  options: { outboundOnly?: boolean } = {},
): Promise<Found | null> {
  const [outbox] = await getDb().execute<{ id: string; registration_id: string | null; player_id: string | null }>(sql`
    select id, registration_id, player_id from email_outbox where message_id = ${messageId}`);
  if (outbox) {
    const addressee = addresseeFrom(outbox.registration_id, outbox.player_id);
    const current = addressee && (await live(addressee));
    return current ? { addressee: current, outboxId: Number(outbox.id), threadId: null, messageRowId: null } : null;
  }

  const [stored] = await getDb().execute<{
    id: string;
    thread_id: string;
    registration_id: string | null;
    player_id: string | null;
  }>(sql`
    select m.id, m.thread_id, t.registration_id, t.player_id
      from email_messages m
      join email_threads t on t.id = m.thread_id
     where m.message_id = ${messageId}
       ${options.outboundOnly ? sql`and m.direction = 'OUTBOUND'` : sql``}`);
  if (stored) {
    const addressee = addresseeFrom(stored.registration_id, stored.player_id);
    const current = addressee && (await live(addressee));
    if (!current) return null;
    // The thread is kept only while it still belongs to the same addressee (not after a merge).
    const sameThread =
      addressee.kind === current.kind && addressee.id === current.id ? Number(stored.thread_id) : null;
    return {
      addressee: current,
      outboxId: null,
      threadId: sameThread,
      messageRowId: sameThread === null ? null : Number(stored.id),
    };
  }
  return null;
}

/** The first header-based match: `In-Reply-To`, then `References` newest first. */
export async function matchByHeaders(
  m: Pick<ParsedMessage, 'inReplyTo' | 'references'>,
): Promise<Match | null> {
  if (m.inReplyTo) {
    const found = await findByMessageId(m.inReplyTo);
    if (found) return { ...found, via: 'in-reply-to' };
  }
  for (const id of [...m.references].reverse()) {
    if (id === m.inReplyTo) continue;
    const found = await findByMessageId(id);
    if (found) return { ...found, via: 'references' };
  }
  return null;
}

export async function matchInbound(
  m: ParsedMessage,
  opts: { mailbox: string; fallbackDays: number; receivedAt: Date },
): Promise<Match | null> {
  const byHeaders = await matchByHeaders(m);
  if (byHeaders) return byHeaders;

  const tagged = findPlusTag(m.recipients, opts.mailbox);
  if (tagged) {
    const current = await live(tagged);
    if (current) return { addressee: current, via: 'plus-tag', outboxId: null, threadId: null, messageRowId: null };
  }

  const sender = m.from?.address;
  if (!sender || sender.toLowerCase() === opts.mailbox.toLowerCase()) return null;

  /**
   * The last resort, and deliberately narrow: an address we actually wrote to,
   * recently, before this arrived. Without the window a guest who registered
   * for last year's concert would have every stray email filed against them.
   */
  const at = opts.receivedAt.toISOString();
  const candidates = await getDb().execute<{ registration_id: string | null; player_id: string | null }>(sql`
    select registration_id, player_id
      from email_outbox
     where to_email = ${sender}
       and sent_at is not null
       and deleted_at is null
       and sent_at <= ${at}::timestamptz
       and sent_at >= ${at}::timestamptz - (interval '1 day' * ${opts.fallbackDays})
     order by sent_at desc, id desc
     limit 5`);
  for (const row of candidates) {
    const addressee = addresseeFrom(row.registration_id, row.player_id);
    const current = addressee && (await live(addressee));
    if (current) return { addressee: current, via: 'sender', outboxId: null, threadId: null, messageRowId: null };
  }
  return null;
}
