/**
 * QA seed for module `O` — notes, wall and digest.
 *
 * The shape that matters: **one show carrying both audiences**, because §13.4's
 * addressing rule derives from the segment and a show with one segment cannot
 * show the rule working. Everything else exists to make a §13.4 / §14.2
 * sentence observable in a browser.
 */
import postgres from 'postgres';

const url = process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa';
const sql = postgres(url, { prepare: false, max: 1 });

await sql`truncate table audit_log, check_ins, portal_notes, feedback_responses, email_outbox,
  attendees, registrations, form_responses, registration_forms, import_batches, mapping_profiles,
  player_allocations, players, operator_show_assignments, app_users, booklets, show_segments, shows,
  ticket_templates, email_templates, concerts, system_settings, auth_failures restart identity cascade`;

const settings = {
  'auth.admin_max_attempts': 50,
  'auth.admin_lockout_window_min': 1,
  'portal.enabled': true,
  'portal.unlock_mode': 'ON_ADMISSION',
  'portal.notes_enabled': true,
  'portal.note_max_length': 120,
  'portal.public_wall_enabled': true,
  'portal.public_wall_visibility': 'AUDIENCE',
  'portal.booklet_enabled': false,
  'portal.feedback_enabled': false,
  'show.auto_complete_after_hours': 2,
  'portal.feedback_send_hour': 12,
  'email.transport': 'gmail_smtp',
  'email.max_per_dispatch': 20,
  'email.max_per_day': 450,
  'email.inter_message_delay_ms': 0,
  'email.max_attempts': 3,
  'email.merge_attachments_above': 8,
  'email.max_attachment_mb': 20,
};
for (const [k, v] of Object.entries(settings)) {
  await sql`insert into system_settings (key, value) values (${k}, ${JSON.stringify(v)}::text::jsonb)`;
}

await sql`
  insert into email_templates (key, name, subject, body_md)
  values ('player_notes_digest', 'Notes from the audience', 'Notes for you from {{ concert.name }}',
          ${'Dear {{ player.name }},\n\nMembers of the audience left these notes for you after **{{ concert.name }}**.\n\n{{ notes_list }}\n\nThank you for playing.'})
`;

const [c] = await sql`insert into concerts
  (name, slug, status, season, timezone, starts_on, portal_enabled)
  values ('QA Concert O', 'qa-o', 'ACTIVE', '2026', 'Asia/Kuala_Lumpur', '2026-09-19', true)
  returning id`;
const concertId = Number(c.id);

await sql`insert into app_users (id, email, display_name, role)
  values ('11111111-1111-4111-8111-111111111111'::uuid, 'committee@example.test', 'Committee', 'ADMIN')`;
await sql`insert into app_users (id, email, display_name, role)
  values ('22222222-2222-4222-8222-222222222222'::uuid, 'usher@operators.invalid', 'Usher', 'OPERATOR')`;

/** One show, two segments — the whole point of this seed. */
const [s] = await sql`insert into shows
  (concert_id, name, status, venue_name, venue_address, capacity,
   starts_at, doors_open_at, ends_at, portal_unlock_mode)
  values (${concertId}, 'Evening Concert', 'OPEN', 'Dewan Filharmonik Petronas',
          'Tower 2, Persiaran KLCC, 50088 Kuala Lumpur', 400,
          now() - interval '4 hours', now() - interval '5 hours',
          now() - interval '3 hours', 'ON_ADMISSION')
  returning id`;
const showId = Number(s.id);

await sql`insert into operator_show_assignments (user_id, show_id, assigned_by)
  values ('22222222-2222-4222-8222-222222222222'::uuid, ${showId},
          '11111111-1111-4111-8111-111111111111'::uuid)`;

const [segPlayer] = await sql`insert into show_segments (show_id, name, audience_mode, capacity)
  values (${showId}, 'Player invited', 'PLAYER_INVITED', 200) returning id`;
const [segPublic] = await sql`insert into show_segments (show_id, name, audience_mode, capacity)
  values (${showId}, 'Public block', 'PUBLIC', 200) returning id`;
const playerSegmentId = Number(segPlayer.id);
const publicSegmentId = Number(segPublic.id);

/** A second concert, so "another concert's player" is a real id. */
const [other] = await sql`insert into concerts (name, slug, status, season, timezone, starts_on)
  values ('QA Concert Elsewhere', 'qa-o-other', 'ACTIVE', '2026', 'Asia/Kuala_Lumpur', '2026-11-01')
  returning id`;
const [stranger] = await sql`insert into players (concert_id, full_name, email, instrument, invite_token)
  values (${Number(other.id)}, 'Stranger From Elsewhere', 'stranger@example.test', 'Tuba', 'tok-stranger')
  returning id`;

async function player(name, email, instrument, section, active = true) {
  const [p] = await sql`insert into players
    (concert_id, full_name, email, instrument, section, invite_token, is_active)
    values (${concertId}, ${name}, ${email}, ${instrument}, ${section},
            ${`tok-${name.toLowerCase().replace(/\W+/g, '-')}`}, ${active})
    returning id`;
  return Number(p.id);
}

const ada = await player('Ada Lim', 'ada@example.test', 'Violin', 'Strings');
const ben = await player('Ben Ong', 'ben@example.test', 'Cello', 'Strings');
const chandra = await player('Chandra Devi', null, 'Flute', 'Woodwind'); // no email
const devi = await player('Dev Patel', 'dev@example.test', 'Horn', 'Brass'); // no notes
const retired = await player('Retired Rita', 'rita@example.test', 'Oboe', 'Woodwind', false);

let codeSeq = 0;
const nextCode = () => `ORC-${String(2000 + codeSeq++)}`;

async function party(segmentId, contactName, people, { playerId = null, status = 'CONFIRMED' } = {}) {
  const [r] = await sql`insert into registrations
    (show_id, segment_id, source, player_id, contact_name, contact_email, status, requested_at)
    values (${showId}, ${segmentId}, 'ADMIN', ${playerId}, ${contactName},
            ${`${contactName.toLowerCase().replace(/\W+/g, '.')}@example.com`}, ${status}, now())
    returning id`;
  const made = [];
  await sql.begin(async (tx) => {
    await tx`select set_config('zetix.granting', 'on', true)`;
    for (const p of people) {
      const [a] = await tx`insert into attendees
        (registration_id, show_id, segment_id, full_name, name_source, allocation_type, status,
         ticket_code, qr_token)
        values (${r.id}, ${showId}, ${segmentId}, ${p.name}, 'PROVIDED', 'BASE',
                ${p.status ?? 'CONFIRMED'}, ${nextCode()}, ${p.token})
        returning id`;
      made.push({ id: Number(a.id), ...p });
    }
  });
  return { registrationId: Number(r.id), attendees: made };
}

// Ada's guest — PLAYER_INVITED, so Ada must be prefilled.
const adaGuest = await party(playerSegmentId, 'Ada Guest', [
  { name: 'Guest Of Ada', token: 'PlayerInvitedAAAAAAA1x' },
], { playerId: ada });

// A public ticket holder in the SAME show — no player prefilled.
const publicGuest = await party(publicSegmentId, 'Public Guest', [
  { name: 'Siti Nurhaliza', token: 'PublicGuestBBBBBBBBB2x' },
]);

// Public, issued but never scanned — §13.2's pre-admission row.
const notAdmitted = await party(publicSegmentId, 'Not Admitted', [
  { name: 'Absent Friend', token: 'NotAdmittedCCCCCCCCC3x' },
]);

// Cancelled, and soft-deleted, for the §13.2 sad rows.
const cancelled = await party(publicSegmentId, 'Cancelled Party', [
  { name: 'Marcus Lee', token: 'CancelledDDDDDDDDDDD4x' },
]);
const deleted = await party(publicSegmentId, 'Deleted Party', [
  { name: 'Deleted Guest', token: 'DeletedEEEEEEEEEEEEE5x' },
]);

// Four more admitted public guests, so the wall and the digest have content
// without every note belonging to a guest a flow is also driving.
const chorus = await party(publicSegmentId, 'Chorus Of Writers', [
  { name: 'Writer One', token: 'WriterOneFFFFFFFFFF6xx' },
  { name: 'Writer Two', token: 'WriterTwoGGGGGGGGGG7xx' },
  { name: 'Writer Three', token: 'WriterThreeHHHHHHH8xxx' },
  { name: 'LOH KAI XIN', token: 'WriterFourIIIIIIII9xxx' },
  { name: 'Writer Five', token: 'WriterFiveJJJJJJJ10xxx' },
]);

const [template] = await sql`insert into ticket_templates
  (concert_id, name, version, background_kind, page_width_pt, page_height_pt, layout, is_default)
  values (${concertId}, 'QA O', 1, 'NONE', 595, 280,
          ${JSON.stringify({ canvas: { width_pt: 595, height_pt: 280, dpi: 300 }, elements: [] })}::text::jsonb,
          false)
  returning id`;
await sql`update attendees
     set ticket_template_id = ${Number(template.id)}, ticket_template_version = 1,
         ticket_issued_at = now()
   where status = 'CONFIRMED' and deleted_at is null`;

const scan = (attendeeId) =>
  sql`insert into check_ins (attendee_id, show_id, device_id, scanned_at, synced_at, source)
      values (${attendeeId}, ${showId}, 'qa-phone', now() - interval '4 hours', now(), 'ONLINE')`;

await scan(adaGuest.attendees[0].id);
await scan(publicGuest.attendees[0].id);
await scan(cancelled.attendees[0].id);
for (const a of chorus.attendees) await scan(a.id);
// notAdmitted is deliberately never scanned.

await sql`update attendees set deleted_at = now() where id = ${deleted.attendees[0].id}`;
await sql`update registrations set status = 'CANCELLED' where id = ${cancelled.registrationId}`;

/** Pre-existing notes, so triage has something to triage. */
async function note(attendeeId, body, opts = {}) {
  const [n] = await sql`insert into portal_notes
    (concert_id, show_id, attendee_id, to_player_id, display_name, is_anonymous, body,
     moderation_status, wall_status)
    values (${concertId}, ${showId}, ${attendeeId}, ${opts.toPlayerId ?? null},
            ${opts.displayName ?? 'A Guest'}, ${opts.isAnonymous ?? false}, ${body},
            ${opts.moderation ?? 'PENDING'}, ${opts.wall ?? 'NOT_PUBLISHED'})
    returning id`;
  return Number(n.id);
}

const notes = {
  // For the orchestra, approved and already on the wall.
  onWall: await note(chorus.attendees[0].id, 'The Sibelius was extraordinary tonight.', {
    displayName: 'Writer One', moderation: 'APPROVED', wall: 'PUBLISHED',
  }),
  // For the orchestra, approved, anonymous, already on the wall.
  anonOnWall: await note(chorus.attendees[1].id, 'I cried during the second movement.', {
    displayName: 'Writer Two', isAnonymous: true, moderation: 'APPROVED', wall: 'PUBLISHED',
  }),
  // Approved but NOT published — the wall must not show it.
  approvedOnly: await note(chorus.attendees[2].id, 'Approved but nobody published me.', {
    displayName: 'Writer Three', moderation: 'APPROVED',
  }),
  // Written to Ada, approved — digest material, never wall material.
  forAda: await note(chorus.attendees[3].id, 'Ada, your solo was the evening.', {
    displayName: 'LOH KAI XIN', toPlayerId: ada, moderation: 'APPROVED',
  }),
  // Written to Ben, still PENDING — must not reach a digest.
  forBenPending: await note(chorus.attendees[4].id, 'Ben, unreviewed words.', {
    displayName: 'Writer Five', toPlayerId: ben,
  }),
  // Written to Chandra, approved — she has no email, so the digest must skip her.
  forChandra: await note(publicGuest.attendees[0].id, 'Chandra, the flute solo!', {
    displayName: 'Siti Nurhaliza', toPlayerId: chandra, moderation: 'APPROVED',
  }),
};

console.log(JSON.stringify({
  concertId, showId, playerSegmentId, publicSegmentId,
  otherConcertId: Number(other.id), strangerPlayerId: Number(stranger.id),
  players: { ada, ben, chandra, devi, retired },
  notes,
  tokens: {
    playerInvited: adaGuest.attendees[0].token,
    publicAdmitted: publicGuest.attendees[0].token,
    notAdmitted: notAdmitted.attendees[0].token,
    cancelled: cancelled.attendees[0].token,
    deleted: deleted.attendees[0].token,
    writers: chorus.attendees.map((a) => a.token),
  },
}, null, 2));

await sql.end();
