import { appendFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../../tests/helpers/db';
import {
  createConcert,
  createPlayers,
  createRegistration,
  createSegment,
  createShow,
  setSystemSetting,
} from '../../tests/helpers/fixtures';
import { dispatchBatch } from '@/lib/email/dispatch';
import { runInboxSync } from '@/lib/inbox/run';
import { syncMailbox } from '@/lib/inbox/sync';
import { markHandled, sendReply } from '@/lib/inbox/reply';
import { inboxCounts, listInboxThreads } from '@/lib/inbox/queries';
import { runTick } from '@/lib/scheduler/tick';
import { MemoryInbox } from '@/lib/mail/memory-inbox';
import { createSmtpTransport, type MailTransport } from '@/lib/mail/transport';

/**
 * QA module U, phase 4 — real Postgres (zetix_qa), real SMTP over TCP to an
 * in-process smtp-server, the app's own MemoryInbox for the mailbox side.
 * Each `it` names its acceptance criterion; results print as `QA <AC>` lines.
 */

const MAILBOX = 'events@example.org';
const ADMIN = '00000000-0000-4000-8000-0000000000aa';
const DAY = 86_400_000;
const LOG = process.env.QA_U_LOG ?? '/tmp/qa-u-phase4.log';
const log = (...a: unknown[]) => {
  console.log('QA', ...a);
  appendFileSync(LOG, `QA ${a.map((x) => (typeof x === 'string' ? x : inspect(x, { depth: 6, breakLength: 160 }))).join(' ')}\n`);
};

// ---- a real SMTP sink --------------------------------------------------------
type Wire = { rcpt: string[]; raw: string };
const wire: Wire[] = [];
let smtp: SMTPServer;
let smtpPort = 0;
let failSmtp = false;

beforeAll(async () => {
  smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onAuth(_a, _s, cb) {
      cb(null, { user: 'x' });
    },
    onRcptTo(addr, _s, cb) {
      if (failSmtp) return cb(new Error('550 5.1.1 QA forced reject'));
      cb();
    },
    onData(stream, session, cb) {
      let raw = '';
      stream.on('data', (c) => (raw += c.toString()));
      stream.on('end', () => {
        wire.push({ rcpt: session.envelope.rcptTo.map((r) => r.address), raw });
        cb();
      });
    },
  });
  await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));
  smtpPort = (smtp.server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((r) => smtp.close(() => r()));
});

const realTransport = (): MailTransport =>
  createSmtpTransport({ host: '127.0.0.1', port: smtpPort, secure: false, user: MAILBOX, pass: 'x', fromName: 'LCO QA' });

const header = (raw: string, name: string) => {
  const unfolded = raw.replace(/\r\n[ \t]+/g, ' ');
  return new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(unfolded)?.[1]?.trim() ?? null;
};

// ---- fixtures -------------------------------------------------------------------
let n = 0;
async function party(email = 'guest@guest.example') {
  const concertId = await createConcert(`U-QA ${(n += 1)}`);
  const showId = await createShow(concertId, 100);
  const segmentId = await createSegment(showId, { audienceMode: 'PUBLIC', capacity: 50 });
  const registrationId = await createRegistration({ showId, segmentId, contactName: 'Ada Guest' });
  await sql`update registrations set contact_email = ${email} where id = ${registrationId}`;
  return { concertId, registrationId, showId };
}

async function sentRow(o: { registrationId?: number; playerId?: number; messageId: string; to?: string; sentAt?: Date; purpose?: string; templateKey?: string }) {
  const [row] = await sql<{ id: string }[]>`
    insert into email_outbox (registration_id, player_id, purpose, template_key, to_email, subject, body_md, status, sent_at, message_id)
    values (${o.registrationId ?? null}, ${o.playerId ?? null}, ${o.purpose ?? 'TICKETS'}::message_purpose,
            ${o.templateKey ?? 'public_ticket'}, ${o.to ?? 'guest@guest.example'}, 'Your tickets', 'Hello', 'SENT',
            ${(o.sentAt ?? new Date(Date.now() - DAY)).toISOString()}, ${o.messageId})
    returning id`;
  return Number(row.id);
}

function mail(h: { from?: string; to?: string; messageId?: string | null; inReplyTo?: string; references?: string; subject?: string; body?: string; extra?: string[]; contentType?: string; cte?: string; html?: string }) {
  const lines = [
    `From: ${h.from ?? 'Ada Guest <guest@guest.example>'}`,
    `To: ${h.to ?? MAILBOX}`,
    `Subject: ${h.subject ?? 'Re: Your tickets'}`,
    ...(h.messageId === null ? [] : [`Message-ID: ${h.messageId ?? `<r${Math.random().toString(36).slice(2)}@guest.example>`}`]),
    ...(h.inReplyTo ? [`In-Reply-To: ${h.inReplyTo}`] : []),
    ...(h.references ? [`References: ${h.references}`] : []),
    ...(h.extra ?? []),
    'Date: Sat, 26 Sep 2026 12:00:00 +0000',
    'MIME-Version: 1.0',
    `Content-Type: ${h.contentType ?? (h.html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8')}`,
    ...(h.cte ? [`Content-Transfer-Encoding: ${h.cte}`] : []),
    '',
    h.html ?? h.body ?? 'Can I bring my daughter as well?',
  ];
  return lines.join('\r\n');
}

function dsn(originalId: string, action = 'failed', status = '5.1.1') {
  const b = 'BOUNDARY42';
  return [
    'From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
    `To: ${MAILBOX}`,
    'Subject: Delivery Status Notification (Failure)',
    `Message-ID: <dsn${Math.random().toString(36).slice(2)}@mx.google.com>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/report; report-type=delivery-status; boundary="${b}"`,
    '',
    `--${b}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    "Address not found. Your message wasn't delivered.",
    `--${b}`,
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; googlemail.com',
    '',
    'Final-Recipient: rfc822; nobody@nowhere.example',
    `Action: ${action}`,
    `Status: ${status}`,
    `Diagnostic-Code: smtp; 550-${status} The email account that you tried to reach does not exist.`,
    '',
    `--${b}`,
    'Content-Type: text/rfc822-headers',
    '',
    `From: ${MAILBOX}`,
    'To: nobody@nowhere.example',
    'Subject: Your tickets',
    `Message-ID: ${originalId}`,
    '',
    `--${b}--`,
    '',
  ].join('\r\n');
}

const sync = (inbox: MemoryInbox, fallbackDays = 30) =>
  syncMailbox({ inbox, mailbox: MAILBOX, deadline: Date.now() + 30_000, fallbackDays });

const flags = async (rid: number) =>
  (await sql<{ flag_reply_waiting: boolean; flag_bounced: boolean }[]>`
    select flag_reply_waiting, flag_bounced from party_pipeline where registration_id = ${rid}`)[0];
const msgs = (rid: number) =>
  sql<{ id: string; direction: string; is_bounce: boolean; handled_at: Date | null; message_id: string; html: string | null; text: string | null }[]>`
    select m.id, m.direction, m.is_bounce, m.handled_at, m.message_id, m.html, m.text
      from email_messages m join email_threads t on t.id = m.thread_id
     where t.registration_id = ${rid} order by m.message_at, m.id`;
const countAll = async () => Number((await sql<{ c: string }[]>`select count(*) c from email_messages`)[0].c);

beforeEach(async () => {
  await resetDb();
  wire.length = 0;
  failSmtp = false;
  for (const [k, v] of Object.entries({
    'email.max_per_dispatch': 25, 'email.max_per_day': 450, 'email.inter_message_delay_ms': 0,
    'email.max_attempts': 3, 'email.merge_attachments_above': 8, 'email.max_attachment_mb': 20,
    'inbox.match_fallback_days': 30, 'inbox.sync_budget_seconds': 20, 'scheduler.history_days': 7,
  })) await setSystemSetting(k, v);
  await sql`insert into app_users (id, email, display_name, role) values (${ADMIN}, 'ana@example.test', 'Ana', 'ADMIN')`;
});

async function queueCancellation(rid: number) {
  const [row] = await sql<{ id: string }[]>`
    insert into email_outbox (registration_id, purpose, template_key, to_email, to_name, subject, body_md, status)
    values (${rid}, 'CANCELLATION', 'registration_cancelled', 'guest@guest.example', 'Ada', 'Your booking', 'Hello', 'QUEUED')
    returning id`;
  return Number(row.id);
}

describe('U phase 4 — tagging on the real SMTP wire', () => {
  it('AC-1/AC-2: Message-ID on the wire equals the stored one; Reply-To plus-tags the registration', async () => {
    const { registrationId } = await party();
    const id = await queueCancellation(registrationId);
    const r = await dispatchBatch({ transport: realTransport() });
    const [row] = await sql<{ message_id: string; status: string }[]>`select message_id, status from email_outbox where id = ${id}`;
    const w = wire[0];
    log('AC-1', { sent: r.sent, stored: row.message_id, wireMessageId: header(w.raw, 'Message-ID'), wireReplyTo: header(w.raw, 'Reply-To') });
    expect(header(w.raw, 'Message-ID')).toBe(row.message_id);
    expect(row.message_id).toMatch(new RegExp(`^<${id}\\.[0-9a-f]+@example\\.org>$`));
    expect(header(w.raw, 'Reply-To')).toContain(`events+p${registrationId}@example.org`);
  });

  it('AC-3: player digest tagged +pl{player_id}', async () => {
    const concertId = await createConcert('U-QA player');
    const [playerId] = await createPlayers(concertId, 1);
    await sql`
      insert into email_outbox (player_id, purpose, template_key, to_email, to_name, subject, body_md, status)
      values (${playerId}, 'NOTES_DIGEST', 'player_notes_digest', 'player@band.example', 'P', 'Notes', 'Hi', 'QUEUED')`;
    await dispatchBatch({ transport: realTransport() });
    log('AC-3', { replyTo: header(wire[0].raw, 'Reply-To') });
    expect(header(wire[0].raw, 'Reply-To')).toContain(`events+pl${playerId}@example.org`);
  });

  it('AC-41: pressing Send (dispatch) twice sends once', async () => {
    const { registrationId } = await party();
    await queueCancellation(registrationId);
    const t = realTransport();
    const [a, b] = await Promise.all([dispatchBatch({ transport: t }), dispatchBatch({ transport: realTransport() })]);
    log('AC-41', { first: a.sent, second: b.sent, onWire: wire.length });
    expect(wire.length).toBe(1);
  });
});

describe('U phase 4 — matching and storage', () => {
  it('AC-9: In-Reply-To beats a plus tag naming a different party', async () => {
    const a = await party('a@guest.example');
    const b = await party('b@guest.example');
    await sentRow({ registrationId: a.registrationId, messageId: '<a1@example.org>', to: 'a@guest.example' });
    const inbox = new MemoryInbox();
    inbox.deliver('inbox', mail({ from: 'a@guest.example', to: `events+p${b.registrationId}@example.org`, inReplyTo: '<a1@example.org>' }));
    await sync(inbox);
    const [ma, mb] = [await msgs(a.registrationId), await msgs(b.registrationId)];
    log('AC-9', { onA: ma.length, onB: mb.length });
    expect(ma.length).toBe(1);
    expect(mb.length).toBe(0);
  });

  it('AC-12 sender fallback is case-insensitive on the address (citext)', async () => {
    const { registrationId } = await party();
    await sentRow({ registrationId, messageId: '<x1@example.org>' });
    const inbox = new MemoryInbox();
    inbox.deliver('inbox', mail({ from: 'Ada <GUEST@Guest.Example>' }));
    await sync(inbox);
    log('AC-12 case', { stored: (await msgs(registrationId)).length });
    expect((await msgs(registrationId)).length).toBe(1);
  });

  it('AC-12w: the window is the setting — at 1 day a 5-day-old send no longer matches by sender', async () => {
    const { registrationId } = await party();
    await sentRow({ registrationId, messageId: '<x2@example.org>', sentAt: new Date(Date.now() - 5 * DAY) });
    await setSystemSetting('inbox.match_fallback_days', 1);
    const inbox = new MemoryInbox();
    inbox.deliver('inbox', mail({}));
    const r = await runInboxSync({ inbox, mailbox: MAILBOX });
    log('AC-12w', { status: r.status, stored: (await msgs(registrationId)).length });
    expect((await msgs(registrationId)).length).toBe(0);
    await setSystemSetting('inbox.match_fallback_days', 10);
    const inbox2 = new MemoryInbox();
    inbox2.deliver('inbox', mail({}));
    await sql`delete from mail_sync_state`;
    await runInboxSync({ inbox: inbox2, mailbox: MAILBOX });
    log('AC-12w at 10 days', { stored: (await msgs(registrationId)).length });
    expect((await msgs(registrationId)).length).toBe(1);
  });

  it('AC-3s/AC-13: hostile or unknown plus tags and unmatched mail store nothing', async () => {
    const { registrationId } = await party('other@guest.example');
    const inbox = new MemoryInbox();
    for (const to of ['events+p1;drop table x@example.org', 'events+p../../etc@example.org', 'events+p999999@example.org',
      `events+p${registrationId}@evil.example`, `events+p0@example.org`, `events+p${'9'.repeat(40)}@example.org`, 'stranger@example.org']) {
      inbox.deliver('inbox', mail({ from: 'stranger@x.example', to }));
    }
    const r = await sync(inbox);
    log('AC-13', { total: await countAll(), threads: (await sql`select count(*) c from email_threads`)[0].c, report: r.folders[0] });
    expect(await countAll()).toBe(0);
  });

  it('AC-28: hostile HTML is stored sanitised', async () => {
    const { registrationId } = await party();
    await sentRow({ registrationId, messageId: '<h1@example.org>' });
    const inbox = new MemoryInbox();
    inbox.deliver('inbox', mail({ inReplyTo: '<h1@example.org>', html:
      '<p>hi</p><script>alert(1)</script><img src=x onerror=alert(2)><a href="javascript:alert(3)">x</a><svg onload=alert(4)></svg>' +
      '<a href="data:text/html,<script>alert(5)</script>">d</a><iframe src="https://evil.example"></iframe><p style="background:url(https://track.example/p.gif)">s</p>' }));
    await sync(inbox);
    const [m] = await msgs(registrationId);
    log('AC-28', { html: m.html });
    expect(m.html).not.toMatch(/script|onerror|onload|javascript:|data:|iframe|<img|<svg|style=/i);
  });

  it('AC-6/AC-18: re-reading the same mail stores nothing twice; the same DSN twice is one bounce', async () => {
    const { registrationId } = await party();
    const out = await sentRow({ registrationId, messageId: '<b1@example.org>' });
    const inbox = new MemoryInbox();
    inbox.deliver('inbox', mail({ inReplyTo: '<b1@example.org>', messageId: '<same@guest.example>' }));
    const d = dsn('<b1@example.org>');
    inbox.deliver('inbox', d);
    inbox.deliver('inbox', d);
    await sync(inbox);
    await sql`delete from mail_sync_state`;
    await sync(inbox);
    const [o] = await sql<{ status: string; bounced_at: Date; bounce_code: string }[]>`select status, bounced_at, bounce_code from email_outbox where id = ${out}`;
    log('AC-6/18', { messages: (await msgs(registrationId)).map((m) => [m.direction, m.is_bounce]), outbox: o, flags: await flags(registrationId) });
    expect((await msgs(registrationId)).length).toBe(2);
    expect(o.status).toBe('BOUNCED');
    expect(o.bounce_code).toBe('5.1.1');
    expect((await flags(registrationId)).flag_bounced).toBe(true);
  });

  it('AC-14s: a DSN quoting a Message-ID we did not send (a guest\'s own reply id) changes nothing and stores nothing', async () => {
    const { registrationId } = await party();
    await sentRow({ registrationId, messageId: '<c1@example.org>' });
    const inbox = new MemoryInbox();
    inbox.deliver('inbox', mail({ inReplyTo: '<c1@example.org>', messageId: '<guestown@guest.example>' }));
    await sync(inbox);
    const before = await countAll();
    inbox.deliver('inbox', dsn('<guestown@guest.example>'));
    await sync(inbox);
    const after = await msgs(registrationId);
    log('AC-14s', { before, after: after.map((m) => [m.direction, m.is_bounce, m.message_id]) });
    expect(await countAll()).toBe(before);
  });

  it('AC-17: fixing the address clears BOUNCED', async () => {
    const { registrationId } = await party();
    await sentRow({ registrationId, messageId: '<d1@example.org>' });
    const inbox = new MemoryInbox();
    inbox.deliver('inbox', dsn('<d1@example.org>'));
    await sync(inbox);
    const before = await flags(registrationId);
    await sql`update registrations set contact_email = 'fixed@guest.example' where id = ${registrationId}`;
    const after = await flags(registrationId);
    log('AC-17', { before: before.flag_bounced, after: after.flag_bounced });
    expect(before.flag_bounced).toBe(true);
    expect(after.flag_bounced).toBe(false);
  });
});

describe('U phase 4 — threads and REPLY_WAITING', () => {
  it('AC-20s: a bounce of a later resend must not hide an unanswered reply', async () => {
    const { registrationId, concertId } = await party();
    await sentRow({ registrationId, messageId: '<e1@example.org>', sentAt: new Date(Date.now() - 3 * DAY) });
    const inbox = new MemoryInbox();
    inbox.deliver('inbox', mail({ inReplyTo: '<e1@example.org>', body: 'Can I change the name on seat 2?' }), new Date(Date.now() - 2 * DAY));
    await sync(inbox);
    const waitingBefore = (await flags(registrationId)).flag_reply_waiting;
    // A ticket resend a day later, which bounces.
    await sentRow({ registrationId, messageId: '<e2@example.org>', sentAt: new Date(Date.now() - DAY) });
    inbox.deliver('inbox', dsn('<e2@example.org>'), new Date(Date.now() - DAY + 60_000));
    await sync(inbox);
    const f = await flags(registrationId);
    const counts = await inboxCounts(concertId);
    log('AC-20s bounce-after-reply', { waitingBefore, flagAfter: f.flag_reply_waiting, inboxWaitingCount: counts.waiting, messages: (await msgs(registrationId)).map((m) => [m.direction, m.is_bounce, m.handled_at]) });
    expect(f.flag_reply_waiting).toBe(true);
  });

  it('AC-21s: a reply that is queued (not yet sent) must not handle a guest message that arrives before it goes out', async () => {
    const { registrationId, concertId } = await party();
    await sentRow({ registrationId, messageId: '<f1@example.org>', sentAt: new Date(Date.now() - DAY) });
    const inbox = new MemoryInbox();
    inbox.deliver('inbox', mail({ inReplyTo: '<f1@example.org>', body: 'Question one' }), new Date(Date.now() - 60 * 60_000));
    await sync(inbox);
    const [q1] = await msgs(registrationId);
    // Admin answers q1, but the send fails now (SMTP rejects) — it stays queued for the tick.
    failSmtp = true;
    const r = await sendReply({ concertId, messageId: Number(q1.id), body: 'Answer to one', actorId: ADMIN, transport: realTransport() });
    const [o1] = await sql<{ status: string }[]>`select status from email_outbox where id = ${r.outboxId}`;
    // A new question arrives before the retry.
    inbox.deliver('inbox', mail({ inReplyTo: '<f1@example.org>', body: 'Question two, a new one' }), new Date());
    await sync(inbox);
    const midFlag = (await flags(registrationId)).flag_reply_waiting;
    // The retry goes out.
    failSmtp = false;
    await sql`update email_outbox set status = 'QUEUED', scheduled_for = null where id = ${r.outboxId}`;
    const d = await dispatchBatch({ transport: realTransport() });
    const all = await msgs(registrationId);
    const q2 = all.find((m) => m.text?.includes('Question two'));
    const f = await flags(registrationId);
    log('AC-21s held-reply', { firstAttempt: { sent: r.sent, status: o1.status, note: r.note }, midFlag, retrySent: d.sent, q2HandledAt: q2?.handled_at ?? null, flagAfter: f.flag_reply_waiting, waitingCount: (await inboxCounts(concertId)).waiting });
    expect(q2?.handled_at ?? null).toBeNull();
    expect(f.flag_reply_waiting).toBe(true);
  });

  it('AC-24/AC-44: a reply is one REPLY outbox row addressed to the registration, sent now, threaded', async () => {
    const { registrationId, concertId } = await party();
    await sentRow({ registrationId, messageId: '<g1@example.org>' });
    const inbox = new MemoryInbox();
    inbox.deliver('inbox', mail({ inReplyTo: '<g1@example.org>', messageId: '<q@guest.example>' }));
    await sync(inbox);
    const [q] = await msgs(registrationId);
    const r = await sendReply({ concertId, messageId: Number(q.id), body: 'Yes, of course.', actorId: ADMIN, transport: realTransport() });
    const rows = await sql`select purpose, status, registration_id, player_id from email_outbox where purpose = 'REPLY'`;
    const w = wire.at(-1)!;
    log('AC-24', { r, rows, inReplyTo: header(w.raw, 'In-Reply-To'), references: header(w.raw, 'References'), rcpt: w.rcpt, flag: (await flags(registrationId)).flag_reply_waiting });
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('SENT');
    expect(Number(rows[0].registration_id)).toBe(registrationId);
    expect(header(w.raw, 'In-Reply-To')).toBe('<q@guest.example>');
    expect((await flags(registrationId)).flag_reply_waiting).toBe(false);
  });

  it('AC-24s/AC-24v: empty body, cross-concert, bounce and nonexistent message are refused with no row', async () => {
    const a = await party();
    const b = await party('b@guest.example');
    await sentRow({ registrationId: a.registrationId, messageId: '<k1@example.org>' });
    const inbox = new MemoryInbox();
    inbox.deliver('inbox', mail({ inReplyTo: '<k1@example.org>' }));
    await sync(inbox);
    const [q] = await msgs(a.registrationId);
    const out: Record<string, string> = {};
    for (const [label, args] of [
      ['empty', { concertId: a.concertId, messageId: Number(q.id), body: '   ' }],
      ['other concert', { concertId: b.concertId, messageId: Number(q.id), body: 'hi' }],
      ['nonexistent', { concertId: a.concertId, messageId: 99_999_999, body: 'hi' }],
    ] as const) {
      try {
        await sendReply({ ...args, actorId: ADMIN, transport: realTransport() });
        out[label] = 'ACCEPTED';
      } catch (e) {
        out[label] = (e as Error).message;
      }
    }
    try {
      await markHandled({ concertId: b.concertId, messageId: Number(q.id), actorId: ADMIN });
      out['markHandled other concert'] = 'ACCEPTED';
    } catch (e) {
      out['markHandled other concert'] = (e as Error).message;
    }
    const rows = await sql`select count(*) c from email_outbox where purpose = 'REPLY'`;
    log('AC-24s', out, { replyRows: rows[0].c, handled: (await msgs(a.registrationId))[0].handled_at });
    expect(Number(rows[0].c)).toBe(0);
    expect(Object.values(out).every((v) => v !== 'ACCEPTED')).toBe(true);
  });

  it('AC-22: Inbox lists only this concert, newest first', async () => {
    const a = await party('a@guest.example');
    const b = await party('b@guest.example');
    const c = await party('c@guest.example');
    await sql`update registrations set show_id = ${a.showId}, segment_id = (select segment_id from registrations where id = ${a.registrationId}) where id = ${b.registrationId}`;
    await sentRow({ registrationId: a.registrationId, messageId: '<l1@example.org>', to: 'a@guest.example' });
    await sentRow({ registrationId: b.registrationId, messageId: '<l2@example.org>', to: 'b@guest.example' });
    await sentRow({ registrationId: c.registrationId, messageId: '<l3@example.org>', to: 'c@guest.example' });
    const inbox = new MemoryInbox();
    inbox.deliver('inbox', mail({ from: 'a@guest.example', inReplyTo: '<l1@example.org>' }), new Date(Date.now() - 3 * 60_000));
    inbox.deliver('inbox', mail({ from: 'b@guest.example', inReplyTo: '<l2@example.org>' }), new Date(Date.now() - 2 * 60_000));
    inbox.deliver('inbox', mail({ from: 'c@guest.example', inReplyTo: '<l3@example.org>' }), new Date(Date.now() - 1 * 60_000));
    await sync(inbox);
    const list = await listInboxThreads(a.concertId, 'waiting');
    log('AC-22', list.map((t) => [t.addresseeId, t.lastMessageAt]));
    expect(list.map((t) => t.addresseeId)).toEqual([b.registrationId, a.registrationId]);
  });

  it('Note: an out-of-office auto-reply raises REPLY_WAITING like a person', async () => {
    const { registrationId } = await party();
    await sentRow({ registrationId, messageId: '<m1@example.org>' });
    const inbox = new MemoryInbox();
    inbox.deliver('inbox', mail({ inReplyTo: '<m1@example.org>', subject: 'Automatic reply: Your tickets', body: 'I am out of office until Monday.', extra: ['Auto-Submitted: auto-replied', 'X-Autoreply: yes'] }));
    await sync(inbox);
    log('NOTE auto-reply', { stored: (await msgs(registrationId)).length, flag: (await flags(registrationId)).flag_reply_waiting });
  });
});

describe('U phase 4 — Sent Mail', () => {
  it('AC-5: our own message in Sent is skipped; a reply written in Gmail joins the thread and handles the earlier question', async () => {
    const { registrationId } = await party();
    await sentRow({ registrationId, messageId: '<s1@example.org>' });
    const inbox = new MemoryInbox();
    inbox.deliver('inbox', mail({ inReplyTo: '<s1@example.org>', messageId: '<sq@guest.example>' }), new Date(Date.now() - 60_000));
    inbox.deliver('sent', mail({ from: MAILBOX, to: 'guest@guest.example', messageId: '<s1@example.org>', subject: 'Your tickets' }));
    inbox.deliver('sent', mail({ from: MAILBOX, to: 'guest@guest.example', messageId: '<gmailreply@mail.gmail.com>', inReplyTo: '<sq@guest.example>', references: '<s1@example.org> <sq@guest.example>', body: 'Answered in Gmail' }));
    inbox.deliver('sent', mail({ from: MAILBOX, to: 'someone@else.example', messageId: '<unrelated@mail.gmail.com>', subject: 'Lunch?' }));
    await sync(inbox);
    const m = await msgs(registrationId);
    log('AC-5', { messages: m.map((x) => [x.direction, x.message_id, x.handled_at !== null]), total: await countAll(), flag: (await flags(registrationId)).flag_reply_waiting });
    expect(m.map((x) => x.message_id)).toEqual(['<sq@guest.example>', '<gmailreply@mail.gmail.com>']);
    expect(m[0].handled_at).not.toBeNull();
    expect(await countAll()).toBe(2);
  });
});

describe('U phase 4 — sync robustness', () => {
  it('AC-4 robustness: one message the database cannot store must not wedge the folder for every later reply', async () => {
    const { registrationId } = await party();
    await sentRow({ registrationId, messageId: '<n1@example.org>' });
    const inbox = new MemoryInbox();
    // Quoted-printable NUL — Postgres text refuses 0x00.
    inbox.deliver('inbox', mail({ inReplyTo: '<n1@example.org>', cte: 'quoted-printable', body: 'hello=00world' }));
    inbox.deliver('inbox', mail({ inReplyTo: '<n1@example.org>', body: 'A perfectly normal second reply' }));
    const r1 = await sync(inbox);
    const r2 = await sync(inbox);
    const state = await sql`select folder, last_uid, last_error from mail_sync_state order by folder`;
    const stored = await msgs(registrationId);
    log('AC-4 poison', { run1: r1.folders.map((f) => [f.path, f.stored, f.error]), run2: r2.folders.map((f) => [f.path, f.stored, f.error]), state, stored: stored.map((m) => m.text) });
    expect(stored.some((m) => m.text?.includes('second reply'))).toBe(true);
  });

  it('AC-4 robustness: an oversized Message-ID must not wedge the folder', async () => {
    const { registrationId } = await party();
    await sentRow({ registrationId, messageId: '<o1@example.org>' });
    const inbox = new MemoryInbox();
    inbox.deliver('inbox', mail({ inReplyTo: '<o1@example.org>', messageId: `<${Array.from({ length: 700 }, () => Math.random().toString(36).slice(2, 12)).join('')}@guest.example>` }));
    inbox.deliver('inbox', mail({ inReplyTo: '<o1@example.org>', body: 'second reply after the long id' }));
    const r1 = await sync(inbox);
    const r2 = await sync(inbox);
    const stored = await msgs(registrationId);
    log('AC-4 long-id', { run1: r1.folders.map((f) => [f.path, f.stored, f.error?.slice(0, 120)]), run2: r2.folders.map((f) => [f.path, f.stored, f.error?.slice(0, 120)]), stored: stored.map((m) => m.text) });
    expect(stored.some((m) => m.text?.includes('second reply'))).toBe(true);
  });
});

describe('U phase 4 — the tick', () => {
  it('AC-34 robustness: a poison message in the mailbox must not stop the tick recording its heartbeat', async () => {
    const { registrationId } = await party();
    const inbox = new MemoryInbox();
    // A stranger, no headers: only the plus tag (a sequential registration id) is needed.
    inbox.deliver('inbox', mail({ from: 'stranger@x.example', to: `events+p${registrationId}@example.org`, messageId: '<poison@x.example>', cte: 'quoted-printable', body: 'x=00y' }));
    let outcome: string;
    try {
      const t = await runTick({ source: 'manual', transport: realTransport(), inbox, mailbox: MAILBOX, budgetMs: 10_000 });
      outcome = `returned; inbox step ok=${t.inbox.ok}`;
    } catch (e) {
      outcome = `THREW: ${(e as Error).message.split('\n').slice(-3).join(' | ').slice(0, 300)}`;
    }
    const beats = await sql`select source, finished_at, error from scheduler_heartbeat`;
    log('AC-34 poison tick', { outcome, beats });
    expect(beats.every((b) => b.finished_at !== null)).toBe(true);
  });

  it('AC-33/AC-39/AC-34: order, due vs not-due, a failing inbox step recorded, heartbeat written', async () => {
    const { registrationId } = await party();
    await queueCancellation(registrationId);
    await sql`
      insert into email_outbox (registration_id, purpose, template_key, to_email, subject, body_md, status, scheduled_for)
      values (${registrationId}, 'RECEIPT', 'registration_receipt', 'guest@guest.example', 'Receipt', 'Hi', 'QUEUED', now() + interval '1 hour')`;
    const broken = new MemoryInbox({ inbox: 'INBOX', sent: null });
    (broken as unknown as { resolve: () => Promise<never> }).resolve = async () => { throw new Error('IMAP down (QA)'); };
    const t = await runTick({ source: 'manual', transport: realTransport(), inbox: broken, mailbox: MAILBOX, budgetMs: 20_000 });
    const [hb] = await sql<{ source: string; error: string | null; finished_at: Date | null }[]>`select source, error, finished_at from scheduler_heartbeat where id = ${t.heartbeatId}`;
    const outbox = await sql`select purpose, status from email_outbox order by id`;
    log('AC-33/39/34', { dispatch: t.dispatch, inbox: t.inbox, hb, outbox, wire: wire.length });
    expect(wire.length).toBe(1);
    expect(hb.finished_at).not.toBeNull();
  });

  it('AC-33 concurrency: two ticks at once send a queued message once', async () => {
    const { registrationId } = await party();
    await queueCancellation(registrationId);
    const [a, b] = await Promise.all([
      runTick({ source: 'manual', transport: realTransport(), inbox: new MemoryInbox(), mailbox: MAILBOX, budgetMs: 20_000 }),
      runTick({ source: 'manual', transport: realTransport(), inbox: new MemoryInbox(), mailbox: MAILBOX, budgetMs: 20_000 }),
    ]);
    log('AC-33 concurrent ticks', { a: a.dispatch, b: b.dispatch, onWire: wire.length, beats: (await sql`select count(*) c from scheduler_heartbeat`)[0].c });
    expect(wire.length).toBe(1);
  });

  it('AC-35: heartbeats older than scheduler.history_days are trimmed', async () => {
    await setSystemSetting('scheduler.history_days', 2);
    await sql`insert into scheduler_heartbeat (source, started_at) values ('manual', now() - interval '3 days'), ('manual', now() - interval '1 day')`;
    const t = await runTick({ source: 'manual', transport: realTransport(), inbox: new MemoryInbox(), mailbox: MAILBOX, budgetMs: 5_000 });
    const left = await sql`select started_at from scheduler_heartbeat order by started_at`;
    log('AC-35', { trimmed: t.trimmed, left: left.length });
    expect(t.trimmed).toBe(1);
    expect(left.length).toBe(2);
  });
});
