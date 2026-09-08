/**
 * QA seed for module `A`'s browser pass.
 *
 * The shape module A is judged against: one concert in `Asia/Kuala_Lumpur`, one
 * hall of 400 split 300 public / 100 player-invited at a base quota of 1, and
 * 80 active players — the §7.4 arithmetic sitting exactly on its boundary, so
 * one more player is a refusal and one fewer is not.
 *
 * Also seeds F2's actors so the authorization matrix has all four cells.
 */
import postgres from 'postgres';

const url = process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa';
const sql = postgres(url, { prepare: false, max: 1 });

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const OP1_ID = '22222222-2222-4222-8222-222222222222';
const OP2_ID = '33333333-3333-4333-8333-333333333333';

await sql`truncate table audit_log, check_ins, portal_notes, email_outbox, attendees, registrations,
  form_responses, registration_forms, import_batches, mapping_profiles, player_allocations, players,
  operator_show_assignments, app_users, booklets, show_segments, shows, ticket_templates, concerts,
  system_settings, auth_failures restart identity cascade`;

// Only the seeded system half of §6. No operational value is seeded — that is
// the point of the module under test.
for (const [k, v] of Object.entries({
  'auth.admin_max_attempts': 50,
  'auth.admin_lockout_window_min': 1,
  'checkin.manifest_ttl_hours': 12,
  'email.max_per_dispatch': 25,
  'email.max_per_day': 450,
  'keepalive.enabled': true,
})) {
  await sql`insert into system_settings (key, value) values (${k}, ${JSON.stringify(v)}::text::jsonb)`;
}

const [c] = await sql`insert into concerts (name, slug, status, season, timezone, starts_on)
  values ('QA September', 'qa-sep', 'ACTIVE', '2026', 'Asia/Kuala_Lumpur', '2026-09-19') returning id`;

// 20:00 at the venue on 19 Sep, which is 12:00Z. The rendered time must not move
// with the viewer's zone (domain.md §6.1).
const [s1] = await sql`insert into shows (concert_id, name, status, venue_name, capacity, starts_at, doors_open_at)
  values (${c.id}, 'Evening Show', 'OPEN', 'Dewan Filharmonik', 400, '2026-09-19T12:00:00Z', '2026-09-19T11:00:00Z') returning id`;
const [s2] = await sql`insert into shows (concert_id, name, status, venue_name, capacity, starts_at)
  values (${c.id}, 'Matinee Show', 'OPEN', 'Dewan Filharmonik', 200, '2026-09-19T07:00:00Z') returning id`;

const [pub] = await sql`insert into show_segments (show_id, name, audience_mode, capacity, display_order)
  values (${s1.id}, 'Public', 'PUBLIC', 300, 1) returning id`;
const [inv] = await sql`insert into show_segments (show_id, name, audience_mode, capacity, base_quota, display_order)
  values (${s1.id}, 'Player invited', 'PLAYER_INVITED', 100, 1, 2) returning id`;

await sql`insert into players (concert_id, full_name, email, instrument, section, invite_token, is_active)
  select ${c.id}, 'Player ' || g, 'player' || g || '@example.test',
         (array['Violin','Cello','Horn','Flute'])[1 + (g % 4)],
         (array['Strings','Brass','Woodwind'])[1 + (g % 3)],
         'seedtoken' || lpad(g::text, 13, '0'), true
    from generate_series(1, 80) g`;

await sql`insert into app_users (id, email, display_name, role) values
  (${ADMIN_ID}::uuid, ${process.env.QA_ADMIN_EMAIL ?? 'committee@example.test'}, 'Committee', 'ADMIN'),
  (${OP1_ID}::uuid, 'wei-ling@operators.invalid', 'Wei Ling', 'OPERATOR'),
  (${OP2_ID}::uuid, 'no-shows@operators.invalid', 'No Shows', 'OPERATOR')`;

await sql`insert into operator_show_assignments (user_id, show_id) values (${OP1_ID}::uuid, ${s1.id})`;

console.log(
  JSON.stringify({
    concertId: c.id,
    show1: s1.id,
    show2: s2.id,
    publicSegment: pub.id,
    playerSegment: inv.id,
    ADMIN_ID,
    OP1_ID,
    OP2_ID,
  }),
);
await sql.end();
