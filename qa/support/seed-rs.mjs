/**
 * QA seed for the R x S seam (viewer on the Audience workspace and the record).
 *
 * Runs AFTER qa/support/seed-s.mjs, adding what that seed lacks so every
 * section of the party record carries a contact detail or a credential a
 * VIEWER must not receive (spec/v3.md §28):
 *
 * - phones on three parties, an address on a seat;
 * - Alice's conversation: a sent TICKETS message, a FAILED one whose SMTP error
 *   names a TLD-less address, a BOUNCED one whose detail names an address, and
 *   an inbound reply quoting her ticket link, a form-edit link, a verify link,
 *   a player invite link and her phone;
 * - Daniel's form response (raw answers with address and phone);
 * - Player 1's import batch and row (raw row with address and phone);
 * - a party whose *name* is an address (a guest typed it in the name box);
 * - audit rows on Alice with contact details in before/after.
 *
 * Every secret is printed as JSON so the spec can grep for it.
 */
import postgres from 'postgres';

const url = process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa';
const sql = postgres(url, { prepare: false, max: 1 });

const id = async (name) => (await sql`select id from registrations where contact_name = ${name}`)[0].id;
const alice = await id('Alice Tan');
const daniel = await id('Daniel Wong');
const farah = await id('Farah Aziz');
const player1 = await id('Player 1');

await sql`update registrations set contact_phone = '+65 9123 4567' where id = ${alice}`;
await sql`update registrations set contact_phone = '+60 12-345 6789' where id = ${daniel}`;
await sql`update registrations set contact_phone = '9876 5432' where id = ${farah}`;
await sql`update attendees set email = 'bernard.seat@example.test' where full_name = 'Bernard Lim'`;

const [{ qr_token: aliceToken }] = await sql`
  select qr_token from attendees where registration_id = ${alice} order by id limit 1`;

await sql`
  insert into email_outbox (registration_id, template_key, to_email, subject, body_md, status, purpose, sent_at, attempts)
  values (${alice}, 'tickets', 'alice@example.test', 'Your tickets, alice@example.test',
          ${`Ticket: http://localhost:3100/t/${aliceToken}`}, 'SENT', 'TICKETS', now() - interval '1 day', 1)`;
await sql`
  insert into email_outbox (registration_id, template_key, to_email, subject, body_md, status, purpose, attempts, last_error, created_at)
  values (${alice}, 'tickets', 'alice@examplecom', 'Your tickets', 'x', 'FAILED', 'TICKETS', 5,
          '553-5.1.3 The recipient address <alice@examplecom> is not a valid RFC 5321 address', now() - interval '3 days')`;
await sql`
  insert into email_outbox (registration_id, template_key, to_email, subject, body_md, status, purpose, attempts,
                            sent_at, bounced_at, bounce_code, bounce_detail, created_at)
  values (${alice}, 'tickets', 'alice.old@example.test', 'Your tickets', 'x', 'BOUNCED', 'RECEIPT', 1,
          now() - interval '2 days', now() - interval '2 days', '550', 'user alice.old@example.test unknown; call +65 9123 4567',
          now() - interval '2 days')`;

const [thread] = await sql`
  insert into email_threads (registration_id, last_message_at) values (${alice}, now()) returning id`;
await sql`
  insert into email_messages (thread_id, direction, from_email, from_name, to_email, subject, text, message_at)
  values (${thread.id}, 'INBOUND', 'alice@example.test', 'Alice', 'committee@example.test',
          'Re: Your tickets',
          ${[
            'Thanks! Please call me on +65 9123 4567 if anything changes.',
            'Or write to alice at example dot test, or alice@examplecom.',
            '',
            '> Your ticket: http://localhost:3100/t/' + aliceToken,
            '> Change your answers: http://localhost:3100/f/round-2/edit?r=EDITSECRET000000000001',
            '> Confirm your address: http://localhost:3100/f/verify?t=VERSECRET000000000001',
            '> Your invite: http://localhost:3100/f/players?k=seedtoken0000000000001',
          ].join('\n')},
          now())`;

const [form] = await sql`
  insert into registration_forms (segment_id, title, slug, status, kind, schema)
  values (1, 'Round 2 public', 'round-2', 'OPEN', 'PUBLIC', '{"blocks":[]}'::jsonb)
  on conflict (slug) do update set title = excluded.title returning id`;
const [response] = await sql`
  insert into form_responses (form_id, raw, submitted_at, form_schema, edit_token)
  values (${form.id},
          ${sql.json({ q_email: 'daniel@example.test', q_mobile_number: '+60 12-345 6789', q_hp: '0123456789', q_notes: 'backup daniel.alt@example.test' })},
          now() - interval '5 days', '{"blocks":[]}'::jsonb, 'EDITSECRET000000000002')
  returning id`;
await sql`update registrations set form_response_id = ${response.id} where id = ${daniel}`;

const [batch] = await sql`
  insert into import_batches (show_id, segment_id, filename, status, row_count, created_count)
  values (1, 2, 'players-round1.xlsx', 'COMMITTED', 1, 1) returning id`;
await sql`
  insert into import_rows (batch_id, row_number, seat_index, raw, normalized, issues, status, registration_id)
  values (${batch.id}, 2, 0,
          ${sql.json({ Name: 'Player 1', Email: 'player1@example.test', 'HP no': '+60 17-555 0101' })},
          '{}'::jsonb, '[]'::jsonb, 'COMMITTED', ${player1})`;
await sql`update registrations set import_batch_id = ${batch.id} where id = ${player1}`;

// A party whose name box holds an address.
const [named] = await sql`
  insert into registrations (show_id, segment_id, source, contact_name, contact_email, status, requested_at, approved_at)
  values (1, 1, 'FORM', 'kai.hidden@example.test', 'kai.hidden@example.test', 'WAITLIST', '2026-09-09T11:00:00Z', now())
  returning id`;
await sql`select claim_seats(1::bigint, ${named.id}::bigint, '[{"full_name":"Kai","allocation_type":"EXTRA"}]'::text::jsonb, false)`;
await sql`update registrations set status = 'CONFIRMED' where id = ${named.id}
          and exists (select 1 from attendees where registration_id = ${named.id} and status = 'CONFIRMED')`;

await sql`
  insert into audit_log (action, entity_type, entity_id, concert_id, actor_id, reason, before, after)
  values ('registration.updated', 'registration', ${String(alice)}, 1, '11111111-1111-4111-8111-111111111111',
          'she phoned from +65 9123 4567',
          ${sql.json({ contactName: 'Alice Tan', contactEmail: 'alice.old@example.test', contactPhone: '+65 9000 0000' })},
          ${sql.json({ contactName: 'Alice Tan', contactEmail: 'alice@example.test', note: 'was alice@examplecom' })})`;

console.log(JSON.stringify({ alice, daniel, farah, player1, named: named.id, aliceToken, form: form.id, batch: batch.id }));
await sql.end();
