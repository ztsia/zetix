/**
 * QA seed for module C — spreadsheet import.
 * One concert (Asia/Singapore), one show, three segments:
 *   - "Player Block"  PLAYER_INVITED, capacity 20, base_quota 2, REVIEW
 *   - "Public Block"  PUBLIC, capacity 20, AUTO_FCFS
 *   - "Tiny Block"    PUBLIC, capacity 3,  AUTO_FCFS   (for the overflow flow)
 * Plus three active players and one ADMIN app_user.
 */
import postgres from 'postgres';
const sql = postgres(process.env.QA_DATABASE_URL, { prepare: false, max: 1 });

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const OP1_ID = '22222222-2222-4222-8222-222222222222';

await sql`truncate table audit_log, check_ins, portal_notes, email_outbox, attendees, registrations,
  form_responses, registration_forms, import_batches, mapping_profiles, player_allocations, players,
  operator_show_assignments, app_users, booklets, show_segments, shows, ticket_templates, concerts,
  system_settings, auth_failures restart identity cascade`;

for (const [k, v] of Object.entries({
  'auth.admin_max_attempts': 20,
  'auth.admin_lockout_window_min': 1,
  'checkin.manifest_ttl_hours': 12,
  'import.fuzzy_match_threshold': 0.85,
})) {
  await sql`insert into system_settings (key, value) values (${k}, ${JSON.stringify(v)}::text::jsonb)`;
}

const [c] = await sql`insert into concerts (name, slug, status, season, timezone, starts_on)
  values ('QA Concert', 'qa-concert', 'ACTIVE', '2026', 'Asia/Singapore', '2026-09-19') returning id`;
const [s1] = await sql`insert into shows (concert_id, name, status, venue_name, capacity, starts_at)
  values (${c.id}, 'Show One', 'OPEN', 'Esplanade', 60, '2026-09-19T11:30:00Z') returning id`;

const [segPlayer] = await sql`insert into show_segments
  (show_id, name, audience_mode, capacity, base_quota, extras_policy, max_tickets_per_response, display_order)
  values (${s1.id}, 'Player Block', 'PLAYER_INVITED', 20, 2, 'REVIEW', 4, 1) returning id`;
const [segPublic] = await sql`insert into show_segments
  (show_id, name, audience_mode, capacity, extras_policy, max_tickets_per_response, display_order)
  values (${s1.id}, 'Public Block', 'PUBLIC', 20, 'AUTO_FCFS', 4, 2) returning id`;
const [s2] = await sql`insert into shows (concert_id, name, status, venue_name, capacity, starts_at)
  values (${c.id}, 'Show Two', 'OPEN', 'Victoria', 10, '2026-09-19T15:30:00Z') returning id`;
const [segTiny] = await sql`insert into show_segments
  (show_id, name, audience_mode, capacity, extras_policy, max_tickets_per_response, display_order)
  values (${s2.id}, 'Tiny Block', 'PUBLIC', 3, 'AUTO_FCFS', 4, 1) returning id`;

const players = [];
for (const [name, email] of [
  ['Alice Tan', 'alice@players.test'],
  ['Ben Lim', 'ben@players.test'],
  ['Carol Ng', 'carol@players.test'],
]) {
  const [p] = await sql`insert into players (concert_id, full_name, email, invite_token, is_active)
    values (${c.id}, ${name}, ${email}, ${'tok-' + email}, true) returning id`;
  players.push(p.id);
}

await sql`insert into app_users (id, email, display_name, role) values
  (${ADMIN_ID}::uuid, ${process.env.QA_ADMIN_EMAIL}, 'Committee', 'ADMIN'),
  (${OP1_ID}::uuid, 'wei-ling@operators.invalid', 'Wei Ling', 'OPERATOR')`;
await sql`insert into operator_show_assignments (user_id, show_id) values (${OP1_ID}::uuid, ${s1.id})`;

console.log(JSON.stringify({
  concertId: c.id, showId: s1.id, show2: s2.id,
  segPlayer: segPlayer.id, segPublic: segPublic.id, segTiny: segTiny.id,
  players, ADMIN_ID, OP1_ID,
}));
await sql.end();
