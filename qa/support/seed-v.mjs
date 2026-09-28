/**
 * QA seed for module `V` — intake.
 *
 * Starts from `T`'s seed (accounts, concert 1 with a show already in the past),
 * then adds concert "QA Intake" with shows in the FUTURE, because the party
 * update link closes when the show starts (§25.6):
 *
 * - Autumn Evening (cap 60): Public segment (40, AUTO_FCFS, partial grant OFF)
 *   with form `qa-autumn`; Player segment (20, base quota 2) with form
 *   `qa-players`. Players: Aisha Rahman, Benjamin Koh (active), Chloe Inactive
 *   (inactive), Dmitri Deleted (soft-deleted).
 * - Nadia Hassan: public party, 2 seats (one unnamed), update token
 *   `qa-update-nadia-0000000000`, tickets issued.
 * - Kenji Sato (public) and Kenji Satoh (player segment, Aisha): same email,
 *   so an OPEN duplicate pair.
 * - Autumn Matinee (cap 2): Public segment full; form `qa-full-wait`
 *   (waitlist when full) and `qa-full-closed` (neither waitlist nor auto-close).
 *
 * Accounts: committee (ADMIN), mei (VIEWER), wei-ling (OPERATOR, assigned to
 * Autumn Evening), bob (OPERATOR, unassigned).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const url = process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa';
const seedT = execFileSync('node', ['qa/support/seed-t.mjs'], { env: process.env, encoding: 'utf8' });
const ids = JSON.parse(seedT.trim().split('\n').at(-1));
const sql = postgres(url, { prepare: false, max: 1 });
const schemas = JSON.parse(readFileSync(process.env.QA_SCHEMAS, 'utf8'));

const VIEWER_ID = '33333333-3333-4333-8333-333333333333';
const OP1_ID = '22222222-2222-4222-8222-222222222222';
const OP2_ID = '44444444-4444-4444-8444-444444444444';
await sql`insert into app_users (id, email, display_name, role) values
  (${VIEWER_ID}::uuid, 'mei@example.test', 'Mei Viewer', 'VIEWER'),
  (${OP2_ID}::uuid, 'bob@operators.invalid', 'Bob Unassigned', 'OPERATOR')
  on conflict (id) do nothing`;

for (const [k, v] of Object.entries({
  'email.receipt_hold_minutes': 10,
  'review.auto_approve_clean': false,
  'review.duplicate_name_similarity': 0.8,
  'form.max_tickets_per_response': 4,
  'form.extra_rows_max': 2,
  'form.rate_limit_per_ip_per_min': 1000,
  'import.fuzzy_match_threshold': 0.8,
})) {
  await sql`insert into system_settings (key, value) values (${k}, ${JSON.stringify(v)}::text::jsonb)
            on conflict (key) do update set value = excluded.value`;
}

const [c] = await sql`insert into concerts (name, slug, status, season, timezone, starts_on)
  values ('QA Intake', 'qa-intake', 'ACTIVE', '2026', 'Asia/Kuala_Lumpur', '2026-11-20') returning id`;
const [eve] = await sql`insert into shows (concert_id, name, status, venue_name, capacity, starts_at, doors_open_at)
  values (${c.id}, 'Autumn Evening', 'OPEN', 'Dewan Filharmonik', 60, '2026-11-20T12:00:00Z', '2026-11-20T11:00:00Z') returning id`;
const [mat] = await sql`insert into shows (concert_id, name, status, venue_name, capacity, starts_at)
  values (${c.id}, 'Autumn Matinee', 'OPEN', 'Dewan Filharmonik', 2, '2026-11-20T06:00:00Z') returning id`;
const [pub] = await sql`insert into show_segments (show_id, name, audience_mode, capacity, extras_policy, allow_partial_grant, display_order)
  values (${eve.id}, 'Public', 'PUBLIC', 40, 'AUTO_FCFS', false, 1) returning id`;
const [ply] = await sql`insert into show_segments (show_id, name, audience_mode, capacity, base_quota, extras_policy, display_order)
  values (${eve.id}, 'Player invited', 'PLAYER_INVITED', 20, 2, 'AUTO_FCFS', 2) returning id`;
const [matPub] = await sql`insert into show_segments (show_id, name, audience_mode, capacity, extras_policy, allow_partial_grant, display_order)
  values (${mat.id}, 'Public', 'PUBLIC', 2, 'AUTO_FCFS', false, 1) returning id`;

await sql`insert into operator_show_assignments (user_id, show_id) values (${OP1_ID}::uuid, ${eve.id}) on conflict do nothing`;

const player = async (name, email, active = true, deleted = false) => {
  const [p] = await sql`insert into players (concert_id, full_name, email, invite_token, is_active, deleted_at)
    values (${c.id}, ${name}, ${email}, ${'qa-invite-' + name.split(' ')[0].toLowerCase() + '-000000'}, ${active}, ${deleted ? sql`now()` : null})
    returning id`;
  return Number(p.id);
};
const aisha = await player('Aisha Rahman', 'aisha.rahman@band.example');
const benjamin = await player('Benjamin Koh', 'benjamin.koh@band.example');
const chloe = await player('Chloe Inactive', 'chloe@band.example', false);
const dmitri = await player('Dmitri Deleted', 'dmitri@band.example', true, true);

const form = async (segmentId, kind, slug, title, extra = {}) => {
  const [f] = await sql`insert into registration_forms (segment_id, kind, title, slug, schema, status, waitlist_when_full, auto_close_on_capacity)
    values (${segmentId}, ${kind}, ${title}, ${slug}, ${JSON.stringify(schemas[kind])}::text::jsonb, 'OPEN',
            ${extra.waitlist ?? null}, ${extra.autoClose ?? null}) returning id`;
  return Number(f.id);
};
const autumnForm = await form(pub.id, 'PUBLIC', 'qa-autumn', 'Autumn Evening — public registration');
const playerForm = await form(ply.id, 'PLAYER', 'qa-players', 'Autumn Evening — players’ guests');
const waitForm = await form(matPub.id, 'PUBLIC', 'qa-full-wait', 'Autumn Matinee — waitlist', { waitlist: true });
const closedForm = await form(matPub.id, 'PUBLIC', 'qa-full-closed', 'Autumn Matinee — full');

async function party({ segmentId, showId, name, email, seats, playerId = null, token = null, approved = true, at }) {
  const [r] = await sql`
    insert into registrations (show_id, segment_id, player_id, source, contact_name, contact_email, contact_phone, status, requested_at, approved_at, update_token, email_checked_at)
    values (${showId}, ${segmentId}, ${playerId}, 'ADMIN', ${name}, ${email}, null, 'WAITLIST', ${at}, ${approved ? sql`now()` : null}, ${token}, now())
    returning id`;
  await sql`select claim_seats(${segmentId}::bigint, ${r.id}::bigint, ${JSON.stringify(seats)}::text::jsonb, false)`;
  await sql`update registrations r set status = case
      when exists (select 1 from attendees a where a.registration_id = r.id and a.status = 'CONFIRMED') then 'CONFIRMED'
      when exists (select 1 from attendees a where a.registration_id = r.id and a.status = 'PENDING_REVIEW') then 'PENDING_REVIEW'
      else 'WAITLIST' end::booking_status where r.id = ${r.id}`;
  await sql`select refresh_duplicate_candidates(${r.id}::bigint)`;
  return Number(r.id);
}
const extra = (n) => ({ full_name: n, allocation_type: 'EXTRA' });
const base = (n) => ({ full_name: n, allocation_type: 'BASE' });

const nadia = await party({ segmentId: pub.id, showId: eve.id, name: 'Nadia Hassan', email: 'nadia@example.test',
  seats: [extra('Nadia Hassan'), extra(null)], token: 'qa-update-nadia-0000000000', at: '2026-10-01T02:00:00Z' });
const kenjiPub = await party({ segmentId: pub.id, showId: eve.id, name: 'Kenji Sato', email: 'kenji@example.test',
  seats: [extra('Kenji Sato'), extra('Yui Sato')], approved: false, at: '2026-10-02T02:00:00Z' });
const kenjiPly = await party({ segmentId: ply.id, showId: eve.id, name: 'Kenji Satoh', email: 'kenji@example.test', playerId: aisha,
  seats: [base('Haruto Sato')], approved: false, at: '2026-10-03T02:00:00Z' });
const matFull = await party({ segmentId: matPub.id, showId: mat.id, name: 'Full House', email: 'full@example.test',
  seats: [extra('Full House'), extra('Plus One')], at: '2026-10-01T01:00:00Z' });

// Tickets issued for Nadia, so a rename can be checked against qr_token.
const [tpl] = await sql`insert into ticket_templates (concert_id, name, version, background_kind, page_width_pt, page_height_pt, layout, is_default)
  values (${c.id}, 'Default', 1, 'NONE', 595, 280, '{"canvas":{"width_pt":595,"height_pt":280,"dpi":300},"elements":[]}'::jsonb, true) returning id`;
await sql`update attendees a set qr_token = substr(md5(random()::text || a.id::text), 1, 22), ticket_code = upper(substr(md5(a.id::text), 1, 8)),
            ticket_template_id = ${tpl.id}, ticket_template_version = 1, ticket_issued_at = now()
           where a.registration_id = ${nadia} and a.status = 'CONFIRMED'`;

const [pair] = await sql`select id from duplicate_candidates where least(registration_a_id, registration_b_id) = ${Math.min(kenjiPub, kenjiPly)}
  and greatest(registration_a_id, registration_b_id) = ${Math.max(kenjiPub, kenjiPly)}`;

console.log(JSON.stringify({
  concert1: ids.concertId, concert: Number(c.id), eve: Number(eve.id), mat: Number(mat.id), pub: Number(pub.id), ply: Number(ply.id), matPub: Number(matPub.id),
  aisha, benjamin, chloe, dmitri, autumnForm, playerForm, waitForm, closedForm, nadia, kenjiPub, kenjiPly, matFull, pair: pair ? Number(pair.id) : null,
}));
await sql.end();
