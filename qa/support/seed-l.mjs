/**
 * QA seed for module `L` — form admin and exports.
 *
 * One concert (Asia/Singapore), one show, two segments, so both registration
 * kinds have a legal parent and each has an illegal one to be refused against:
 *   - "Player Block"  PLAYER_INVITED, capacity 20, base_quota 2, extra rows 3
 *   - "Public Block"  PUBLIC,         capacity 20, party cap 4
 *
 * Plus a third segment with **no caps set at any level**, which is the state
 * `resolveRepeaterLimits` refuses on — the screen must say which setting is
 * missing rather than rendering "add up to 0 guests" (spec/README.md §2.1).
 *
 * Every number here is invented and unlike this concert's: real figures live in
 * `docs/context.md` and are entered through the admin UI.
 */
import postgres from 'postgres';
const sql = postgres(process.env.QA_DATABASE_URL, { prepare: false, max: 1 });

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';

await sql`truncate table audit_log, check_ins, portal_notes, email_outbox, attendees, registrations,
  feedback_responses, form_responses, registration_forms, import_batches, mapping_profiles,
  player_allocations, players, operator_show_assignments, app_users, booklets, show_segments,
  shows, ticket_templates, concerts, system_settings, auth_failures restart identity cascade`;

for (const [k, v] of Object.entries({
  'auth.admin_max_attempts': 20,
  'auth.admin_lockout_window_min': 1,
  'form.rate_limit_per_ip_per_min': 60,
})) {
  await sql`insert into system_settings (key, value) values (${k}, ${JSON.stringify(v)}::text::jsonb)`;
}

const [concert] = await sql`insert into concerts (name, slug, status, season, timezone, starts_on)
  values ('QA Concert', 'qa-concert', 'ACTIVE', '2026', 'Asia/Singapore', '2026-09-19') returning id`;

const [show] = await sql`insert into shows (concert_id, name, status, venue_name, capacity, starts_at, ends_at)
  values (${concert.id}, 'Show One', 'OPEN', 'Esplanade', 60,
          '2026-09-19T11:30:00Z', '2026-09-19T13:30:00Z') returning id`;

const [playerSegment] = await sql`insert into show_segments
  (show_id, name, audience_mode, capacity, base_quota, base_claim_deadline, extras_policy, display_order)
  values (${show.id}, 'Player Block', 'PLAYER_INVITED', 20, 2, '2026-09-10T16:00:00Z', 'REVIEW', 1)
  returning id`;

const [publicSegment] = await sql`insert into show_segments
  (show_id, name, audience_mode, capacity, extras_policy, max_tickets_per_response, display_order)
  values (${show.id}, 'Public Block', 'PUBLIC', 20, 'AUTO_FCFS', 4, 2) returning id`;

/**
 * `form.extra_rows_max` has no segment column (`K` left that for `J`), so it is
 * set on the show's `defaults` bag — which is a legitimate cascade level and
 * exercises the resolution rather than short-circuiting it.
 */
await sql`update shows set defaults = ${JSON.stringify({ 'form.extra_rows_max': 3 })}::text::jsonb
          where id = ${show.id}`;

/** A show whose segment is configured with nothing: the "not configured" state. */
const [bareShow] = await sql`insert into shows (concert_id, name, status, capacity, starts_at)
  values (${concert.id}, 'Unconfigured Show', 'DRAFT', 40, '2026-09-20T11:30:00Z') returning id`;
const [bareSegment] = await sql`insert into show_segments
  (show_id, name, audience_mode, capacity, display_order)
  values (${bareShow.id}, 'Nothing Set', 'PUBLIC', null, 1) returning id`;

await sql`insert into app_users (id, email, role, is_active)
  values (${ADMIN_ID}::uuid, ${process.env.QA_ADMIN_EMAIL}, 'ADMIN', true)`;

console.log(
  JSON.stringify({
    concertId: Number(concert.id),
    showId: Number(show.id),
    playerSegmentId: Number(playerSegment.id),
    publicSegmentId: Number(publicSegment.id),
    bareShowId: Number(bareShow.id),
    bareSegmentId: Number(bareSegment.id),
  }),
);

await sql.end();
