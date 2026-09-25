/**
 * QA seed for module `S` — the Audience workspace.
 *
 * Starts from module `B`'s seed (one concert, a 300-seat public segment, a
 * 100-seat player segment under REVIEW with four player parties holding
 * extras, two confirmed public parties), then spreads parties across the
 * stages and flags so every built-in view has something in it:
 *
 * - `B`'s imported parties stay unapproved: Needs review (§25.4);
 * - a public party with a verification token and no click: Unverified;
 * - Alice Tan approved with tickets issued and delivered: Sent — one seat's
 *   name then changed, so Changed after send;
 * - Daniel Wong approved and issued, not sent: Ready to send (and he has an
 *   unnamed guest: Unnamed guests);
 * - a party with `gmail.con`: Suspicious address;
 * - a cancelled party: Cancelled.
 *
 * `admin.typed_confirm_above` is 2, so Void and re-issue QR on three seats asks
 * for the typed phrase.
 */
import { execFileSync } from 'node:child_process';
import postgres from 'postgres';

const url = process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa';
const seedB = execFileSync('node', ['qa/support/seed-b.mjs'], { env: process.env, encoding: 'utf8' });
const ids = JSON.parse(seedB.trim().split('\n').at(-1));

const sql = postgres(url, { prepare: false, max: 1 });

await sql`insert into system_settings (key, value) values ('admin.typed_confirm_above', '2'::jsonb)
          on conflict (key) do update set value = excluded.value`;

// B's parties were imported, so they are not approved (§25.4).
await sql`update registrations set approved_at = null`;

const [template] = await sql`
  insert into ticket_templates (concert_id, name, version, background_kind, page_width_pt, page_height_pt, layout, is_default)
  values (${ids.concertId}, 'Default', 1, 'NONE', 595, 280,
          '{"canvas":{"width_pt":595,"height_pt":280,"dpi":300},"elements":[]}'::jsonb,
          true)
  returning id`;

async function party({ name, email, seats, requestedAt, segmentId = ids.publicSegment, showId = ids.show1 }) {
  const [r] = await sql`
    insert into registrations (show_id, segment_id, source, contact_name, contact_email, status, requested_at)
    values (${showId}, ${segmentId}, 'FORM', ${name}, ${email}, 'WAITLIST', ${requestedAt})
    returning id`;
  await sql`select claim_seats(${segmentId}::bigint, ${r.id}::bigint, ${JSON.stringify(seats)}::text::jsonb, false)`;
  await sql`update registrations set status = 'CONFIRMED' where id = ${r.id}
             and exists (select 1 from attendees where registration_id = ${r.id} and status = 'CONFIRMED')`;
  return r.id;
}
const extra = (n) => ({ full_name: n, allocation_type: 'EXTRA' });

async function issue(registrationId) {
  await sql`
    update attendees a
       set qr_token = substr(md5(random()::text || a.id::text), 1, 22),
           ticket_code = 'ORC-' || upper(substr(md5(random()::text || a.id::text), 1, 4)),
           ticket_template_id = ${template.id}, ticket_template_version = 1,
           ticket_issued_at = now()
     where a.registration_id = ${registrationId} and a.status = 'CONFIRMED' and a.qr_token is null`;
}

const [alice] = await sql`select id from registrations where contact_name = 'Alice Tan'`;
const [daniel] = await sql`select id from registrations where contact_name = 'Daniel Wong'`;
await sql`update registrations set approved_at = now(), source = 'FORM' where id in (${alice.id}, ${daniel.id})`;
await issue(alice.id);
await issue(daniel.id);
await sql`update attendees set ticket_sent_at = now() - interval '1 day', ticket_sent_source = 'EMAIL'
           where registration_id = ${alice.id}`;
await sql`update attendees set needs_reissue = true
           where id = (select min(id) from attendees where registration_id = ${alice.id})`;

const unverified = await party({
  name: 'Farah Aziz',
  email: 'farah@example.test',
  requestedAt: '2026-09-09T08:00:00Z',
  seats: [extra('Farah Aziz'), extra('Omar Aziz')],
});
await sql`update registrations set approved_at = now(), verification_token = 'qa-verify-farah' where id = ${unverified}`;

const suspicious = await party({
  name: 'Grace Lee',
  email: 'grace@gmail.con',
  requestedAt: '2026-09-09T09:00:00Z',
  seats: [extra('Grace Lee')],
});
await sql`update registrations set approved_at = now(), email_issue = 'We could not find the mail server for “gmail.con”.',
           email_checked_at = now() where id = ${suspicious}`;

const cancelled = await party({
  name: 'Hassan Ali',
  email: 'hassan@example.test',
  requestedAt: '2026-09-09T10:00:00Z',
  seats: [extra('Hassan Ali'), extra('Sara Ali')],
});
await sql`update registrations set approved_at = now(), status = 'CANCELLED' where id = ${cancelled}`;

// A read-only account (spec/v3.md §28), as module R's seed has it.
await sql`insert into app_users (id, email, display_name, role)
          values ('33333333-3333-4333-8333-333333333333'::uuid, 'mei@example.test', 'Mei Viewer', 'VIEWER')
          on conflict (id) do nothing`;

await sql`insert into email_templates (key, name, subject, body_md) values
  ('public_verify', 'Verify', 'Please confirm your email', 'Click {{verify_url}}')
  on conflict (key) do nothing`;

console.log(JSON.stringify({ ...ids, alice: alice.id, daniel: daniel.id, unverified, suspicious, cancelled }));
await sql.end();
