import 'server-only';

import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';

/**
 * The Inbox area (spec/v3.md §26.5, §29.1 "Open threads and bounces"): the
 * concert's threads, newest first.
 *
 * - **Waiting** — a reply nobody has answered or marked handled.
 * - **Bounces** — a thread whose newest bounce is not yet followed by a
 *   successful send to the party's current address. A fixed address clears it
 *   the same way `party_pipeline`'s `BOUNCED` clears.
 * - **All** — every thread.
 */

export const INBOX_VIEWS = ['waiting', 'bounces', 'all'] as const;
export type InboxView = (typeof INBOX_VIEWS)[number];

export type InboxThread = {
  threadId: number;
  kind: 'registration' | 'player';
  /** The registration or player id. */
  addresseeId: number;
  name: string | null;
  email: string | null;
  lastMessageAt: string | null;
  last: { direction: 'INBOUND' | 'OUTBOUND'; isBounce: boolean; subject: string | null; text: string | null } | null;
  waiting: number;
  bounced: boolean;
  total: number;
};

export type InboxCounts = Record<InboxView, number>;

/** Each thread with its concert-scoped addressee, and the facts the views filter on. */
const THREADS = (concertId: number) => sql`
  select t.id as thread_id,
         case when t.registration_id is not null then 'registration' else 'player' end as kind,
         coalesce(t.registration_id, t.player_id) as addressee_id,
         coalesce(r.contact_name, p.full_name) as name,
         coalesce(r.contact_email, p.email)::text as email,
         to_json(t.last_message_at) #>> '{}' as last_message_at,
         (select count(*)::int from email_messages m
           where m.thread_id = t.id and m.deleted_at is null
             and m.direction = 'INBOUND' and not m.is_bounce and m.handled_at is null) as waiting,
         (select count(*)::int from email_messages m where m.thread_id = t.id and m.deleted_at is null) as total,
         coalesce((
           select o.status = 'BOUNCED'
             from email_outbox o
            where o.deleted_at is null
              and o.sent_at is not null
              and (o.registration_id = t.registration_id or o.player_id = t.player_id)
              and o.to_email = coalesce(r.contact_email, p.email)
            order by o.sent_at desc, o.id desc
            limit 1), false) as bounced
    from email_threads t
    left join registrations r on r.id = t.registration_id and r.deleted_at is null
    left join shows s on s.id = r.show_id
    left join players p on p.id = t.player_id and p.deleted_at is null
   where t.deleted_at is null
     and (s.concert_id = ${concertId} or p.concert_id = ${concertId})`;

type Row = {
  thread_id: string;
  kind: 'registration' | 'player';
  addressee_id: string;
  name: string | null;
  email: string | null;
  last_message_at: string | null;
  waiting: number;
  total: number;
  bounced: boolean;
};

export async function inboxCounts(concertId: number): Promise<InboxCounts> {
  const [row] = await getDb().execute<{ waiting: number; bounces: number; all: number }>(sql`
    select count(*) filter (where x.waiting > 0)::int as waiting,
           count(*) filter (where x.bounced)::int as bounces,
           count(*) filter (where x.total > 0)::int as all
      from (${THREADS(concertId)}) x`);
  return { waiting: row?.waiting ?? 0, bounces: row?.bounces ?? 0, all: row?.all ?? 0 };
}

export async function listInboxThreads(concertId: number, view: InboxView, limit = 200): Promise<InboxThread[]> {
  const filter =
    view === 'waiting' ? sql`x.waiting > 0` : view === 'bounces' ? sql`x.bounced` : sql`x.total > 0`;
  const rows = await getDb().execute<
    Row & {
      last_direction: 'INBOUND' | 'OUTBOUND' | null;
      last_is_bounce: boolean | null;
      last_subject: string | null;
      last_text: string | null;
    }
  >(sql`
    select x.*, l.direction::text as last_direction, l.is_bounce as last_is_bounce,
           l.subject as last_subject, left(l.text, 400) as last_text
      from (${THREADS(concertId)}) x
      left join lateral (
        select m.direction, m.is_bounce, m.subject, m.text
          from email_messages m
         where m.thread_id = x.thread_id and m.deleted_at is null
         order by m.message_at desc, m.id desc
         limit 1) l on true
     where ${filter}
     order by x.last_message_at desc nulls last, x.thread_id desc
     limit ${limit}`);
  return rows.map((r) => ({
    threadId: Number(r.thread_id),
    kind: r.kind,
    addresseeId: Number(r.addressee_id),
    name: r.name,
    email: r.email,
    lastMessageAt: r.last_message_at,
    last:
      r.last_direction === null
        ? null
        : {
            direction: r.last_direction,
            isBounce: r.last_is_bounce ?? false,
            subject: r.last_subject,
            text: r.last_text,
          },
    waiting: r.waiting,
    bounced: r.bounced,
    total: r.total,
  }));
}

export type ThreadMessage = {
  id: number;
  direction: 'INBOUND' | 'OUTBOUND';
  fromEmail: string | null;
  toEmail: string | null;
  subject: string | null;
  text: string | null;
  at: string;
  isBounce: boolean;
  handledAt: string | null;
};

/** One player's thread, for the Inbox's own view of it (a party's is on its record). */
export async function loadThreadMessages(concertId: number, threadId: number): Promise<ThreadMessage[] | null> {
  const [thread] = await getDb().execute<{ id: string }>(sql`
    select x.thread_id as id from (${THREADS(concertId)}) x where x.thread_id = ${threadId}`);
  if (!thread) return null;
  const rows = await getDb().execute<{
    id: string;
    direction: 'INBOUND' | 'OUTBOUND';
    from_email: string | null;
    to_email: string | null;
    subject: string | null;
    text: string | null;
    at: string;
    is_bounce: boolean;
    handled_at: string | null;
  }>(sql`
    select m.id, m.direction::text as direction, m.from_email::text as from_email, m.to_email::text as to_email,
           m.subject, m.text, to_json(m.message_at) #>> '{}' as at, m.is_bounce,
           to_json(m.handled_at) #>> '{}' as handled_at
      from email_messages m
     where m.thread_id = ${threadId} and m.deleted_at is null
     order by m.message_at, m.id`);
  return rows.map((m) => ({
    id: Number(m.id),
    direction: m.direction,
    fromEmail: m.from_email,
    toEmail: m.to_email,
    subject: m.subject,
    text: m.text,
    at: m.at,
    isBounce: m.is_bounce,
    handledAt: m.handled_at,
  }));
}

export type MailboxStatus = {
  folders: { folder: string; lastSyncedAt: string | null; lastError: string | null }[];
};

/** When each folder was last read, and whether it failed — shown above the list. */
export async function mailboxStatus(): Promise<MailboxStatus> {
  const rows = await getDb().execute<{ folder: string; last_synced_at: string | null; last_error: string | null }>(sql`
    select folder, to_json(last_synced_at) #>> '{}' as last_synced_at, last_error
      from mail_sync_state order by folder`);
  return {
    folders: rows.map((r) => ({ folder: r.folder, lastSyncedAt: r.last_synced_at, lastError: r.last_error })),
  };
}
