/**
 * QA seed for module `B`'s browser pass.
 *
 * Module `A`'s shape — one 400-seat hall split 300 public / 100 player-invited
 * at a base quota of 1, 80 active players — plus the registrations `B` is
 * actually judged against:
 *
 * - a player party whose base seat is confirmed and whose two extras are held
 *   for the §7.5 review;
 * - enough further extras requests, at distinct `requested_at` times, that the
 *   FCFS walk has a boundary to stop at;
 * - a confirmed public party, so cancel and restore have something to act on.
 *
 * Every seat goes through `claim_seats()`, exactly as the screens do — a seed
 * that inserted attendees directly would set up a state the application can
 * never produce.
 */
import postgres from 'postgres';

const url = process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa';
const sql = postgres(url, { prepare: false, max: 1 });

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const OP1_ID = '22222222-2222-4222-8222-222222222222';

await sql`truncate table audit_log, check_ins, portal_notes, email_outbox, attendees, registrations,
  form_responses, registration_forms, import_batches, mapping_profiles, player_allocations, players,
  operator_show_assignments, app_users, booklets, show_segments, shows, ticket_templates, concerts,
  system_settings, auth_failures restart identity cascade`;

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

const [s1] = await sql`insert into shows (concert_id, name, status, venue_name, capacity, starts_at, doors_open_at)
  values (${c.id}, 'Evening Show', 'OPEN', 'Dewan Filharmonik', 400, '2026-09-19T12:00:00Z', '2026-09-19T11:00:00Z') returning id`;
const [s2] = await sql`insert into shows (concert_id, name, status, venue_name, capacity, starts_at)
  values (${c.id}, 'Matinee Show', 'OPEN', 'Dewan Filharmonik', 200, '2026-09-19T07:00:00Z') returning id`;

const [pub] = await sql`insert into show_segments (show_id, name, audience_mode, capacity, extras_policy, display_order)
  values (${s1.id}, 'Public', 'PUBLIC', 300, 'AUTO_FCFS', 1) returning id`;
// REVIEW, and a deadline still ahead: extras hold, and the pool sits below the
// free seats by everything the 80 players have not claimed (§7.2).
const [inv] = await sql`insert into show_segments (
    show_id, name, audience_mode, capacity, base_quota, base_claim_deadline,
    extras_policy, allow_partial_grant, display_order)
  values (${s1.id}, 'Player invited', 'PLAYER_INVITED', 100, 1,
          '2026-09-15T16:00:00Z', 'REVIEW', false, 2) returning id`;
// A second hall, so "move to another show" has somewhere to go.
const [matinee] = await sql`insert into show_segments (show_id, name, audience_mode, capacity, extras_policy, display_order)
  values (${s2.id}, 'Public', 'PUBLIC', 200, 'AUTO_FCFS', 1) returning id`;

await sql`insert into players (concert_id, full_name, email, instrument, section, invite_token, is_active)
  select ${c.id}, 'Player ' || g, 'player' || g || '@example.test',
         (array['Violin','Cello','Horn','Flute'])[1 + (g % 4)],
         (array['Strings','Brass','Woodwind'])[1 + (g % 3)],
         'seedtoken' || lpad(g::text, 13, '0'), true
    from generate_series(1, 80) g`;

await sql`insert into app_users (id, email, display_name, role) values
  (${ADMIN_ID}::uuid, ${process.env.QA_ADMIN_EMAIL ?? 'committee@example.test'}, 'Committee', 'ADMIN'),
  (${OP1_ID}::uuid, 'wei-ling@operators.invalid', 'Wei Ling', 'OPERATOR')`;
await sql`insert into operator_show_assignments (user_id, show_id) values (${OP1_ID}::uuid, ${s1.id})`;

const players = await sql`select id, full_name from players where concert_id = ${c.id} order by id limit 6`;

/** One party, through the engine, exactly as the screens create them. */
async function party({ segmentId, showId, playerId, name, email, requestedAt, seats }) {
  const [r] = await sql`
    insert into registrations (
      show_id, segment_id, player_id, source, contact_name, contact_email,
      status, requested_at, round_label)
    values (${showId}, ${segmentId}, ${playerId ?? null}, 'IMPORT', ${name}, ${email},
            'WAITLIST', ${requestedAt}, 'Round 1')
    returning id`;
  await sql`select claim_seats(${segmentId}::bigint, ${r.id}::bigint, ${JSON.stringify(seats)}::text::jsonb, false)`;
  await sql`
    update registrations r set status = case
      when exists (select 1 from attendees a where a.registration_id = r.id and a.status = 'CONFIRMED') then 'CONFIRMED'
      when exists (select 1 from attendees a where a.registration_id = r.id and a.status = 'PENDING_REVIEW') then 'PENDING_REVIEW'
      else 'WAITLIST' end::booking_status
    where r.id = ${r.id}`;
  return r.id;
}

const base = (n) => ({ full_name: n, allocation_type: 'BASE' });
const extra = (n) => ({ full_name: n, allocation_type: 'EXTRA' });

// Four player parties at distinct request times, so the review screen has a
// queue with a real order — and, at a pool of 20, a boundary to stop at.
const reviewParties = [
  { at: '2026-09-10T01:00:00Z', player: 0, seats: [base('Player 1'), extra('Guest of Player 1'), extra('Second guest')] },
  { at: '2026-09-10T02:30:00Z', player: 1, seats: [base('Player 2'), extra('Aunt May')] },
  { at: '2026-09-11T09:15:00Z', player: 2, seats: [base('Player 3'), extra('Guest A'), extra('Guest B'), extra('Guest C')] },
  { at: '2026-09-12T04:45:00Z', player: 3, seats: [base('Player 4'), extra('One more')] },
];

for (const [i, p] of reviewParties.entries()) {
  await party({
    segmentId: inv.id,
    showId: s1.id,
    playerId: players[p.player].id,
    name: players[p.player].full_name,
    email: `player${p.player + 1}@example.test`,
    requestedAt: p.at,
    seats: p.seats,
  });
  if (i === 0) continue;
}

// Public parties: confirmed on arrival, because that segment is AUTO_FCFS.
await party({
  segmentId: pub.id,
  showId: s1.id,
  name: 'Alice Tan',
  email: 'alice@example.test',
  requestedAt: '2026-09-09T03:00:00Z',
  seats: [extra('Alice Tan'), extra('Bernard Lim'), extra('Cheryl Ng')],
});
await party({
  segmentId: pub.id,
  showId: s1.id,
  name: 'Daniel Wong',
  email: 'daniel@example.test',
  requestedAt: '2026-09-09T06:20:00Z',
  seats: [extra('Daniel Wong'), extra(null)],
});

console.log(
  JSON.stringify({
    concertId: c.id,
    show1: s1.id,
    show2: s2.id,
    publicSegment: pub.id,
    playerSegment: inv.id,
    matineeSegment: matinee.id,
    ADMIN_ID,
  }),
);
await sql.end();
