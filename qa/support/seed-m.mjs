/**
 * QA seed for module `M` — the public registration surface.
 *
 * Four forms, because the screens `M` ships are mostly *states*, and a state
 * with no fixture is a state nobody drove:
 *
 *   - `qa-public`     PUBLIC,  OPEN    — the happy path, party cap 4
 *   - `qa-player`     PLAYER,  OPEN    — token prefill, base + extras
 *   - `qa-closed`     PUBLIC,  CLOSED  — the closed state
 *   - `qa-unset`      PUBLIC,  OPEN    — on a segment configured with nothing,
 *                                        which `resolveRepeaterLimits` refuses
 *
 * Plus a **full** public segment (capacity 1, already taken) so the full state
 * is reachable, and one player with a known `invite_token`.
 *
 * Every number here is invented and unlike this concert's: the real figures
 * live in `docs/context.md` and are entered through the admin UI
 * (spec/README.md §2.1).
 */
import postgres from 'postgres';
const sql = postgres(process.env.QA_DATABASE_URL, { prepare: false, max: 1 });

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const PLAYER_TOKEN = 'qa-player-token-aaaaaaaa';

await sql`truncate table audit_log, check_ins, portal_notes, email_outbox, attendees, registrations,
  feedback_responses, form_responses, registration_forms, import_batches, mapping_profiles,
  player_allocations, players, operator_show_assignments, app_users, booklets, show_segments,
  shows, ticket_templates, concerts, system_settings, auth_failures restart identity cascade`;

for (const [k, v] of Object.entries({
  'auth.admin_max_attempts': 20,
  'auth.admin_lockout_window_min': 1,
  // High enough that driving the flows does not throttle itself. The throttle
  // has its own tests; this suite is about the screens.
  'form.rate_limit_per_ip_per_min': 600,
  'form.max_tickets_per_response': 4,
  'form.extra_rows_max': 2,
  // Below the party sizes here, so the indicator shows an exact figure and the
  // band case is reached by the nearly-full segment instead.
  'form.seat_indicator_exact_below': 5,
  'form.verification_grace_hours': 48,
})) {
  await sql`insert into system_settings (key, value) values (${k}, ${JSON.stringify(v)}::text::jsonb)`;
}

const [concert] = await sql`insert into concerts (name, slug, status, season, timezone, starts_on)
  values ('QA Concert', 'qa-concert', 'ACTIVE', '2026', 'Asia/Singapore', '2026-09-19') returning id`;

const [show] = await sql`insert into shows (concert_id, name, status, venue_name, capacity, starts_at, ends_at)
  values (${concert.id}, 'Show One', 'OPEN', 'Esplanade', 80,
          '2026-09-19T11:30:00Z', '2026-09-19T13:30:00Z') returning id`;

const [publicSegment] = await sql`insert into show_segments
  (show_id, name, audience_mode, capacity, extras_policy, allow_partial_grant, display_order)
  values (${show.id}, 'Public Block', 'PUBLIC', 30, 'AUTO_FCFS', true, 1) returning id`;

const [playerSegment] = await sql`insert into show_segments
  (show_id, name, audience_mode, capacity, base_quota, base_claim_deadline, extras_policy, display_order)
  values (${show.id}, 'Player Block', 'PLAYER_INVITED', 30, 2, '2026-09-10T16:00:00Z', 'REVIEW', 2)
  returning id`;

/**
 * Capacity 1, and it is about to be taken — the full state.
 *
 * **On its own show**, because `show_segments_show_audience_key` allows one
 * segment per audience mode per show: a second PUBLIC block beside the first is
 * a state the schema does not permit, and the seed should not pretend otherwise.
 */
const [tinyShow] = await sql`insert into shows (concert_id, name, status, capacity, starts_at)
  values (${concert.id}, 'Tiny Show', 'OPEN', 1, '2026-09-21T11:30:00Z') returning id`;
const [fullSegment] = await sql`insert into show_segments
  (show_id, name, audience_mode, capacity, extras_policy, display_order)
  values (${tinyShow.id}, 'Tiny Block', 'PUBLIC', 1, 'AUTO_FCFS', 1) returning id`;

/** A segment with nothing set at any level: the NOT_CONFIGURED refusal. */
const [bareShow] = await sql`insert into shows (concert_id, name, status, capacity, starts_at)
  values (${concert.id}, 'Unconfigured Show', 'OPEN', 40, '2026-09-20T11:30:00Z') returning id`;
const [bareSegment] = await sql`insert into show_segments
  (show_id, name, audience_mode, capacity, display_order)
  values (${bareShow.id}, 'Nothing Set', 'PUBLIC', null, 1) returning id`;
// The cap must resolve to nothing *for this segment*, so the system-level value
// above is blocked with an explicit null at the show level.
await sql`update shows set defaults = ${JSON.stringify({ 'form.max_tickets_per_response': null })}::text::jsonb
          where id = ${bareShow.id}`;

const publicSchema = {
  kind: 'PUBLIC',
  blocks: [
    {
      id: 'registrant',
      type: 'REGISTRANT',
      title: 'Your details',
      description_md: 'Your own seat is included — you do not need to add yourself below.',
      creates_seat: true,
      fields: [
        { key: 'contact_name', label: 'Full name', type: 'text', system: true, required: true },
        { key: 'contact_email', label: 'Email', type: 'email', system: true, required: true },
      ],
    },
    {
      id: 'party',
      type: 'GUESTS_PARTY',
      title: 'Who else is coming?',
      description_md: 'You may bring up to **{{max_additional_guests}}** guests.',
      add_label: 'Add a guest',
      guest_fields: [
        { key: 'full_name', label: 'Guest name', type: 'text', system: true, required: true },
      ],
    },
  ],
};

const playerSchema = {
  kind: 'PLAYER',
  blocks: [
    {
      id: 'registrant',
      type: 'REGISTRANT',
      title: 'Your details',
      creates_seat: false,
      fields: [
        { key: 'contact_name', label: 'Your name', type: 'text', system: true, required: true },
        { key: 'contact_email', label: 'Email', type: 'email', system: true, required: true },
      ],
    },
    {
      id: 'base',
      type: 'GUESTS_BASE',
      title: 'Your seats',
      description_md: 'You have **{{base_quota}}** seats.',
      add_label: 'Add a seat',
      guest_fields: [
        { key: 'full_name', label: 'Guest name', type: 'text', system: true, required: true },
      ],
    },
    {
      id: 'extras',
      type: 'GUESTS_EXTRA',
      title: 'Extra seats',
      add_label: 'Request a seat',
      guest_fields: [
        { key: 'full_name', label: 'Guest name', type: 'text', system: true, required: true },
      ],
    },
  ],
};

async function form(segmentId, kind, slug, schema, status, extra = {}) {
  const [row] = await sql`
    insert into registration_forms (
      segment_id, kind, title, slug, schema, status,
      one_response_per_identity, allow_edit_until
    ) values (
      ${segmentId}, ${kind}, ${'QA ' + kind + ' form'}, ${slug},
      ${JSON.stringify(schema)}::text::jsonb, ${status},
      ${extra.oneResponsePerIdentity ?? false},
      ${extra.allowEditUntil ?? null}
    ) returning id`;
  return Number(row.id);
}

const publicFormId = await form(publicSegment.id, 'PUBLIC', 'qa-public', publicSchema, 'OPEN', {
  allowEditUntil: '2026-12-31T00:00:00Z',
});
const playerFormId = await form(playerSegment.id, 'PLAYER', 'qa-player', playerSchema, 'OPEN');
const closedFormId = await form(publicSegment.id, 'PUBLIC', 'qa-closed', publicSchema, 'CLOSED');
const unsetFormId = await form(bareSegment.id, 'PUBLIC', 'qa-unset', publicSchema, 'OPEN');
const fullFormId = await form(fullSegment.id, 'PUBLIC', 'qa-full', publicSchema, 'OPEN');

/** Fill the tiny segment, so `qa-full` renders the full state. */
const [taken] = await sql`
  insert into registrations (show_id, segment_id, source, contact_name, contact_email, status, requested_at)
  values (${tinyShow.id}, ${fullSegment.id}, 'ADMIN', 'Already Here', 'taken@example.com', 'WAITLIST', now())
  returning id`;
await sql`select claim_seats(${fullSegment.id}::bigint, ${taken.id}::bigint,
  ${JSON.stringify([{ full_name: "Already Here", allocation_type: "EXTRA" }])}::text::jsonb, false::boolean)`;
await sql`update registrations set status = 'CONFIRMED' where id = ${taken.id}`;

const [player] = await sql`insert into players (concert_id, full_name, email, invite_token, is_active)
  values (${concert.id}, 'Vera Player', 'vera@example.com', ${PLAYER_TOKEN}, true) returning id`;
// `example.com` rather than `example.test` throughout: `.test` is a reserved TLD
// that resolves nowhere, so the submit path's address check refuses it — and a
// player's prefilled roster address hitting that warning is a fixture problem
// wearing the costume of a bug.

await sql`insert into app_users (id, email, role, is_active)
  values (${ADMIN_ID}::uuid, ${process.env.QA_ADMIN_EMAIL}, 'ADMIN', true)`;

/** The verify email needs a template to render into. */
await sql`insert into email_templates (key, name, subject, body_md) values
  ('public_verify', 'Verify your registration', 'Confirm your registration for {{ concert.name }}',
   'Hello {{ registration.contact_name }} — [Confirm]({{ verify_url }})')
  on conflict (key) do nothing`;

console.log(
  JSON.stringify({
    concertId: Number(concert.id),
    showId: Number(show.id),
    publicSegmentId: Number(publicSegment.id),
    playerSegmentId: Number(playerSegment.id),
    fullSegmentId: Number(fullSegment.id),
    bareSegmentId: Number(bareSegment.id),
    publicFormId,
    playerFormId,
    closedFormId,
    unsetFormId,
    fullFormId,
    playerId: Number(player.id),
    playerToken: PLAYER_TOKEN,
  }),
);

await sql.end();
