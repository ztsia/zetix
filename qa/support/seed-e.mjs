/**
 * QA seed for module `E`'s browser pass.
 *
 * F2's actors (ADMIN + assigned/unassigned OPERATOR) plus what the template
 * editor is judged against: one concert in `Asia/Kuala_Lumpur` whose show
 * starts at 20:00 local (12:00Z), so a timestamp that moved with the viewer's
 * zone would be visible; and a party holding one very ordinary name and one
 * absurdly long one, which is what the longest-name preview has to find.
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

for (const [k, v] of Object.entries({
  'auth.admin_max_attempts': 50,
  'auth.admin_lockout_window_min': 1,
  'checkin.manifest_ttl_hours': 12,
})) {
  await sql`insert into system_settings (key, value) values (${k}, ${JSON.stringify(v)}::text::jsonb)`;
}

const [c] = await sql`insert into concerts (name, slug, status, season, timezone, starts_on)
  values ('QA Concert E', 'qa-e', 'ACTIVE', '2026', 'Asia/Kuala_Lumpur', '2026-09-19') returning id`;

// 20:00 in Kuala Lumpur, doors 19:00. Both are 8 hours from UTC.
const [s1] = await sql`insert into shows (concert_id, name, status, venue_name, venue_address, capacity, starts_at, doors_open_at)
  values (${c.id}, 'Evening Show', 'OPEN', 'Dewan Filharmonik', '1 Jalan Ampang', 400,
          '2026-09-19T12:00:00Z', '2026-09-19T11:00:00Z') returning id`;
const [s2] = await sql`insert into shows (concert_id, name, status, venue_name, capacity, starts_at, doors_open_at)
  values (${c.id}, 'Matinee Show', 'OPEN', 'Victoria Theatre', 300,
          '2026-09-19T07:00:00Z', '2026-09-19T06:30:00Z') returning id`;

const [seg1] = await sql`insert into show_segments (show_id, name, audience_mode, capacity)
  values (${s1.id}, 'Public', 'PUBLIC', 200) returning id`;
const [seg2] = await sql`insert into show_segments (show_id, name, audience_mode, capacity)
  values (${s2.id}, 'Public', 'PUBLIC', 150) returning id`;

await sql`insert into app_users (id, email, display_name, role) values
  (${ADMIN_ID}::uuid, ${process.env.QA_ADMIN_EMAIL ?? 'committee@example.test'}, 'Committee', 'ADMIN'),
  (${OP1_ID}::uuid, 'wei-ling@operators.invalid', 'Wei Ling', 'OPERATOR'),
  (${OP2_ID}::uuid, 'no-shows@operators.invalid', 'No Shows', 'OPERATOR')`;
await sql`insert into operator_show_assignments (user_id, show_id) values (${OP1_ID}::uuid, ${s1.id})`;

const LONGEST = 'Wilhelmina Aurelia Constance Featherstonehaugh-Villanueva';

async function party(showId, segmentId, contactName, names) {
  const [r] = await sql`insert into registrations
    (show_id, segment_id, source, contact_name, contact_email, status, requested_at)
    values (${showId}, ${segmentId}, 'ADMIN', ${contactName}, 'party@example.test',
            'CONFIRMED', now()) returning id`;
  const ids = [];
  await sql.begin(async (tx) => {
    await tx`select set_config('zetix.granting', 'on', true)`;
    for (const name of names) {
      const [a] = await tx`insert into attendees
        (registration_id, show_id, segment_id, full_name, name_source, allocation_type, status)
        values (${r.id}, ${showId}, ${segmentId}, ${name}, 'PROVIDED', 'BASE', 'CONFIRMED')
        returning id`;
      ids.push(Number(a.id));
    }
  });
  return { registrationId: Number(r.id), attendeeIds: ids };
}

const p1 = await party(s1.id, seg1.id, 'Alice Tan', ['Alice Tan', LONGEST]);
const p2 = await party(s2.id, seg2.id, 'Bob Lim', ['Bob Lim']);

console.log(
  JSON.stringify({
    concertId: Number(c.id),
    show1: Number(s1.id),
    show2: Number(s2.id),
    longestName: LONGEST,
    party1: p1,
    party2: p2,
    ADMIN_ID,
    OP1_ID,
    OP2_ID,
  }),
);
await sql.end();
