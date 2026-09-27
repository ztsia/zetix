/**
 * QA seed for module `U` — the Inbox and the scheduler tick.
 *
 * Starts from `T`'s seed (Alice Tan with one message per status, Daniel Wong ready
 * to send, concert 2 "Other T"), then adds:
 * - Alice's SENT ticket message carries our Message-ID; Alice has replied with a
 *   question (waiting), and that reply's text contains an address, a phone number
 *   and markup that must render as text;
 * - Daniel has a SENT ticket message that bounced (Bounced view);
 * - a player has replied to the notes digest (player thread, opens in the Inbox);
 * - the foreign party in concert 2 has replied too: it must never appear in concert 1.
 */
import { execFileSync } from 'node:child_process';
import postgres from 'postgres';

const url = process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa';
const seedT = execFileSync('node', ['qa/support/seed-t.mjs'], { env: process.env, encoding: 'utf8' });
const ids = JSON.parse(seedT.trim().split('\n').at(-1));
const sql = postgres(url, { prepare: false, max: 1 });

const alice = Number(ids.alice);
await sql`update email_outbox set message_id = '<qa-alice-tickets@example.test>' where id = ${ids.msgs.sent}`;
const [daniel] = await sql`select id, contact_email from registrations where contact_name like 'Daniel%' limit 1`;
const [dSent] = await sql`
  insert into email_outbox (registration_id, purpose, template_key, to_email, to_name, subject, body_md, status, sent_at, message_id, bounced_at, bounce_code, bounce_detail)
  values (${daniel.id}, 'TICKETS', 'public_ticket', ${daniel.contact_email}, 'Daniel Wong', 'Your tickets', 'Hi', 'BOUNCED',
          '2026-09-12T02:00:00Z', '<qa-daniel-tickets@example.test>', '2026-09-12T02:05:00Z', '5.1.1', 'The email account that you tried to reach does not exist.')
  returning id`;

async function thread(col, id) {
  const [t] = await sql`insert into email_threads (${sql(col)}, last_message_at) values (${id}, now()) returning id`;
  return Number(t.id);
}
const at = (iso) => new Date(iso);
const aliceThread = await thread('registration_id', alice);
const [aliceQ] = await sql`
  insert into email_messages (thread_id, direction, message_id, in_reply_to, from_email, from_name, to_email, subject, text, message_at, folder, uid)
  values (${aliceThread}, 'INBOUND', '<qa-alice-q1@guest.example>', '<qa-alice-tickets@example.test>', 'alice@example.test', 'Alice Tan',
          ${'tickets+p' + alice + '@example.test'}, 'Re: Your tickets',
          ${'Can my mother use seat 2? Reach me on +60 12-345 6789 or alice.personal@example.test. <script>window.__xss=1</script><img src=x onerror="window.__xss=2">'},
          ${at('2026-09-26T01:30:00Z')}, 'INBOX', 1)
  returning id`;
await sql`update email_threads set last_message_at = '2026-09-26T01:30:00Z' where id = ${aliceThread}`;

const danielThread = await thread('registration_id', daniel.id);
await sql`
  insert into email_messages (thread_id, direction, message_id, outbox_id, from_email, subject, text, is_bounce, message_at, folder, uid)
  values (${danielThread}, 'INBOUND', '<qa-daniel-dsn@mx.google.com>', ${dSent.id}, 'mailer-daemon@googlemail.com', 'Delivery Status Notification (Failure)',
          'Address not found', true, '2026-09-12T02:05:00Z', 'INBOX', 2)`;
await sql`update email_threads set last_message_at = '2026-09-12T02:05:00Z' where id = ${danielThread}`;

const [player] = await sql`select id, full_name, email from players where deleted_at is null and concert_id = ${ids.concertId} order by id limit 1`;
await sql`update players set email = 'player.one@band.example' where id = ${player.id}`;
await sql`insert into email_outbox (player_id, purpose, template_key, to_email, subject, body_md, status, sent_at, message_id)
          values (${player.id}, 'NOTES_DIGEST', 'player_notes_digest', 'player.one@band.example', 'Your notes', 'x', 'SENT', '2026-09-20T01:00:00Z', '<qa-player-digest@example.test>')`;
const playerThread = await thread('player_id', player.id);
const [playerQ] = await sql`
  insert into email_messages (thread_id, direction, message_id, in_reply_to, from_email, subject, text, message_at, folder, uid)
  values (${playerThread}, 'INBOUND', '<qa-player-q@band.example>', '<qa-player-digest@example.test>', 'player.one@band.example', 'Re: Your notes',
          'Which door do players use? Call +60 16-444 5555.', '2026-09-25T10:00:00Z', 'INBOX', 3)
  returning id`;
await sql`update email_threads set last_message_at = '2026-09-25T10:00:00Z' where id = ${playerThread}`;

const foreignThread = await thread('registration_id', ids.foreignParty);
await sql`insert into email_messages (thread_id, direction, message_id, from_email, subject, text, message_at)
          values (${foreignThread}, 'INBOUND', '<qa-foreign-q@x.example>', 'foreign@example.test', 'Re: foreign', 'FOREIGN-CONCERT-REPLY', '2026-09-26T05:00:00Z')`;
await sql`update email_threads set last_message_at = '2026-09-26T05:00:00Z' where id = ${foreignThread}`;

await sql`truncate mail_sync_state, scheduler_heartbeat`;
// The mailbox cursor for INBOX, as a previous sync would have left it: the IMAP server's UID 1 is already read.
await sql`insert into mail_sync_state (folder, uid_validity, last_uid, last_synced_at) values ('INBOX', 1, 1, now()) on conflict (folder) do nothing`;

console.log(JSON.stringify({ ...ids, daniel: Number(daniel.id), aliceThread, aliceQ: Number(aliceQ.id), danielThread, playerThread, playerId: Number(player.id), playerQ: Number(playerQ.id), foreignThread }));
await sql.end();
