/**
 * Development fixture data — a concert you can click around.
 *
 * **The numbers here are invented and deliberately unlike this concert's.**
 * Real capacities, player counts and dates live in `docs/context.md` and are
 * entered through the admin UI; a seed script that carried them would put them
 * one `git grep` away from looking like defaults (spec/README.md §2.1).
 *
 *   pnpm tsx scripts/seed-dev.ts
 */
import { getSql } from '../src/db/client';
import { claimSeats, segmentPool } from '../src/db/allocation';

const HALL = 60;
const PLAYER_SEGMENT = 24;
const PUBLIC_SEGMENT = 30;
const BASE_QUOTA = 2;
const PLAYERS = 8;

async function main() {
  const sql = getSql();

  const [concert] = await sql<{ id: number }[]>`
    insert into concerts (name, slug, season, status, timezone, portal_enabled)
    values ('Dev Concert', 'dev-concert', 'Dev Season', 'ACTIVE', 'Asia/Singapore', true)
    on conflict (slug) do nothing
    returning id
  `;
  if (!concert) {
    console.log('dev concert already seeded — nothing to do');
    await sql.end();
    return;
  }

  const [show] = await sql<{ id: number }[]>`
    insert into shows (concert_id, name, status, capacity, starts_at, doors_open_at,
                       venue_name, portal_unlock_mode)
    values (${concert.id}, 'Dev Show', 'OPEN', ${HALL},
            now() + interval '30 days', now() + interval '30 days' - interval '45 minutes',
            'Dev Hall', 'ON_ADMISSION')
    returning id
  `;

  // A mixed-mode show: both audiences in one hall on one night. This is the
  // normal case, not an exception (decision 5).
  const [playerSegment] = await sql<{ id: number }[]>`
    insert into show_segments (show_id, name, audience_mode, capacity, base_quota,
                               base_claim_deadline, extras_policy, allow_partial_grant,
                               display_order)
    values (${show.id}, 'Player invited', 'PLAYER_INVITED', ${PLAYER_SEGMENT}, ${BASE_QUOTA},
            now() + interval '14 days', 'REVIEW', false, 1)
    returning id
  `;
  const [publicSegment] = await sql<{ id: number }[]>`
    insert into show_segments (show_id, name, audience_mode, capacity, extras_policy,
                               allow_partial_grant, display_order)
    values (${show.id}, 'Public', 'PUBLIC', ${PUBLIC_SEGMENT}, 'AUTO_FCFS', true, 2)
    returning id
  `;

  // HALL − (PLAYER_SEGMENT + PUBLIC_SEGMENT) seats belong to no segment. Those
  // are the held seats: there is no `held_seats` column and there does not need
  // to be one (decision 21).

  const players = await sql<{ id: number }[]>`
    insert into players (concert_id, full_name, email, instrument, invite_token, is_active)
    select ${concert.id},
           'Player ' || i,
           'player' || i || '@example.test',
           (array['Violin', 'Viola', 'Cello', 'Flute'])[1 + (i % 4)],
           'dev-invite-' || i,
           true
      from generate_series(1, ${PLAYERS}) as i
    returning id
  `;

  // Every seat below goes through claim_seats(), exactly as the app does — a
  // seed that inserted attendees directly would produce a database the engine
  // never agreed to (§7.6).
  for (const [index, player] of players.slice(0, 5).entries()) {
    const [registration] = await sql<{ id: number }[]>`
      insert into registrations (show_id, segment_id, player_id, source, contact_name,
                                 contact_email, status, requested_at, round_label)
      values (${show.id}, ${playerSegment.id}, ${player.id}, 'ADMIN',
              ${'Player ' + (index + 1)}, ${'player' + (index + 1) + '@example.test'},
              'CONFIRMED', now() - (${index} * interval '1 hour'), 'Round 1')
      returning id
    `;
    await claimSeats(playerSegment.id, registration.id, [
      { fullName: `Guest of Player ${index + 1}`, allocationType: 'BASE' },
      { fullName: null, allocationType: 'BASE' }, // unnamed: tickets as a placeholder
    ]);
  }

  for (let i = 1; i <= 6; i++) {
    const [registration] = await sql<{ id: number }[]>`
      insert into registrations (show_id, segment_id, source, contact_name, contact_email,
                                 status, requested_at, round_label)
      values (${show.id}, ${publicSegment.id}, 'IMPORT', ${'Public Party ' + i},
              ${'party' + i + '@example.test'}, 'CONFIRMED',
              now() - (${i} * interval '30 minutes'), 'Round 1')
      returning id
    `;
    await claimSeats(publicSegment.id, registration.id, [
      { fullName: `Attendee ${i}A`, allocationType: 'EXTRA' },
      { fullName: `Attendee ${i}B`, allocationType: 'EXTRA' },
    ]);
  }

  console.log('seeded dev concert');
  console.table({
    'player segment': await segmentPool(playerSegment.id),
    'public segment': await segmentPool(publicSegment.id),
  });
  await sql.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
