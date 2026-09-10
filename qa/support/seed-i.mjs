/**
 * QA seed for module `I` — the read-only ticket status page at `/t/{qr_token}`.
 *
 * Every row here exists to make one acceptance criterion observable:
 * - a concert in `Asia/Kuala_Lumpur` (UTC+8), so a browser in another zone is
 *   provably not the zone the page renders in
 * - a party of two, so "names nobody else" is a real assertion
 * - a registration whose contact is a *different* person, with a distinctive
 *   email and phone, so a PII leak is greppable
 * - a segment named `SEGMENT-LEAK-CANARY`, likewise
 * - one confirmed / one admitted / one reverted / one cancelled / one
 *   soft-deleted / one placeholder-named / one waitlisted attendee
 */
import postgres from 'postgres';

const url = process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa';
const sql = postgres(url, { prepare: false, max: 1 });

await sql`truncate table audit_log, check_ins, portal_notes, email_outbox, attendees, registrations,
  form_responses, registration_forms, import_batches, mapping_profiles, player_allocations, players,
  operator_show_assignments, app_users, booklets, show_segments, shows, ticket_templates, concerts,
  system_settings, auth_failures restart identity cascade`;

// FLOW-14 signs an ADMIN in, and the login form refuses to run without its
// throttle settings (spec/README.md §4.2). Nothing else here needs them.
for (const [k, v] of Object.entries({
  'auth.admin_max_attempts': 50,
  'auth.admin_lockout_window_min': 1,
})) {
  await sql`insert into system_settings (key, value) values (${k}, ${JSON.stringify(v)}::text::jsonb)`;
}

const [c] = await sql`insert into concerts (name, slug, status, season, timezone, starts_on)
  values ('QA Concert I', 'qa-i', 'ACTIVE', '2026', 'Asia/Kuala_Lumpur', '2026-09-19') returning id`;

// Doors 19:00, downbeat 19:30 in Kuala Lumpur (UTC+8) => 11:00Z / 11:30Z.
const [s1] = await sql`insert into shows
  (concert_id, name, status, venue_name, venue_address, capacity, starts_at, doors_open_at, portal_unlock_mode)
  values (${c.id}, 'Evening Concert', 'OPEN', 'Dewan Filharmonik Petronas',
          'Tower 2, Persiaran KLCC, 50088 Kuala Lumpur', 400,
          '2026-09-19T11:30:00Z', '2026-09-19T11:00:00Z', 'ON_ADMISSION') returning id`;

const [seg] = await sql`insert into show_segments (show_id, name, audience_mode, capacity)
  values (${s1.id}, 'SEGMENT-LEAK-CANARY', 'PUBLIC', 200) returning id`;

// The ADMIN exists only for FLOW-14: the page needs no session, and the flow
// exists to prove that having one changes nothing.
await sql`insert into app_users (id, email, display_name, role)
  values ('11111111-1111-4111-8111-111111111111'::uuid, 'committee@example.test', 'Committee', 'ADMIN')`;

async function party(contactName, contactEmail, contactPhone, people, status = 'CONFIRMED') {
  const [r] = await sql`insert into registrations
    (show_id, segment_id, source, contact_name, contact_email, contact_phone, status, requested_at)
    values (${s1.id}, ${seg.id}, 'ADMIN', ${contactName}, ${contactEmail}, ${contactPhone},
            ${status}, now()) returning id`;
  const made = [];
  await sql.begin(async (tx) => {
    await tx`select set_config('zetix.granting', 'on', true)`;
    for (const p of people) {
      const [a] = await tx`insert into attendees
        (registration_id, show_id, segment_id, full_name, name_source, allocation_type, status,
         ticket_code, qr_token)
        values (${r.id}, ${s1.id}, ${seg.id}, ${p.name}, ${p.nameSource ?? 'PROVIDED'}, 'BASE',
                ${p.status ?? 'CONFIRMED'}, ${p.code}, ${p.token})
        returning id`;
      made.push({ id: Number(a.id), ...p });
    }
  });
  return { registrationId: Number(r.id), attendees: made };
}

// The booker is not an attendee — a player buying for guests. Their address and
// phone must never reach the page.
const main = await party(
  'Booker Nurul',
  'booker-canary@example.test',
  '+60-CANARY-PHONE',
  [
    { name: 'Aisyah Binti Rahman', code: 'ORC-7K4Q', token: 'IssuedAAAAAAAAAAAAAA01' },
    { name: 'Partner Canary Lim', code: 'ORC-8L5R', token: 'PartyMateBBBBBBBBBBB02' },
  ],
);

const admitted = await party('Booker Nurul', 'booker-canary@example.test', '+60-CANARY-PHONE', [
  { name: 'Admitted Guest', code: 'ORC-9M6S', token: 'AdmittedCCCCCCCCCCCC03' },
]);
const reverted = await party('Booker Nurul', 'booker-canary@example.test', '+60-CANARY-PHONE', [
  { name: 'Reverted Guest', code: 'ORC-2N7T', token: 'RevertedDDDDDDDDDDDD04' },
]);
const cancelled = await party('Marcus Lee', 'marcus@example.test', '+60-2', [
  { name: 'Marcus Lee', code: 'ORC-4Q9W', token: 'CancelledEEEEEEEEEEE05' },
]);
const placeholder = await party('Booker Nurul', 'booker-canary@example.test', '+60-CANARY-PHONE', [
  {
    name: 'Guest of Booker Nurul',
    nameSource: 'PLACEHOLDER',
    code: 'ORC-5R1X',
    token: 'PlaceholderFFFFFFFFF06',
  },
]);
const deleted = await party('Deleted Party', 'deleted@example.test', '+60-3', [
  { name: 'Deleted Guest', code: 'ORC-6S2Y', token: 'DeletedGGGGGGGGGGGGG07' },
]);
const waitlisted = await party(
  'Waiting Party',
  'waiting@example.test',
  '+60-4',
  [{ name: 'Waitlisted Guest', code: 'ORC-7T3Z', token: 'WaitlistHHHHHHHHHHHH08', status: 'WAITLIST' }],
  'WAITLIST',
);

const scan = (attendeeId, at, reverted_at = null) =>
  sql`insert into check_ins (attendee_id, show_id, device_id, scanned_at, synced_at, source, reverted_at)
      values (${attendeeId}, ${s1.id}, 'qa-phone', ${at}, now(), 'ONLINE', ${reverted_at})
      returning id`;

await scan(admitted.attendees[0].id, '2026-09-19T11:12:00Z');
await scan(reverted.attendees[0].id, '2026-09-19T11:14:00Z', '2026-09-19T11:20:00Z');

await sql`update attendees set deleted_at = now() where id = ${deleted.attendees[0].id}`;

// Cancellation through the real path, so the 0001 cascade is what sets the seat.
await sql`update registrations set status = 'CANCELLED' where id = ${cancelled.registrationId}`;

console.log(
  JSON.stringify({
    concertId: Number(c.id),
    showId: Number(s1.id),
    segmentId: Number(seg.id),
    timezone: 'Asia/Kuala_Lumpur',
    tokens: {
      issued: main.attendees[0].token,
      partyMate: main.attendees[1].token,
      admitted: admitted.attendees[0].token,
      reverted: reverted.attendees[0].token,
      cancelled: cancelled.attendees[0].token,
      placeholder: placeholder.attendees[0].token,
      deleted: deleted.attendees[0].token,
      waitlisted: waitlisted.attendees[0].token,
    },
    names: {
      issued: main.attendees[0].name,
      partyMate: main.attendees[1].name,
    },
    canaries: {
      segment: 'SEGMENT-LEAK-CANARY',
      contactEmail: 'booker-canary@example.test',
      contactName: 'Booker Nurul',
      contactPhone: '+60-CANARY-PHONE',
    },
  }),
);
await sql.end();
