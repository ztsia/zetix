/**
 * QA seed for module `G`'s browser pass — the door.
 *
 * F2's actors (an ADMIN, an assigned OPERATOR, an unassigned one) plus what the
 * scanner is judged against: a **party of four on one registration**, which is
 * the case §12.1's "Admit remaining 3" exists for and the one that goes wrong
 * silently; a **cancelled** attendee, who must read "refer to desk" and never
 * "not found"; and an attendee on a **second show**, so wrong-show can be
 * exercised against a real other show rather than a fabricated token.
 *
 * Tokens are fixed strings rather than minted, so a spec can scan a known QR.
 * They are 22 characters of base62, which is the shape module D mints and the
 * shape the scanner extracts by (spec/tickets.md §10.1).
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
  // Zero, so a spec can scan twice in a row without fighting the debounce.
  // The real value is a settings row an admin enters (CLAUDE.md).
  'checkin.scan_debounce_ms': 0,
})) {
  await sql`insert into system_settings (key, value) values (${k}, ${JSON.stringify(v)}::text::jsonb)`;
}

const [c] = await sql`insert into concerts (name, slug, status, season, timezone, starts_on)
  values ('QA Concert G', 'qa-g', 'ACTIVE', '2026', 'Asia/Kuala_Lumpur', '2026-09-19') returning id`;

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

// A party of four — the "one phone comes out for a family" case (§12.1).
const tans = await party(s1.id, seg1.id, 'Alice Tan', [
  { name: 'Alice Tan', code: 'ORC-7K4Q', token: 'AliceTan00000000000001' },
  { name: 'Bob Tan', code: 'ORC-8L5R', token: 'BobTan0000000000000002' },
  { name: 'Carol Tan', code: 'ORC-9M6S', token: 'CarolTan00000000000003' },
  { name: 'Dan Tan', code: 'ORC-2N7T', token: 'DanTan0000000000000004' },
]);

// A party of one, for the case where nothing extra should be offered.
const solo = await party(s1.id, seg1.id, 'Priya Nair', [
  { name: 'Priya Nair', code: 'ORC-3P8V', token: 'PriyaNair00000000005a' + 'x' },
]);

// Cancelled — must read "refer to desk", never "not found" (§7.9).
const cancelled = await party(s1.id, seg1.id, 'Marcus Lee', [
  { name: 'Marcus Lee', code: 'ORC-4Q9W', token: 'MarcusLee0000000000006', status: 'CANCELLED' },
]);

// A real attendee of the *other* show, so wrong-show is genuine.
const other = await party(s2.id, seg2.id, 'Siti Rahman', [
  { name: 'Siti Rahman', code: 'ORC-5R1X', token: 'SitiRahman000000000007' },
]);

console.log(
  JSON.stringify({
    concertId: Number(c.id),
    show1: Number(s1.id),
    show2: Number(s2.id),
    tans,
    solo,
    cancelled,
    other,
    ADMIN_ID,
    OP1_ID,
    OP2_ID,
  }),
);
await sql.end();
