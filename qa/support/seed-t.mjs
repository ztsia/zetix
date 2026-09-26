/**
 * QA seed for module `T` — the send wizard and Messages.
 *
 * Starts from `S`'s seed (Alice Tan Sent, Daniel Wong Ready to send, Farah
 * Unverified, Grace suspicious, Hassan cancelled, B's parties unapproved) and adds:
 * - Ivy Chen: approved, confirmed, no ticket issued (Needs tickets);
 * - Jon Typo: approved, confirmed, never-checked address `jon@gmail..com` (§24.6 in the Who step);
 * - one message per status on Alice (DRAFT/QUEUED future/SENDING/FAILED/SENT/BOUNCED) so every
 *   exit is visible in Messages; QUEUED is scheduled a day out so no loop sends it mid-test;
 * - concert 2 ("Other T", Europe/London) with a due QUEUED message: the banner on concert 1
 *   must not count it (§24.5).
 */
import { execFileSync } from 'node:child_process';
import postgres from 'postgres';

const url = process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa';
const seedS = execFileSync('node', ['qa/support/seed-s.mjs'], { env: process.env, encoding: 'utf8' });
const ids = JSON.parse(seedS.trim().split('\n').at(-1));
const sql = postgres(url, { prepare: false, max: 1 });

async function party({ name, email, seats, requestedAt, segmentId = ids.publicSegment, showId = ids.show1 }) {
  const [r] = await sql`
    insert into registrations (show_id, segment_id, source, contact_name, contact_email, status, requested_at, approved_at)
    values (${showId}, ${segmentId}, 'FORM', ${name}, ${email}, 'WAITLIST', ${requestedAt}, now())
    returning id`;
  await sql`select claim_seats(${segmentId}::bigint, ${r.id}::bigint, ${JSON.stringify(seats)}::text::jsonb, false)`;
  await sql`update registrations set status = 'CONFIRMED' where id = ${r.id}
             and exists (select 1 from attendees where registration_id = ${r.id} and status = 'CONFIRMED')`;
  return Number(r.id);
}
const extra = (n) => ({ full_name: n, allocation_type: 'EXTRA' });

const ivy = await party({ name: 'Ivy Chen', email: 'ivy@example.test', requestedAt: '2026-09-09T11:00:00Z',
  seats: [extra('Ivy Chen'), extra('Bartholomew Maximilian Featherstonehaugh-Worthington')] });
const jon = await party({ name: 'Jon Typo', email: 'jon@gmail..com', requestedAt: '2026-09-09T12:00:00Z', seats: [extra('Jon Typo')] });

// Every seeded address counts as checked except Jon's: the sandbox resolver answers NXDOMAIN for
// `example.test`, which would (correctly) flag every party. Jon is the one the Who step must check.
await sql`update registrations set email_checked_at = now() where contact_name <> 'Jon Typo' and email_checked_at is null`;

const alice = Number(ids.alice);
const msg = async (status, purpose, key, extra = {}) => {
  const [m] = await sql`
    insert into email_outbox (registration_id, purpose, template_key, to_email, to_name, subject, body_md, status,
                              attempts, last_error, sent_at, scheduled_for, bounced_at, bounce_code, bounce_detail, updated_at)
    values (${alice}, ${purpose}::message_purpose, ${key}, 'alice@example.test', 'Alice Tan',
            ${`QA ${status} ${purpose}`}, ${`Body of the ${status} message`}, ${status}::outbox_status,
            ${extra.attempts ?? 0}, ${extra.last_error ?? null}, ${extra.sent_at ?? null}, ${extra.scheduled_for ?? null},
            ${extra.bounced_at ?? null}, ${extra.bounce_code ?? null}, ${extra.bounce_detail ?? null}, now())
    returning id`;
  return Number(m.id);
};
const sent = await msg('SENT', 'TICKETS', 'public_ticket', { sent_at: '2026-09-10T02:30:00Z' });
const draft = await msg('DRAFT', 'REMINDER', 'reminder');
const queued = await msg('QUEUED', 'FEEDBACK', 'feedback_request', { scheduled_for: new Date(Date.now() + 86400000) });
const sending = await msg('SENDING', 'CANCELLATION', 'registration_cancelled');
const failed = await msg('FAILED', 'VERIFICATION', 'public_verify', { attempts: 3, last_error: 'QA: 550 mailbox unavailable' });
const bounced = await msg('BOUNCED', 'EXTRAS_DECISION', 'extras_declined', { sent_at: '2026-09-10T03:00:00Z', bounced_at: '2026-09-10T03:05:00Z', bounce_code: '5.1.1', bounce_detail: 'QA: user unknown' });

const [c2] = await sql`insert into concerts (name, slug, status, timezone) values ('Other T', 'other-t', 'ACTIVE', 'Europe/London') returning id`;
const [s2] = await sql`insert into shows (concert_id, name, status, capacity, starts_at) values (${c2.id}, 'Other Show', 'OPEN', 50, now() + interval '20 days') returning id`;
const [g2] = await sql`insert into show_segments (show_id, name, audience_mode, capacity, extras_policy) values (${s2.id}, 'Pub', 'PUBLIC', 50, 'AUTO_FCFS') returning id`;
const [r2] = await sql`insert into registrations (show_id, segment_id, source, contact_name, contact_email, status, requested_at, approved_at)
  values (${s2.id}, ${g2.id}, 'ADMIN', 'Foreign Family', 'foreign@example.test', 'WAITLIST', now(), now()) returning id`;
await sql`select claim_seats(${g2.id}::bigint, ${r2.id}::bigint, '[{"full_name":"Foreign Guest","allocation_type":"EXTRA"}]'::jsonb, false)`;
// A FAILED message in concert 2: the banner of concert 1 must not report it.
const [foreignMsg] = await sql`insert into email_outbox (registration_id, purpose, template_key, to_email, subject, body_md, status, attempts, last_error)
  values (${r2.id}, 'REMINDER', 'reminder', 'foreign@example.test', 'QA foreign', 'x', 'FAILED', 3, 'QA foreign failure') returning id`;

// seed-b truncates system_settings: put every system default back (email.*, delivery.review_single_party = false).
execFileSync('pnpm', ['-s', 'db:seed'], { env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url }, stdio: ['ignore', 'ignore', 'inherit'] });

console.log(JSON.stringify({ ...ids, ivy, jon, msgs: { sent, draft, queued, sending, failed, bounced }, concert2: Number(c2.id), foreignParty: Number(r2.id), foreignMsg: Number(foreignMsg.id) }));
await sql.end();
