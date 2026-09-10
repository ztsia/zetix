/**
 * QA seed for module `H` — the live check-in dashboard, the scan log and
 * operator provisioning.
 *
 * Shapes the fixtures the spec's claims are judged against:
 * - one concert in `Asia/Kuala_Lumpur`, two shows, so cross-show leakage is real
 * - four confirmed attendees on show 1, one cancelled, one attendee on show 2
 * - check-ins spread across three five-minute buckets, two operators, one
 *   duplicate pair for the same attendee (two offline devices, §12.3), and one
 *   check-in of the cancelled attendee (admitted anyway, §12.1)
 * - an ADMIN, an OPERATOR assigned to show 1, and an OPERATOR with no assignment
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
  'checkin.scan_debounce_ms': 0,
})) {
  await sql`insert into system_settings (key, value) values (${k}, ${JSON.stringify(v)}::text::jsonb)`;
}

const [c] = await sql`insert into concerts (name, slug, status, season, timezone, starts_on)
  values ('QA Concert H', 'qa-h', 'ACTIVE', '2026', 'Asia/Kuala_Lumpur', '2026-09-19') returning id`;

const [s1] = await sql`insert into shows (concert_id, name, status, venue_name, capacity, starts_at, doors_open_at)
  values (${c.id}, 'Evening Show', 'OPEN', 'Dewan Filharmonik', 400,
          '2026-09-19T12:00:00Z', '2026-09-19T11:00:00Z') returning id`;
const [s2] = await sql`insert into shows (concert_id, name, status, venue_name, capacity, starts_at, doors_open_at)
  values (${c.id}, 'Saturday Matinee', 'OPEN', 'Victoria Theatre', 300,
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

async function party(showId, segmentId, contactName, people) {
  const [r] = await sql`insert into registrations
    (show_id, segment_id, source, contact_name, contact_email, status, requested_at)
    values (${showId}, ${segmentId}, 'ADMIN', ${contactName}, 'party@example.test',
            'CONFIRMED', now()) returning id`;
  const made = [];
  await sql.begin(async (tx) => {
    await tx`select set_config('zetix.granting', 'on', true)`;
    for (const p of people) {
      const [a] = await tx`insert into attendees
        (registration_id, show_id, segment_id, full_name, name_source, allocation_type, status,
         ticket_code, qr_token)
        values (${r.id}, ${showId}, ${segmentId}, ${p.name}, 'PROVIDED', 'BASE',
                ${p.status ?? 'CONFIRMED'}, ${p.code}, ${p.token})
        returning id`;
      made.push({ id: Number(a.id), ...p });
    }
  });
  return { registrationId: Number(r.id), attendees: made };
}

const tans = await party(s1.id, seg1.id, 'Alice Tan', [
  { name: 'Alice Tan', code: 'ORC-7K4Q', token: 'AliceTan00000000000001' },
  { name: 'Bob Tan', code: 'ORC-8L5R', token: 'BobTan0000000000000002' },
  { name: 'Carol Tan', code: 'ORC-9M6S', token: 'CarolTan00000000000003' },
  { name: 'Dan Tan', code: 'ORC-2N7T', token: 'DanTan0000000000000004' },
]);
const cancelled = await party(s1.id, seg1.id, 'Marcus Lee', [
  { name: 'Marcus Lee', code: 'ORC-4Q9W', token: 'MarcusLee0000000000006', status: 'CANCELLED' },
]);
const other = await party(s2.id, seg2.id, 'Siti Rahman', [
  { name: 'Siti Rahman', code: 'ORC-5R1X', token: 'SitiRahman000000000007' },
]);

const scan = (attendeeId, showId, operatorId, at, source = 'ONLINE', device = 'phone-1') =>
  sql`insert into check_ins (attendee_id, show_id, operator_id, device_id, scanned_at, synced_at, source)
      values (${attendeeId}, ${showId}, ${operatorId}::uuid, ${device}, ${at}, now(), ${source})
      returning id`;

// Alice: two rows, two devices — one arrival (§12.3 accepts the duplicate).
const [aliceA] = await scan(tans.attendees[0].id, s1.id, OP1_ID, '2026-09-19T11:00:00Z');
await scan(tans.attendees[0].id, s1.id, OP2_ID, '2026-09-19T11:00:40Z', 'OFFLINE_SYNC', 'phone-2');
// Bob and Carol, in later buckets.
const [bob] = await scan(tans.attendees[1].id, s1.id, OP1_ID, '2026-09-19T11:03:00Z');
const [carol] = await scan(tans.attendees[2].id, s1.id, OP2_ID, '2026-09-19T11:07:00Z', 'MANUAL');
// Marcus is cancelled and was admitted anyway.
const [marcus] = await scan(cancelled.attendees[0].id, s1.id, OP1_ID, '2026-09-19T11:09:00Z', 'MANUAL');
// The other show has one arrival of its own, so cross-show leakage is testable.
const [siti] = await scan(other.attendees[0].id, s2.id, OP1_ID, '2026-09-19T06:40:00Z');

console.log(
  JSON.stringify({
    concertId: Number(c.id),
    show1: Number(s1.id),
    show2: Number(s2.id),
    segment1: Number(seg1.id),
    tans,
    cancelled,
    other,
    checkIns: {
      aliceA: Number(aliceA.id),
      bob: Number(bob.id),
      carol: Number(carol.id),
      marcus: Number(marcus.id),
      siti: Number(siti.id),
    },
    ADMIN_ID,
    OP1_ID,
    OP2_ID,
  }),
);
await sql.end();
