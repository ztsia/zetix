import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';
import {
  createConcert,
  createPlayers,
  createRegistration,
  createSegment,
  createShow,
  setSystemSetting,
} from '../helpers/fixtures';
import { runInboxSync } from '@/lib/inbox/run';
import { syncMailbox } from '@/lib/inbox/sync';
import { MemoryInbox } from '@/lib/mail/memory-inbox';

/**
 * The inbox sync end to end against the real schema (spec/v3.md §26.3–§26.5):
 * an in-memory mailbox with IMAP's UID semantics on one side, `party_pipeline`
 * on the other. What a test here asserts is what the console would show.
 */

const MAILBOX = 'events@example.org';
const DAY = 24 * 60 * 60 * 1000;
const fixture = (name: string) => readFileSync(join(__dirname, '../mail/fixtures', name), 'utf8');

let concerts = 0;
async function party(contactEmail = 'guest@guest.example') {
  const concertId = await createConcert(`Concert ${(concerts += 1)}`);
  const showId = await createShow(concertId, 100);
  const segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 50 });
  const registrationId = await createRegistration({ showId, segmentId, contactName: 'Ada Guest' });
  await sql`update registrations set contact_email = ${contactEmail} where id = ${registrationId}`;
  return { concertId, registrationId };
}

/** A message we sent, as the dispatcher leaves it. */
async function sent(opts: {
  registrationId?: number;
  playerId?: number;
  messageId: string;
  to?: string;
  sentAt?: Date;
  purpose?: string;
  templateKey?: string;
}) {
  const [row] = await sql<{ id: string }[]>`
    insert into email_outbox (registration_id, player_id, purpose, template_key, to_email, subject, body_md,
                              status, sent_at, message_id)
    values (${opts.registrationId ?? null}, ${opts.playerId ?? null},
            ${opts.purpose ?? 'TICKETS'}::message_purpose, ${opts.templateKey ?? 'public_ticket'},
            ${opts.to ?? 'guest@guest.example'}, 'Your tickets', 'Hello',
            'SENT', ${(opts.sentAt ?? new Date(Date.now() - DAY)).toISOString()}, ${opts.messageId})
    returning id`;
  return Number(row.id);
}

function mail(h: {
  from?: string;
  to?: string;
  messageId?: string | null;
  inReplyTo?: string;
  references?: string;
  subject?: string;
  body?: string;
}): string {
  const lines = [
    `From: ${h.from ?? 'Ada Guest <guest@guest.example>'}`,
    `To: ${h.to ?? MAILBOX}`,
    `Subject: ${h.subject ?? 'Re: Your tickets'}`,
    ...(h.messageId === null ? [] : [`Message-ID: ${h.messageId ?? `<r${Math.random().toString(36).slice(2)}@guest.example>`}`]),
    ...(h.inReplyTo ? [`In-Reply-To: ${h.inReplyTo}`] : []),
    ...(h.references ? [`References: ${h.references}`] : []),
    'Date: Sat, 26 Sep 2026 12:00:00 +0000',
    'Content-Type: text/plain; charset=utf-8',
    '',
    h.body ?? 'Can I bring my daughter as well?',
  ];
  return lines.join('\r\n');
}

const sync = (inbox: MemoryInbox, deadline = Date.now() + 30_000) =>
  syncMailbox({ inbox, mailbox: MAILBOX, deadline, fallbackDays: 30 });

async function flags(registrationId: number) {
  const [row] = await sql<{ flag_reply_waiting: boolean; flag_bounced: boolean }[]>`
    select flag_reply_waiting, flag_bounced from party_pipeline where registration_id = ${registrationId}`;
  return row;
}

async function messagesOf(registrationId: number) {
  return sql<{ direction: string; is_bounce: boolean; outbox_id: string | null; message_id: string; handled_at: string | null }[]>`
    select m.direction, m.is_bounce, m.outbox_id, m.message_id, m.handled_at
      from email_messages m join email_threads t on t.id = m.thread_id
     where t.registration_id = ${registrationId}
     order by m.message_at, m.id`;
}

beforeEach(async () => {
  await resetDb();
  concerts = 0;
});

describe('matching a reply (§26.4)', () => {
  it('by In-Reply-To: stored on the party, REPLY_WAITING raised, and in its Activity', async () => {
    const { registrationId } = await party();
    const outboxId = await sent({ registrationId, messageId: '<1.aaaa@example.org>' });
    const inbox = new MemoryInbox();
    inbox.deliver('inbox', mail({ inReplyTo: '<1.aaaa@example.org>' }));

    const report = await sync(inbox);
    expect(report.folders[0]).toMatchObject({ role: 'inbox', read: 1, stored: 1, replies: 1 });

    const messages = await messagesOf(registrationId);
    expect(messages).toEqual([expect.objectContaining({ direction: 'INBOUND', is_bounce: false, outbox_id: String(outboxId) })]);
    expect((await flags(registrationId)).flag_reply_waiting).toBe(true);

    const audit = await sql<{ action: string; entity_type: string; entity_id: string }[]>`
      select action, entity_type, entity_id from audit_log where action = 'email.reply_received'`;
    expect(audit).toEqual([{ action: 'email.reply_received', entity_type: 'registration', entity_id: String(registrationId) }]);
  });

  it('by References when In-Reply-To names something we never sent', async () => {
    const { registrationId } = await party();
    await sent({ registrationId, messageId: '<2.bbbb@example.org>' });
    const inbox = new MemoryInbox();
    inbox.deliver('inbox', mail({ inReplyTo: '<unknown@guest.example>', references: '<2.bbbb@example.org> <unknown@guest.example>' }));
    await sync(inbox);
    expect(await messagesOf(registrationId)).toHaveLength(1);
  });

  it('by the plus tag when the client dropped every threading header', async () => {
    const { registrationId } = await party();
    const inbox = new MemoryInbox();
    inbox.deliver('inbox', mail({ to: `events+p${registrationId}@example.org` }));
    await sync(inbox);
    expect(await messagesOf(registrationId)).toHaveLength(1);
  });

  it('a digest reply by the pl tag, onto the player thread', async () => {
    const concertId = await createConcert('Players');
    const [playerId] = await createPlayers(concertId, 1);
    const inbox = new MemoryInbox();
    inbox.deliver('inbox', mail({ to: `events+pl${playerId}@example.org` }));
    await sync(inbox);
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from email_messages m join email_threads t on t.id = m.thread_id
       where t.player_id = ${playerId}`;
    expect(row.n).toBe(1);
  });

  it('by sender only within inbox.match_fallback_days of a message to that address', async () => {
    const { registrationId } = await party('recent@guest.example');
    await sent({ registrationId, messageId: '<3.cccc@example.org>', to: 'recent@guest.example', sentAt: new Date(Date.now() - 5 * DAY) });
    const old = await party('old@guest.example');
    await sent({ registrationId: old.registrationId, messageId: '<4.dddd@example.org>', to: 'old@guest.example', sentAt: new Date(Date.now() - 40 * DAY) });

    const inbox = new MemoryInbox();
    inbox.deliver('inbox', mail({ from: 'recent@guest.example' }));
    inbox.deliver('inbox', mail({ from: 'old@guest.example' }));
    inbox.deliver('inbox', mail({ from: 'stranger@nowhere.example' }));
    const report = await sync(inbox);

    expect(report.folders[0]).toMatchObject({ read: 3, stored: 1, skipped: 2 });
    expect(await messagesOf(registrationId)).toHaveLength(1);
    expect(await messagesOf(old.registrationId)).toHaveLength(0);
  });

  it('never stores mail that matches nothing (§26.1)', async () => {
    await party();
    const inbox = new MemoryInbox();
    inbox.deliver('inbox', mail({ from: 'newsletter@shop.example', subject: 'Sale!' }));
    await sync(inbox);
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from email_messages`;
    expect(row.n).toBe(0);
    const [threads] = await sql<{ n: number }[]>`select count(*)::int as n from email_threads`;
    expect(threads.n).toBe(0);
  });

  it('files a reply to a merged party under the party it was merged into', async () => {
    const survivor = await party();
    const merged = await party('merged@guest.example');
    await sent({ registrationId: merged.registrationId, messageId: '<5.eeee@example.org>', to: 'merged@guest.example' });
    await sql`update registrations set merged_into_id = ${survivor.registrationId}, deleted_at = now()
               where id = ${merged.registrationId}`;
    const inbox = new MemoryInbox();
    inbox.deliver('inbox', mail({ inReplyTo: '<5.eeee@example.org>' }));
    await sync(inbox);
    expect(await messagesOf(survivor.registrationId)).toHaveLength(1);
  });

  it('skips a reply for a party that has been deleted', async () => {
    const { registrationId } = await party();
    await sent({ registrationId, messageId: '<6.ffff@example.org>' });
    await sql`update registrations set deleted_at = now() where id = ${registrationId}`;
    const inbox = new MemoryInbox();
    inbox.deliver('inbox', mail({ inReplyTo: '<6.ffff@example.org>' }));
    const report = await sync(inbox);
    expect(report.folders[0]).toMatchObject({ stored: 0, skipped: 1 });
  });
});

describe('bounces (§26.4)', () => {
  it("marks the outbox row BOUNCED with bounced_at and the code, and flags the party", async () => {
    const { registrationId } = await party('nobody@invalid-guest.example');
    const outboxId = await sent({
      registrationId,
      messageId: '<41.9f2c1e0a7b3d4c5e@example.org>',
      to: 'nobody@invalid-guest.example',
    });
    const inbox = new MemoryInbox();
    inbox.deliver('inbox', fixture('gmail-bounce.eml'));
    const report = await sync(inbox);
    expect(report.folders[0]).toMatchObject({ stored: 1, bounces: 1 });

    const [row] = await sql<{ status: string; bounced_at: string | null; bounce_code: string; bounce_detail: string }[]>`
      select status, bounced_at, bounce_code, bounce_detail from email_outbox where id = ${outboxId}`;
    expect(row.status).toBe('BOUNCED');
    expect(row.bounced_at).not.toBeNull();
    expect(row.bounce_code).toBe('5.1.1');
    expect(row.bounce_detail).toContain('does not exist');

    expect(await flags(registrationId)).toMatchObject({ flag_bounced: true, flag_reply_waiting: false });
    expect(await messagesOf(registrationId)).toEqual([
      expect.objectContaining({ direction: 'INBOUND', is_bounce: true, outbox_id: String(outboxId) }),
    ]);
    const [audit] = await sql<{ entity_type: string; entity_id: string }[]>`
      select entity_type, entity_id from audit_log where action = 'email.bounced'`;
    expect(audit).toEqual({ entity_type: 'registration', entity_id: String(registrationId) });
  });

  it('leaves a delayed notice alone: the message is still SENT and nothing is stored', async () => {
    const { registrationId } = await party('slow@guest.example');
    const outboxId = await sent({ registrationId, messageId: '<55.aaaaaaaaaaaaaaaa@example.org>', to: 'slow@guest.example' });
    const inbox = new MemoryInbox();
    inbox.deliver('inbox', fixture('delayed.eml'));
    await sync(inbox);
    const [row] = await sql<{ status: string; bounced_at: string | null }[]>`
      select status, bounced_at from email_outbox where id = ${outboxId}`;
    expect(row).toEqual({ status: 'SENT', bounced_at: null });
    expect(await messagesOf(registrationId)).toHaveLength(0);
  });

  it('skips a bounce for a message we never sent', async () => {
    await party();
    const inbox = new MemoryInbox();
    inbox.deliver('inbox', fixture('gmail-bounce.eml'));
    const report = await sync(inbox);
    expect(report.folders[0]).toMatchObject({ stored: 0, skipped: 1 });
  });
});

describe('Sent Mail (§26.3)', () => {
  it('skips our own messages and threads a reply written in Gmail, answering the question', async () => {
    const { registrationId } = await party();
    await sent({ registrationId, messageId: '<7.gggg@example.org>' });
    const inbox = new MemoryInbox();
    inbox.deliver('inbox', mail({ inReplyTo: '<7.gggg@example.org>', messageId: '<q@guest.example>' }), new Date(Date.now() - 60_000));
    inbox.deliver('sent', mail({ from: MAILBOX, to: 'guest@guest.example', messageId: '<7.gggg@example.org>', subject: 'Your tickets' }));
    inbox.deliver('sent', mail({ from: MAILBOX, to: 'guest@guest.example', inReplyTo: '<q@guest.example>', references: '<7.gggg@example.org> <q@guest.example>', body: 'Of course.' }));
    inbox.deliver('sent', mail({ from: MAILBOX, to: 'friend@elsewhere.example', subject: 'Unrelated' }));

    const report = await sync(inbox);
    expect(report.folders[1]).toMatchObject({ role: 'sent', read: 3, stored: 1, skipped: 2 });

    const messages = await messagesOf(registrationId);
    expect(messages.map((m) => m.direction)).toEqual(['INBOUND', 'OUTBOUND']);
    expect(messages[0].handled_at).not.toBeNull();
    expect((await flags(registrationId)).flag_reply_waiting).toBe(false);
  });
});

describe('cursors and budget', () => {
  it('reads only what is new, and stores nothing twice', async () => {
    const { registrationId } = await party();
    await sent({ registrationId, messageId: '<8.hhhh@example.org>' });
    const inbox = new MemoryInbox();
    inbox.deliver('inbox', mail({ inReplyTo: '<8.hhhh@example.org>' }));
    await sync(inbox);
    const second = await sync(inbox);
    expect(second.folders[0].read).toBe(0);

    inbox.deliver('inbox', mail({ inReplyTo: '<8.hhhh@example.org>' }));
    const third = await sync(inbox);
    expect(third.folders[0]).toMatchObject({ read: 1, stored: 1 });
    expect(await messagesOf(registrationId)).toHaveLength(2);
  });

  it('re-reads the window when UIDVALIDITY changes, without duplicating anything', async () => {
    const { registrationId } = await party();
    await sent({ registrationId, messageId: '<9.iiii@example.org>' });
    const inbox = new MemoryInbox();
    inbox.deliver('inbox', mail({ inReplyTo: '<9.iiii@example.org>', messageId: '<fixed@guest.example>' }));
    await sync(inbox);
    inbox.renumber('inbox');
    const report = await sync(inbox);
    expect(report.folders[0]).toMatchObject({ reset: true, read: 1, stored: 0 });
    expect(await messagesOf(registrationId)).toHaveLength(1);
    const [audits] = await sql<{ n: number }[]>`select count(*)::int as n from audit_log where action = 'email.reply_received'`;
    expect(audits.n).toBe(1);
  });

  it('a first sync reads only the fallback window, and leaves the cursor at the top even when that is empty', async () => {
    const inbox = new MemoryInbox();
    inbox.deliver('inbox', mail({}), new Date(Date.now() - 90 * DAY));
    inbox.deliver('inbox', mail({}), new Date(Date.now() - 60 * DAY));
    const first = await sync(inbox);
    expect(first.folders[0]).toMatchObject({ read: 0, reset: true, complete: true });
    const [state] = await sql<{ last_uid: string }[]>`select last_uid from mail_sync_state where folder = 'INBOX'`;
    expect(Number(state.last_uid)).toBe(2);
  });

  it('starts nothing past its deadline, and resumes where it stopped', async () => {
    const { registrationId } = await party();
    await sent({ registrationId, messageId: '<10.jjjj@example.org>' });
    const inbox = new MemoryInbox();
    for (let i = 0; i < 3; i += 1) inbox.deliver('inbox', mail({ inReplyTo: '<10.jjjj@example.org>' }));

    const none = await sync(inbox, Date.now() - 1);
    expect(none.folders).toEqual([]);

    const all = await sync(inbox);
    expect(all.folders[0]).toMatchObject({ read: 3, stored: 3, complete: true });
  });

  it('records a folder failure on the cursor row and still syncs the other folder', async () => {
    const inbox = new MemoryInbox();
    const broken = Object.assign(Object.create(Object.getPrototypeOf(inbox)), inbox) as MemoryInbox;
    broken.list = async (path, options) => {
      if (path === 'INBOX') throw new Error('NO [UNAVAILABLE] try later');
      return MemoryInbox.prototype.list.call(inbox, path, options);
    };
    const report = await sync(broken);
    expect(report.folders.map((f) => [f.role, f.error])).toEqual([
      ['inbox', 'NO [UNAVAILABLE] try later'],
      ['sent', null],
    ]);
    const [state] = await sql<{ last_error: string }[]>`select last_error from mail_sync_state where folder = 'INBOX'`;
    expect(state.last_error).toContain('UNAVAILABLE');
  });

  it('stores a message with no Message-ID once, however often it is read', async () => {
    const { registrationId } = await party();
    const inbox = new MemoryInbox();
    inbox.deliver('inbox', mail({ to: `events+p${registrationId}@example.org`, messageId: null }));
    await sync(inbox);
    inbox.renumber('inbox');
    await sync(inbox);
    expect(await messagesOf(registrationId)).toHaveLength(1);
  });
});

describe('what one stranger can do to the sync (QA findings 1, 4, 7)', () => {
  it('steps past a message the database refuses, and stores the next', async () => {
    const { registrationId } = await party();
    const tag = `events+p${registrationId}@example.org`;
    const inbox = new MemoryInbox();
    // A quoted-printable NUL, which Postgres refuses in text …
    inbox.deliver('inbox', [
      'From: stranger@x.example', `To: ${tag}`, 'Subject: =?utf-8?Q?a=00b?=', 'Message-ID: <nul@x.example>',
      'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', 'bad=00byte',
    ].join('\r\n'));
    // … a Message-ID too long for the unique index …
    inbox.deliver('inbox', mail({ to: tag, messageId: `<${'x'.repeat(7000)}@x.example>` }));
    // … and a real reply after both.
    inbox.deliver('inbox', mail({ to: tag, messageId: '<after@guest.example>' }));

    const first = await sync(inbox);
    expect(first.folders[0]).toMatchObject({ read: 3, complete: true, error: null });
    const ids = (await messagesOf(registrationId)).map((m) => m.message_id);
    expect(ids).toContain('<after@guest.example>');
    expect(ids).toContain('<nul@x.example>');
    expect(ids.every((id) => id.length < 1000)).toBe(true);

    const second = await sync(inbox);
    expect(second.folders[0].read).toBe(0);
  });

  it('does not record a notice quoting a guest’s own message id as a bounce', async () => {
    const { registrationId } = await party();
    const inbox = new MemoryInbox();
    inbox.deliver('inbox', mail({ to: `events+p${registrationId}@example.org`, messageId: '<guestown@guest.example>' }));
    await sync(inbox);
    inbox.deliver('inbox', [
      'From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>', `To: ${MAILBOX}`,
      'Subject: Delivery Status Notification (Failure)', 'Message-ID: <dsn-guest@mx.google.com>',
      'In-Reply-To: <guestown@guest.example>', 'Content-Type: text/plain', '',
      '550 5.1.1 user unknown', '', 'Message-ID: <guestown@guest.example>',
    ].join('\r\n'));
    const report = await sync(inbox);
    expect(report.folders[0]).toMatchObject({ stored: 0, bounces: 0 });
    expect((await flags(registrationId)).flag_reply_waiting).toBe(true);
  });

  it('keeps an out-of-office in the thread without raising REPLY_WAITING', async () => {
    const { registrationId } = await party();
    await sent({ registrationId, messageId: '<11.kkkk@example.org>' });
    const inbox = new MemoryInbox();
    inbox.deliver('inbox', mail({ inReplyTo: '<11.kkkk@example.org>' }).replace('Subject:', 'Auto-Submitted: auto-replied\r\nSubject:'));
    await sync(inbox);
    expect(await messagesOf(registrationId)).toHaveLength(1);
    expect((await flags(registrationId)).flag_reply_waiting).toBe(false);
  });
});

describe('REPLY_WAITING against later mail (QA findings 2, 3)', () => {
  it('a bounce after an unanswered reply does not hide it', async () => {
    const { registrationId } = await party('nobody@invalid-guest.example');
    await sent({ registrationId, messageId: '<41.9f2c1e0a7b3d4c5e@example.org>', to: 'nobody@invalid-guest.example' });
    const inbox = new MemoryInbox();
    inbox.deliver('inbox', mail({ from: 'other@guest.example', to: `events+p${registrationId}@example.org` }), new Date(Date.now() - 60_000));
    inbox.deliver('inbox', fixture('gmail-bounce.eml'));
    await sync(inbox);
    expect(await flags(registrationId)).toMatchObject({ flag_reply_waiting: true, flag_bounced: true });
  });

  it('a reply written in Gmail handles only up to the message it answers', async () => {
    const { registrationId } = await party();
    await sent({ registrationId, messageId: '<12.llll@example.org>' });
    const inbox = new MemoryInbox();
    inbox.deliver('inbox', mail({ inReplyTo: '<12.llll@example.org>', messageId: '<first-q@guest.example>' }), new Date(Date.now() - 120_000));
    inbox.deliver('inbox', mail({ inReplyTo: '<12.llll@example.org>', messageId: '<second-q@guest.example>' }), new Date(Date.now() - 60_000));
    inbox.deliver('sent', mail({ from: MAILBOX, to: 'guest@guest.example', inReplyTo: '<first-q@guest.example>' }));
    await sync(inbox);
    const rows = await sql<{ message_id: string; handled: boolean }[]>`
      select message_id, handled_at is not null as handled from email_messages
       where direction = 'INBOUND' order by message_at`;
    expect(rows).toEqual([
      { message_id: '<first-q@guest.example>', handled: true },
      { message_id: '<second-q@guest.example>', handled: false },
    ]);
    expect((await flags(registrationId)).flag_reply_waiting).toBe(true);
  });
});

describe('runInboxSync', () => {
  it('reads its settings and reports rather than throwing', async () => {
    await setSystemSetting('inbox.sync_budget_seconds', 20);
    await setSystemSetting('inbox.match_fallback_days', 30);
    const { registrationId } = await party();
    const inbox = new MemoryInbox();
    inbox.deliver('inbox', mail({ to: `events+p${registrationId}@example.org` }));
    const result = await runInboxSync({ inbox, mailbox: MAILBOX });
    expect(result.status).toBe('synced');
    // An injected inbox is the caller's to close.
    expect(inbox.closed).toBe(0);
  });

  it('reports a missing setting as a failure, not an exception', async () => {
    const result = await runInboxSync({ inbox: new MemoryInbox(), mailbox: MAILBOX });
    expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining('inbox.') });
  });
});
