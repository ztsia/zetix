import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import { createConcert, createPlayers, createRegistration, createSegment, createShow, setSystemSetting } from '../helpers/fixtures';
import { inboxCounts, listInboxThreads, loadThreadMessages } from '@/lib/inbox/queries';
import { markHandled, replySubject, sendReply } from '@/lib/inbox/reply';
import { parseMessage } from '@/lib/mail/parse';
import { createStreamTransport, type MailTransport, type SendResult } from '@/lib/mail/transport';

/**
 * Answering from the record, and the Inbox's views (spec/v3.md §26.5–§26.6).
 */

const MAILBOX = 'events@example.org';
const ADMIN = '00000000-0000-4000-8000-0000000000aa';

function capturing(): MailTransport & { sent: SendResult[] } {
  const inner = createStreamTransport('LCO', MAILBOX);
  const sent: SendResult[] = [];
  return {
    sender: inner.sender,
    sent,
    async send(m) {
      const r = await inner.send(m);
      sent.push(r);
      return r;
    },
    close: () => inner.close(),
  };
}

let concerts = 0;
async function party(name = 'Ada Guest') {
  const concertId = await createConcert(`Concert ${(concerts += 1)}`);
  const showId = await createShow(concertId, 100);
  const segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 50 });
  const registrationId = await createRegistration({ showId, segmentId, contactName: name });
  await sql`update registrations set contact_email = 'ada@guest.example' where id = ${registrationId}`;
  return { concertId, registrationId };
}

async function inbound(opts: { registrationId?: number; playerId?: number; isBounce?: boolean; subject?: string; minutesAgo?: number }) {
  const [thread] = await sql<{ id: string }[]>`
    insert into email_threads (registration_id, player_id) values (${opts.registrationId ?? null}, ${opts.playerId ?? null})
    on conflict do nothing returning id`;
  const threadId = thread
    ? thread.id
    : (await sql<{ id: string }[]>`select id from email_threads where registration_id = ${opts.registrationId ?? null} or player_id = ${opts.playerId ?? null}`)[0].id;
  const [m] = await sql<{ id: string }[]>`
    insert into email_messages (thread_id, direction, message_id, from_email, subject, text, is_bounce, message_at)
    values (${threadId}, 'INBOUND', ${`<m${Math.random().toString(36).slice(2)}@guest.example>`}, 'old@guest.example',
            ${opts.subject ?? 'Re: Your tickets'}, 'Can I bring my daughter?', ${opts.isBounce ?? false},
            now() - (interval '1 minute' * ${opts.minutesAgo ?? 5}))
    returning id`;
  await sql`update email_threads set last_message_at = now() where id = ${threadId}`;
  return { threadId: Number(threadId), messageId: Number(m.id) };
}

beforeEach(async () => {
  await resetDb();
  concerts = 0;
  await sql`insert into app_users (id, email, display_name, role) values (${ADMIN}, 'ana@example.test', 'Ana', 'ADMIN')`;
  for (const [key, value] of Object.entries({
    'email.max_per_dispatch': 25,
    'email.max_per_day': 450,
    'email.inter_message_delay_ms': 0,
    'email.max_attempts': 3,
    'email.merge_attachments_above': 8,
    'email.max_attachment_mb': 20,
  })) {
    await setSystemSetting(key, value);
  }
});

describe('sendReply', () => {
  it('sends at once to the party’s current address, threaded, and clears the wait', async () => {
    const { concertId, registrationId } = await party();
    const { messageId } = await inbound({ registrationId });
    const transport = capturing();

    const result = await sendReply({ concertId, messageId, body: 'Yes — see you there.', actorId: ADMIN, transport });
    expect(result.sent).toBe(true);

    const [row] = await sql<{ purpose: string; status: string; to_email: string; subject: string; template_key: string | null }[]>`
      select purpose, status, to_email, subject, template_key from email_outbox where id = ${result.outboxId}`;
    // Resolved late: the party's address now, not the message's From (§24.3).
    expect(row).toEqual({ purpose: 'REPLY', status: 'SENT', to_email: 'ada@guest.example', subject: 'Re: Your tickets', template_key: null });

    const back = await parseMessage(transport.sent[0].raw!);
    expect(back.inReplyTo).toMatch(/^<m.+@guest\.example>$/);

    const [flag] = await sql<{ flag_reply_waiting: boolean }[]>`
      select flag_reply_waiting from party_pipeline where registration_id = ${registrationId}`;
    expect(flag.flag_reply_waiting).toBe(false);
    const [handled] = await sql<{ handled_by: string }[]>`select handled_by from email_messages where id = ${messageId}`;
    expect(handled.handled_by).toBe(ADMIN);

    const [audit] = await sql<{ entity_type: string; actor_id: string }[]>`
      select entity_type, actor_id from audit_log where action = 'email.reply_sent'`;
    expect(audit).toEqual({ entity_type: 'registration', actor_id: ADMIN });
  });

  it('can send two replies in a row: REPLY is outside the pending-message index', async () => {
    const { concertId, registrationId } = await party();
    const { messageId } = await inbound({ registrationId });
    const failing: MailTransport = { sender: MAILBOX, send: async () => { throw new Error('421 later'); }, close: async () => {} };
    const first = await sendReply({ concertId, messageId, body: 'One', actorId: ADMIN, transport: failing });
    const second = await sendReply({ concertId, messageId, body: 'Two', actorId: ADMIN, transport: failing });
    expect(first.sent).toBe(false);
    expect(first.note).toContain('421');
    expect(second.outboxId).not.toBe(first.outboxId);
  });

  it('refuses a bounce, an empty body, and a message from another concert', async () => {
    const a = await party();
    const b = await party('Other');
    const bounce = await inbound({ registrationId: a.registrationId, isBounce: true });
    const other = await inbound({ registrationId: b.registrationId });
    const transport = capturing();

    await expect(sendReply({ concertId: a.concertId, messageId: bounce.messageId, body: 'hi', actorId: ADMIN, transport })).rejects.toThrow(/bounce/i);
    await expect(sendReply({ concertId: a.concertId, messageId: other.messageId, body: 'hi', actorId: ADMIN, transport })).rejects.toThrow(/no longer in this concert/);
    const ok = await inbound({ registrationId: a.registrationId, minutesAgo: 1 });
    await expect(sendReply({ concertId: a.concertId, messageId: ok.messageId, body: '   ', actorId: ADMIN, transport })).rejects.toThrow(/Write something/);
    expect(transport.sent).toHaveLength(0);
  });

  it('answers a player’s digest reply to the player’s address', async () => {
    const concertId = await createConcert('Players');
    const [playerId] = await createPlayers(concertId, 1);
    await sql`update players set email = 'violin@players.example' where id = ${playerId}`;
    const { messageId } = await inbound({ playerId });
    const transport = capturing();
    const result = await sendReply({ concertId, messageId, body: 'Thanks!', actorId: ADMIN, transport });
    expect(result.sent).toBe(true);
    const [row] = await sql<{ player_id: string; to_email: string }[]>`select player_id, to_email from email_outbox where id = ${result.outboxId}`;
    expect(row).toEqual({ player_id: String(playerId), to_email: 'violin@players.example' });
    expect(transport.sent[0].raw!.toString()).toMatch(new RegExp(`Reply-To: events\\+pl${playerId}@example\\.org`));
  });
});

describe('a reply and the questions after it (QA finding 2)', () => {
  it('leaves a later question waiting, whether the reply goes now or on a retry', async () => {
    const { concertId, registrationId } = await party();
    const first = await inbound({ registrationId, minutesAgo: 30 });
    const later = await inbound({ registrationId, minutesAgo: 1 });
    await sendReply({ concertId, messageId: first.messageId, body: 'Answering the first.', actorId: ADMIN, transport: capturing() });

    const rows = await sql<{ id: string; handled: boolean }[]>`
      select id, handled_at is not null as handled from email_messages where direction = 'INBOUND' order by message_at`;
    expect(rows.map((r) => [Number(r.id), r.handled])).toEqual([
      [first.messageId, true],
      [later.messageId, false],
    ]);
    const [flag] = await sql<{ flag_reply_waiting: boolean }[]>`
      select flag_reply_waiting from party_pipeline where registration_id = ${registrationId}`;
    expect(flag.flag_reply_waiting).toBe(true);
  });
});

describe('markHandled', () => {
  it('clears this reply and the ones before it, not a later one', async () => {
    const { concertId, registrationId } = await party();
    const earlier = await inbound({ registrationId, minutesAgo: 30 });
    const middle = await inbound({ registrationId, minutesAgo: 20 });
    const later = await inbound({ registrationId, minutesAgo: 10 });
    expect(await markHandled({ concertId, messageId: middle.messageId, actorId: ADMIN })).toBe(2);

    const rows = await sql<{ id: string; handled: boolean }[]>`
      select id, handled_at is not null as handled from email_messages order by message_at`;
    expect(rows.map((r) => [Number(r.id), r.handled])).toEqual([
      [earlier.messageId, true],
      [middle.messageId, true],
      [later.messageId, false],
    ]);
  });
});

describe('replySubject', () => {
  it('adds Re: once', () => {
    expect(replySubject('Your tickets')).toBe('Re: Your tickets');
    expect(replySubject('RE: Your tickets')).toBe('RE: Your tickets');
    expect(replySubject(null)).toBe('Re: your message');
  });
});

describe('the Inbox views', () => {
  it('counts and lists waiting, bounced and all threads for this concert only', async () => {
    const waiting = await party('Waiting Wendy');
    await inbound({ registrationId: waiting.registrationId });

    const handledParty = await createRegistration({
      showId: (await sql<{ show_id: string }[]>`select show_id from registrations where id = ${waiting.registrationId}`)[0].show_id as unknown as number,
      segmentId: (await sql<{ segment_id: string }[]>`select segment_id from registrations where id = ${waiting.registrationId}`)[0].segment_id as unknown as number,
      contactName: 'Bounced Bob',
    });
    await sql`update registrations set contact_email = 'bob@dead.example' where id = ${handledParty}`;
    const bounce = await inbound({ registrationId: handledParty, isBounce: true });
    await sql`
      insert into email_outbox (registration_id, purpose, template_key, to_email, subject, body_md, status, sent_at, bounced_at)
      values (${handledParty}, 'TICKETS', 'public_ticket', 'bob@dead.example', 's', 'b', 'BOUNCED', now(), now())`;
    void bounce;

    const elsewhere = await party('Elsewhere');
    await inbound({ registrationId: elsewhere.registrationId });

    expect(await inboxCounts(waiting.concertId)).toEqual({ waiting: 1, bounces: 1, all: 2 });
    expect((await listInboxThreads(waiting.concertId, 'waiting')).map((t) => t.name)).toEqual(['Waiting Wendy']);
    expect((await listInboxThreads(waiting.concertId, 'bounces')).map((t) => t.name)).toEqual(['Bounced Bob']);
    expect((await listInboxThreads(waiting.concertId, 'all'))).toHaveLength(2);

    // Fixing the address clears the bounce, the way the party flag clears.
    await sql`update registrations set contact_email = 'bob@alive.example' where id = ${handledParty}`;
    expect((await inboxCounts(waiting.concertId)).bounces).toBe(0);
  });

  it('opens a thread only within its own concert', async () => {
    const a = await party();
    const b = await party('Other');
    const { threadId } = await inbound({ registrationId: a.registrationId });
    expect(await loadThreadMessages(a.concertId, threadId)).toHaveLength(1);
    expect(await loadThreadMessages(b.concertId, threadId)).toBeNull();
  });
});
