import postgres from 'postgres';
const url = process.env.QA_DATABASE_URL;
const sql = postgres(url, { prepare: false, max: 1 });

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const OP1_ID   = '22222222-2222-4222-8222-222222222222';
const OP2_ID   = '33333333-3333-4333-8333-333333333333';
const ORPHAN_ID= '44444444-4444-4444-8444-444444444444';

await sql`truncate table audit_log, check_ins, portal_notes, email_outbox, attendees, registrations,
  form_responses, registration_forms, import_batches, mapping_profiles, player_allocations, players,
  operator_show_assignments, app_users, booklets, show_segments, shows, ticket_templates, concerts,
  system_settings, auth_failures restart identity cascade`;

// system settings — only the seeded system half (domain.md §6)
for (const [k, v] of Object.entries({
  'auth.admin_max_attempts': 3,
  'auth.admin_lockout_window_min': 1,
  'checkin.manifest_ttl_hours': 12,
})) {
  await sql`insert into system_settings (key, value) values (${k}, ${JSON.stringify(v)}::text::jsonb)`;
}

const [c] = await sql`insert into concerts (name, slug, status, season, timezone, starts_on)
  values ('QA Concert', 'qa-concert', 'ACTIVE', '2026', 'Asia/Singapore', '2026-09-19') returning id`;
const [s1] = await sql`insert into shows (concert_id, name, status, venue_name, starts_at)
  values (${c.id}, 'Show One', 'OPEN', 'Esplanade', '2026-09-19T11:30:00Z') returning id`;
const [s2] = await sql`insert into shows (concert_id, name, status, venue_name, starts_at)
  values (${c.id}, 'Show Two', 'OPEN', 'Victoria', '2026-09-19T15:30:00Z') returning id`;

await sql`insert into app_users (id, email, display_name, role) values
  (${ADMIN_ID}::uuid, ${process.env.QA_ADMIN_EMAIL}, 'Committee', 'ADMIN'),
  (${OP1_ID}::uuid, 'wei-ling@operators.invalid', 'Wei Ling', 'OPERATOR'),
  (${OP2_ID}::uuid, 'bob-tan@operators.invalid', 'Bob Tan', 'OPERATOR'),
  (${ORPHAN_ID}::uuid, 'ghost@operators.invalid', 'Ghost', 'OPERATOR')`;
// the orphan has an auth identity but NO app_users row: delete it back out
await sql`delete from app_users where id = ${ORPHAN_ID}::uuid`;

await sql`insert into operator_show_assignments (user_id, show_id)
  values (${OP1_ID}::uuid, ${s1.id})`;

console.log(JSON.stringify({ concertId: c.id, show1: s1.id, show2: s2.id,
  ADMIN_ID, OP1_ID, OP2_ID, ORPHAN_ID }));
await sql.end();
