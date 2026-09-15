/**
 * QA seed for module `N` — the portal, feedback and post-show.
 *
 * Every row exists to make one of §13.2's states, or one of this branch's three
 * easy-to-get-backwards rules, observable in a browser:
 *
 * - **three shows on one concert**: one still to come, one whose evening is over
 *   by the clock, and one with **no `ends_at` at all** — the third proves
 *   decision 41, which no amount of waiting will make flip
 * - a party of three on the finished show where **two were admitted and one was
 *   not**, so "one link per admitted attendee" is a real assertion
 * - a **reverted** admission, which must not unlock and must not be emailed
 * - a cancelled ticket and a soft-deleted one, for §13.2's last two rows
 * - a **published** booklet and an **unpublished** one, so "not until published"
 *   is visible rather than argued
 * - a concert-wide booklet and a show-specific one, to show which wins
 */
import postgres from 'postgres';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const url = process.env.QA_DATABASE_URL ?? 'postgresql://postgres@localhost:55432/zetix_qa';
const sql = postgres(url, { prepare: false, max: 1 });

await sql`truncate table audit_log, check_ins, portal_notes, feedback_responses, email_outbox,
  attendees, registrations, form_responses, registration_forms, import_batches, mapping_profiles,
  player_allocations, players, operator_show_assignments, app_users, booklets, show_segments, shows,
  ticket_templates, email_templates, concerts, system_settings, auth_failures restart identity cascade`;

const settings = {
  'auth.admin_max_attempts': 50,
  'auth.admin_lockout_window_min': 1,
  // The portal's own switches. None is seeded in production -- they are
  // operational values an admin enters (spec/README.md §2.1) -- so a QA run has
  // to set them or the portal is correctly invisible: the ticket status page
  // renders and every §13.3 section is absent, with nothing saying why.
  // `portal.enabled` in particular is the master switch; see local.md §11.2.
  'portal.enabled': true,
  'portal.unlock_mode': 'ON_ADMISSION',
  'portal.booklet_enabled': true,
  'portal.feedback_enabled': true,
  // Seeded in production by scripts/seed-settings.ts.
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
  // `::text::jsonb`, not `::jsonb`. With a bare cast postgres.js infers the
  // parameter type from the cast and JSON-encodes the string we already
  // serialised, so every value lands one level too deep -- `2` becomes the
  // jsonb *string* "2". Nothing errors, and `show.auto_complete_after_hours`
  // then fails `jsonb_typeof(...) = 'number'` in SHOW_IS_OVER, so no show is
  // ever over and the post-show portal simply never appears.
  // `scripts/seed-settings.ts` carries the same warning; this seed learned it
  // the slow way.
  await sql`insert into system_settings (key, value) values (${k}, ${JSON.stringify(v)}::text::jsonb)`;
}

await sql`
  insert into email_templates (key, name, subject, body_md)
  values ('feedback_request', 'How was your evening?', 'How was {{ show.name }}?',
          ${'Dear {{ registration.contact_name }},\n\nThank you for coming to **{{ show.name }}**.\n\n{{ feedback_links }}'})
`;

const [c] = await sql`insert into concerts
  (name, slug, status, season, timezone, starts_on, portal_enabled, practical_info_md)
  values ('QA Concert N', 'qa-n', 'ACTIVE', '2026', 'Asia/Kuala_Lumpur', '2026-09-19', true,
          ${'Parking is under the hall, entrance on Persiaran KLCC.\n\nLatecomers are seated at the interval.\n\n- Doors open 45 minutes before the concert\n- Seating is unreserved'})
  returning id`;

await sql`insert into app_users (id, email, display_name, role)
  values ('11111111-1111-4111-8111-111111111111'::uuid, 'committee@example.test', 'Committee', 'ADMIN')`;

/** `endsAt` as an SQL expression relative to now, or null. */
async function show(name, { endsHoursFromNow, status = 'OPEN' }) {
  const [s] = await sql`insert into shows
    (concert_id, name, status, venue_name, venue_address, capacity,
     starts_at, doors_open_at, ends_at, portal_unlock_mode)
    values (${c.id}, ${name}, ${status}, 'Dewan Filharmonik Petronas',
            'Tower 2, Persiaran KLCC, 50088 Kuala Lumpur', 400,
            now() - interval '4 hours', now() - interval '5 hours',
            ${endsHoursFromNow === null ? null : sql`now() + (${endsHoursFromNow}::numeric * interval '1 hour')`},
            'ON_ADMISSION')
    returning id`;
  const [seg] = await sql`insert into show_segments (show_id, name, audience_mode, capacity)
    values (${s.id}, 'SEGMENT-LEAK-CANARY', 'PUBLIC', 200) returning id`;
  return { showId: Number(s.id), segmentId: Number(seg.id) };
}

// Over by the clock: ended 3h ago, grace is 2h.
const finished = await show('Evening Concert', { endsHoursFromNow: -3 });
// Still to come.
const upcoming = await show('Matinee', { endsHoursFromNow: 6 });
// Decision 41: no end time, so no post-show phase, ever.
const noEnd = await show('Open-ended Gala', { endsHoursFromNow: null });

let codeSeq = 0;
const nextCode = () => `ORC-${String(1000 + codeSeq++)}`;

async function party(where, contactName, people, status = 'CONFIRMED') {
  const [r] = await sql`insert into registrations
    (show_id, segment_id, source, contact_name, contact_email, contact_phone, status, requested_at)
    values (${where.showId}, ${where.segmentId}, 'ADMIN', ${contactName},
            ${`${contactName.toLowerCase().replace(/\W+/g, '.')}@example.com`},
            '+60-CANARY-PHONE', ${status}, now()) returning id`;
  const made = [];
  await sql.begin(async (tx) => {
    await tx`select set_config('zetix.granting', 'on', true)`;
    for (const p of people) {
      const [a] = await tx`insert into attendees
        (registration_id, show_id, segment_id, full_name, name_source, allocation_type, status,
         ticket_code, qr_token)
        values (${r.id}, ${where.showId}, ${where.segmentId}, ${p.name}, 'PROVIDED', 'BASE',
                ${p.status ?? 'CONFIRMED'}, ${nextCode()}, ${p.token})
        returning id`;
      made.push({ id: Number(a.id), ...p });
    }
  });
  return { registrationId: Number(r.id), attendees: made };
}

const mixed = await party(finished, 'Mixed Party', [
  { name: 'Aisyah Binti Rahman', token: 'AdmittedOneAAAAAAAAA1' + 'x' },
  { name: 'Partner Canary Lim', token: 'AdmittedTwoBBBBBBBBB2' + 'x' },
  { name: 'Absent Friend', token: 'NoShowCCCCCCCCCCCCCC3' + 'x' },
]);
const reverted = await party(finished, 'Reverted Party', [
  { name: 'Reverted Guest', token: 'RevertedDDDDDDDDDDDD4' + 'x' },
]);
const cancelled = await party(finished, 'Cancelled Party', [
  { name: 'Marcus Lee', token: 'CancelledEEEEEEEEEEE5' + 'x' },
]);
const deleted = await party(finished, 'Deleted Party', [
  { name: 'Deleted Guest', token: 'DeletedFFFFFFFFFFFFF6' + 'x' },
]);
const early = await party(upcoming, 'Early Bird', [
  { name: 'Not Yet Admitted', token: 'UpcomingGGGGGGGGGGG7' + 'xx' },
]);
const openEnded = await party(noEnd, 'Open Ended', [
  { name: 'No End Time', token: 'NoEndTimeHHHHHHHHHH8' + 'xx' },
]);

/**
 * Pin a template onto every confirmed seat, as `tickets/issue.ts` does.
 *
 * **Writing a `qr_token` is not issuing a ticket.** `loadTicket()` needs the
 * *pinned* template version (§10.5), so without this the portal's "Download your
 * ticket" button 404s for everyone — which looks like a broken route rather than
 * an unfinished seed. `seed-i.mjs` got away with it because module `I` never
 * rendered a PDF; this branch does.
 */
const [template] = await sql`insert into ticket_templates
  (concert_id, name, version, background_kind, page_width_pt, page_height_pt, layout, is_default)
  values (${c.id}, 'QA N', 1, 'NONE', 595, 280,
          ${JSON.stringify({ canvas: { width_pt: 595, height_pt: 280, dpi: 300 }, elements: [] })}::text::jsonb,
          false)
  returning id`;
await sql`update attendees
     set ticket_template_id = ${Number(template.id)},
         ticket_template_version = 1,
         ticket_issued_at = now()
   where status = 'CONFIRMED' and deleted_at is null`;

const scan = (attendeeId, showId, revertedAt = null) =>
  sql`insert into check_ins (attendee_id, show_id, device_id, scanned_at, synced_at, source, reverted_at)
      values (${attendeeId}, ${showId}, 'qa-phone', now() - interval '4 hours', now(), 'ONLINE', ${revertedAt})`;

await scan(mixed.attendees[0].id, finished.showId);
await scan(mixed.attendees[1].id, finished.showId);
// Not mixed.attendees[2] -- the no-show, whose link must not be in the email.
await scan(reverted.attendees[0].id, finished.showId, new Date().toISOString());
await scan(cancelled.attendees[0].id, finished.showId);
await scan(openEnded.attendees[0].id, noEnd.showId);

await sql`update attendees set deleted_at = now() where id = ${deleted.attendees[0].id}`;
// Cancellation through the real path, so the 0001 cascade sets the seat.
await sql`update registrations set status = 'CANCELLED' where id = ${cancelled.registrationId}`;

// Two booklets: the concert-wide one is published, the show-specific one is not,
// so the portal must show the concert-wide one -- and publishing the other must
// visibly take over.
//
// **Real bytes, written to the local asset backend.** `booklets.pdf_path` is an
// opaque key into the same store ticket artwork uses, and the portal's viewer
// streams from it -- so a row pointing at nothing renders an iframe that 404s,
// which looks exactly like a broken route rather than an unseeded file.
const assetDir = process.env.TICKET_ASSET_DIR ?? '/tmp/zetix-qa-assets';
// Built with pdf-lib rather than by hand: a PDF without a cross-reference table
// is served happily by the route and rendered as a blank grey box by the
// browser's viewer, which reads as a broken booklet section rather than an
// unconvincing fixture.
async function writePdf(relPath, title) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const [i, heading] of [title, 'Programme notes', 'The orchestra'].entries()) {
    const page = doc.addPage([595, 842]);
    page.drawText(heading, { x: 60, y: 760, size: 24, font });
    page.drawText(`Page ${i + 1}`, { x: 60, y: 60, size: 10, font });
  }
  const file = join(assetDir, relPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, await doc.save());
}
await writePdf('qa/concert-programme.pdf', 'QA Concert N — Programme');
await writePdf('qa/evening.pdf', 'QA Concert N — Evening Programme');

await sql`insert into booklets (concert_id, show_id, title, pdf_path, published)
  values (${c.id}, null, 'Concert Programme', 'qa/concert-programme.pdf', true)`;
await sql`insert into booklets (concert_id, show_id, title, pdf_path, published)
  values (${c.id}, ${finished.showId}, 'Evening Programme (unpublished)', 'qa/evening.pdf', false)`;

await sql`insert into registration_forms
  (show_id, kind, slug, title, description_md, status, schema, schema_version)
  values (${finished.showId}, 'FEEDBACK', 'qa-feedback', 'Tell us how it went',
          'It takes a minute, and the orchestra reads every one.', 'OPEN',
          ${JSON.stringify({
            kind: 'FEEDBACK',
            blocks: [
              {
                id: 'feedback',
                type: 'CUSTOM',
                title: 'How was your evening?',
                fields: [
                  // Options are `{ value, label }` objects, never bare strings —
                  // the zod contract refuses the shorthand, and a FEEDBACK form
                  // whose schema does not parse is treated as no form at all,
                  // so the section simply never appears.
                  { key: 'rating', type: 'select', label: 'Overall', required: true,
                    options: [
                      { value: 'wonderful', label: 'Wonderful' },
                      { value: 'good', label: 'Good' },
                      { value: 'fine', label: 'Fine' },
                      { value: 'disappointing', label: 'Disappointing' },
                    ] },
                  { key: 'highlight', type: 'textarea', label: 'What stayed with you?', required: true },
                  { key: 'again', type: 'checkbox', label: 'I would come again' },
                ],
              },
            ],
          })}::jsonb, 1)`;

console.log(JSON.stringify({
  concertId: Number(c.id),
  shows: { finished, upcoming, noEnd },
  tokens: {
    admittedOne: mixed.attendees[0].token,
    admittedTwo: mixed.attendees[1].token,
    noShow: mixed.attendees[2].token,
    reverted: reverted.attendees[0].token,
    cancelled: cancelled.attendees[0].token,
    deleted: deleted.attendees[0].token,
    upcoming: early.attendees[0].token,
    noEndTime: openEnded.attendees[0].token,
  },
}, null, 2));

await sql.end();
