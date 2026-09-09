/**
 * QA seed for module `F`'s browser pass.
 *
 * Two rounds on one segment, so §11.4's split has something to be right about:
 * round 1 has three parties (one already delivered by hand), round 2 has one
 * new party. A second segment exists so the screen's segment switch is real.
 *
 * The concert is `Asia/Kuala_Lumpur` and the show starts at 12:00Z = 20:00
 * local, so a timestamp rendered in the viewer's zone would be visibly wrong.
 */
import postgres from 'postgres';

const url = process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa';
const sql = postgres(url, { prepare: false, max: 1 });

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const OP1_ID = '22222222-2222-4222-8222-222222222222';
const OP2_ID = '33333333-3333-4333-8333-333333333333';

await sql`truncate table audit_log, check_ins, portal_notes, email_outbox, email_templates,
  attendees, registrations, form_responses, registration_forms, import_batches, mapping_profiles,
  player_allocations, players, operator_show_assignments, app_users, booklets, show_segments,
  shows, ticket_templates, concerts, system_settings, auth_failures restart identity cascade`;

for (const [k, v] of Object.entries({
  'auth.admin_max_attempts': 50,
  'auth.admin_lockout_window_min': 1,
  'email.transport': 'gmail_smtp',
  'email.max_per_dispatch': 25,
  'email.max_per_day': 450,
  'email.inter_message_delay_ms': 0,
  'email.max_attempts': 3,
  'email.merge_attachments_above': 8,
  'email.max_attachment_mb': 20,
})) {
  await sql`insert into system_settings (key, value) values (${k}, ${JSON.stringify(v)}::text::jsonb)`;
}

const [c] = await sql`insert into concerts (name, slug, status, season, timezone, starts_on)
  values ('QA Concert F', 'qa-f', 'ACTIVE', '2026', 'Asia/Kuala_Lumpur', '2026-09-19') returning id`;

const [s1] = await sql`insert into shows
  (concert_id, name, status, venue_name, venue_address, capacity, starts_at, doors_open_at)
  values (${c.id}, 'Evening Show', 'OPEN', 'Dewan Filharmonik', '1 Jalan Ampang', 400,
          '2026-09-19T12:00:00Z', '2026-09-19T11:00:00Z') returning id`;

const [segPublic] = await sql`insert into show_segments
  (show_id, name, audience_mode, capacity, display_order)
  values (${s1.id}, 'Public', 'PUBLIC', 300, 1) returning id`;
const [segPlayer] = await sql`insert into show_segments
  (show_id, name, audience_mode, capacity, display_order)
  values (${s1.id}, 'Player invited', 'PLAYER_INVITED', 100, 2) returning id`;

await sql`insert into app_users (id, email, display_name, role) values
  (${ADMIN_ID}::uuid, ${process.env.QA_ADMIN_EMAIL ?? 'committee@example.test'}, 'Committee', 'ADMIN'),
  (${OP1_ID}::uuid, 'wei-ling@operators.invalid', 'Wei Ling', 'OPERATOR'),
  (${OP2_ID}::uuid, 'no-shows@operators.invalid', 'No Shows', 'OPERATOR')`;
await sql`insert into operator_show_assignments (user_id, show_id) values (${OP1_ID}::uuid, ${s1.id})`;

async function party(segmentId, roundLabel, contactName, email, names) {
  const [r] = await sql`insert into registrations
    (show_id, segment_id, source, round_label, contact_name, contact_email, status, requested_at)
    values (${s1.id}, ${segmentId}, 'ADMIN', ${roundLabel}, ${contactName}, ${email},
            'CONFIRMED', now()) returning id`;
  const ids = [];
  await sql.begin(async (tx) => {
    await tx`select set_config('zetix.granting', 'on', true)`;
    for (const name of names) {
      const [a] = await tx`insert into attendees
        (registration_id, show_id, segment_id, full_name, name_source, allocation_type, status)
        values (${r.id}, ${s1.id}, ${segmentId}, ${name.text},
                ${name.source ?? 'PROVIDED'}, 'BASE', 'CONFIRMED') returning id`;
      ids.push(Number(a.id));
    }
  });
  return { registrationId: Number(r.id), attendeeIds: ids, email, contactName };
}

const n = (text, source) => ({ text, source });

const p1 = await party(segPublic.id, 'Round 1', 'Alice Tan', 'alice@example.test', [
  n('Alice Tan'),
  n('Guest of Alice Tan', 'PLACEHOLDER'),
]);
const p2 = await party(segPublic.id, 'Round 1', 'Bob Lim', 'bob@example.test', [n('Bob Lim')]);
const p3 = await party(segPublic.id, 'Round 1', 'Chandra Rao', 'chandra@example.test', [
  n('Chandra Rao'),
  n('Devi Rao'),
  n('Esha Rao'),
]);
const p4 = await party(segPublic.id, 'Round 2', 'Farid Hassan', 'farid@example.test', [
  n('Farid Hassan'),
]);

console.log(
  JSON.stringify({
    concertId: Number(c.id),
    showId: Number(s1.id),
    segmentPublic: Number(segPublic.id),
    segmentPlayer: Number(segPlayer.id),
    parties: { p1, p2, p3, p4 },
    ADMIN_ID,
    OP1_ID,
    OP2_ID,
  }),
);
await sql.end();
