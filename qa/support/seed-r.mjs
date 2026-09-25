/**
 * QA seed for module `R` — roles and accounts.
 *
 * Module Q's seed (B's concert, parties, players, Trash rows), plus every kind
 * of secret a VIEWER must not receive in full, each a unique greppable marker:
 *
 * - contact phones on every registration  (+60 12-555 0<id>)
 * - a custom tel answer under a key that does not say "phone" (emergency_contact)
 * - issued qr_tokens on Alice's seats (QRSECRET…), update/verification tokens
 * - an outbox message whose body carries a /t/ link and the address
 * - audit rows whose before/after/reason carry addresses
 * - a public form with a response carrying phone + a tel answer
 * - a portal note
 * Accounts: committee (ADMIN), ana (ADMIN #2), mei (VIEWER), wei-ling (OPERATOR, show 1).
 */
import { execFileSync } from 'node:child_process';
import postgres from 'postgres';

const url = process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa';
const out = execFileSync('node', ['qa/support/seed-q.mjs'], { env: process.env, encoding: 'utf8' });
const ids = JSON.parse(out.trim().split('\n').at(-1));
const sql = postgres(url, { prepare: false, max: 1 });

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN2_ID = '44444444-4444-4444-8444-444444444444';
const VIEWER_ID = '33333333-3333-4333-8333-333333333333';

await sql`update system_settings set value = '5'::jsonb where key = 'auth.admin_max_attempts'`;
await sql`insert into app_users (id, email, display_name, role) values
  (${ADMIN2_ID}::uuid, 'ana@example.test', 'Ana Admin', 'ADMIN'),
  (${VIEWER_ID}::uuid, 'mei@example.test', 'Mei Viewer', 'VIEWER')`;

await sql`update registrations set contact_phone = '+60 12-555 0' || lpad(id::text, 3, '0'),
  custom = jsonb_build_object('emergency_contact', '+60 19-777 0' || lpad(id::text, 3, '0')),
  update_token = 'UPDSECRET' || lpad(id::text, 12, '0'),
  verification_token = 'VERSECRET' || lpad(id::text, 12, '0')`;

const [alice] = await sql`select id, show_id, segment_id from registrations where contact_email = 'alice@example.test'`;
await sql`update attendees set qr_token = 'QRSECRET' || lpad(id::text, 14, '0'),
  ticket_code = 'TC' || id, ticket_issued_at = now(), email = 'seat' || id || '@example.test'
  where registration_id = ${alice.id}`;
const [tpl] = await sql`select id, version from ticket_templates where deleted_at is null order by id limit 1`;
if (tpl) await sql`update attendees set ticket_template_id = ${tpl.id}, ticket_template_version = ${tpl.version} where registration_id = ${alice.id}`;
const [firstSeat] = await sql`select id, qr_token from attendees where registration_id = ${alice.id} order by id limit 1`;

await sql`insert into email_outbox (registration_id, template_key, to_email, to_name, subject, body_md, status, purpose, sent_at)
  values (${alice.id}, 'tickets', 'alice@example.test', 'Alice Tan', 'Your tickets',
    ${'Hi Alice — reply to alice@example.test.\n\n[View ticket](http://localhost:3100/t/' + firstSeat.qr_token + ')'},
    'SENT', 'TICKETS', now())`;

await sql`insert into audit_log (actor_id, action, entity_type, entity_id, before, after, reason, concert_id) values
  (${ADMIN_ID}::uuid, 'registration.updated', 'registrations', ${String(alice.id)},
   '{"contact_email":"alice-old@example.test","contact_phone":"+60 13-999 1234"}'::jsonb,
   '{"contact_email":"alice@example.test","note":"moved from auditfree@example.test"}'::jsonb,
   'asked by alice-reason@example.test', ${ids.concertId})`;

const schema = {"kind":"PUBLIC","blocks":[{"id":"registrant","type":"REGISTRANT","title":"Your details","creates_seat":true,"fields":[
  {"key":"contact_name","label":"Full name","type":"text","system":true,"required":true},
  {"key":"contact_email","label":"Email","type":"email","system":true,"required":true},
  {"key":"contact_phone","label":"Phone","type":"tel","system":true,"required":false},
  {"key":"emergency_contact","label":"Emergency contact number","type":"tel","required":false}]},
  {"id":"party","type":"GUESTS_PARTY","title":"Who else is coming?","add_label":"Add a guest","guest_fields":[
  {"key":"full_name","label":"Guest name","type":"text","system":true,"required":true},
  {"key":"email","label":"Email (optional)","type":"email","system":true,"required":false}]}]};
const [form] = await sql`insert into registration_forms (kind, segment_id, show_id, title, slug, schema, schema_version, status)
  values ('PUBLIC', ${alice.segment_id}, null, 'Public RSVP', 'public-rsvp-r', ${JSON.stringify(schema)}::text::jsonb, 1, 'OPEN')
  returning id`;
const raw = {
  registrant: { kind: 'flat', values: { contact_name: 'Farah Formfill', contact_email: 'farah.form@example.test',
    contact_phone: '+60 16-424 2424', emergency_contact: '+60 17-313 1313' } },
  party: { kind: 'repeater', rows: [{ full_name: 'Guest Gita', email: 'gita.guest@example.test' }] },
};
await sql`insert into form_responses (form_id, raw, form_schema, identity_key, submitted_at, edit_token)
  values (${form.id}, ${JSON.stringify(raw)}::text::jsonb, ${JSON.stringify(schema)}::text::jsonb,
          'farah.form@example.test', now(), 'EDITSECRET000000001')`;

console.log(JSON.stringify({ ...ids, alice: alice.id, formId: form.id, firstSeat: firstSeat.id, viewer: VIEWER_ID, admin2: ADMIN2_ID }));
await sql.end();
