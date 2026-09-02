import { sql } from './db';

/**
 * Timestamps go over the wire as ISO strings, never as `Date` objects.
 *
 * Under Vitest, `postgres` fails its internal `x instanceof Date` check — the
 * driver and the test file do not share a `Date` — so a `Date` parameter falls
 * through to the string serializer and throws "The 'string' argument must be of
 * type string … Received an instance of Date". The same code is fine under
 * plain Node, which makes it an unusually confusing hour to lose.
 *
 * An ISO string is unambiguous to Postgres either way, so the fixtures simply
 * never rely on driver type inference. Application code is unaffected: Drizzle
 * serialises its own timestamp columns.
 */
const ts = (value: Date | string | null | undefined): string | null =>
  value == null ? null : typeof value === 'string' ? value : value.toISOString();

/**
 * jsonb goes over the wire as a stringified value cast with `::jsonb`, not via
 * `sql.json()` — same Vitest realm problem as `ts()` above, which surfaces as
 * "Received an instance of Array" or "Received type number".
 */
export const json = (value: unknown): string => JSON.stringify(value);

/**
 * Fixtures for the allocation tests.
 *
 * **Every number is a parameter, never a default.** These helpers deliberately
 * refuse to invent a capacity or a quota: the caller states them, exactly as an
 * admin would enter them through the UI (spec/README.md §2.1). A fixture that
 * quietly defaulted `capacity` to 400 would be the same bug as a constant in a
 * `.ts` file, just harder to find.
 */

export async function createConcert(name = 'Test Concert'): Promise<number> {
  const [row] = await sql<{ id: number }[]>`
    insert into concerts (name, slug, status, timezone)
    values (${name}, ${name.toLowerCase().replace(/\s+/g, '-')}, 'ACTIVE', 'Asia/Singapore')
    returning id
  `;
  return row.id;
}

export async function createShow(concertId: number, capacity: number | null): Promise<number> {
  const [row] = await sql<{ id: number }[]>`
    insert into shows (concert_id, name, status, capacity, starts_at)
    values (${concertId}, 'Test Show', 'OPEN', ${capacity}, now() + interval '30 days')
    returning id
  `;
  return row.id;
}

export async function createSegment(
  showId: number,
  opts: {
    audienceMode: 'PLAYER_INVITED' | 'PUBLIC';
    capacity: number | null;
    baseQuota?: number | null;
    baseClaimDeadline?: Date | null;
    extrasPolicy?: 'REVIEW' | 'AUTO_FCFS' | null;
    allowPartialGrant?: boolean | null;
    name?: string;
  },
): Promise<number> {
  const [row] = await sql<{ id: number }[]>`
    insert into show_segments (
      show_id, name, audience_mode, capacity, base_quota, base_claim_deadline,
      extras_policy, allow_partial_grant
    ) values (
      ${showId},
      ${opts.name ?? opts.audienceMode},
      ${opts.audienceMode},
      ${opts.capacity},
      ${opts.baseQuota ?? null},
      ${ts(opts.baseClaimDeadline)},
      ${opts.extrasPolicy ?? null},
      ${opts.allowPartialGrant ?? null}
    )
    returning id
  `;
  return row.id;
}

/** N active players on one concert. Players are concert-scoped, not segment-scoped. */
export async function createPlayers(concertId: number, count: number): Promise<number[]> {
  const ids: number[] = [];
  // Continue from however many already exist: players are unique on
  // (concert_id, email), and a test that tops up a roster must not collide with
  // the players it already created.
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from players where concert_id = ${concertId}
  `;
  for (let i = n; i < n + count; i++) {
    const [row] = await sql<{ id: number }[]>`
      insert into players (concert_id, full_name, email, invite_token, is_active)
      values (
        ${concertId}, ${`Player ${i + 1}`}, ${`player${i + 1}@example.test`},
        ${`tok-${concertId}-${i + 1}`}, true
      )
      returning id
    `;
    ids.push(row.id);
  }
  return ids;
}

export async function createRegistration(opts: {
  showId: number;
  segmentId: number;
  playerId?: number | null;
  contactName?: string;
  requestedAt?: Date;
  status?: 'CONFIRMED' | 'PENDING_REVIEW' | 'WAITLIST' | 'CANCELLED';
}): Promise<number> {
  const [row] = await sql<{ id: number }[]>`
    insert into registrations (
      show_id, segment_id, player_id, source, contact_name, contact_email,
      status, requested_at
    ) values (
      ${opts.showId}, ${opts.segmentId}, ${opts.playerId ?? null}, 'ADMIN',
      ${opts.contactName ?? 'Test Registrant'}, ${'reg@example.test'},
      ${opts.status ?? 'CONFIRMED'}, ${ts(opts.requestedAt ?? new Date())}
    )
    returning id
  `;
  return row.id;
}

/**
 * Writes attendees directly, bypassing `claim_seats()`.
 *
 * Only for arranging a *starting state* a test then measures — never for
 * asserting that granting works. Production has no such path: every grant,
 * including a manual admin one, routes through `claim_seats()`
 * (spec/allocation.md §7.6).
 */
export async function seedAttendees(opts: {
  registrationId: number;
  showId: number;
  segmentId: number;
  count: number;
  allocationType: 'BASE' | 'EXTRA' | 'HELD' | 'COMP';
  status?: 'CONFIRMED' | 'PENDING_REVIEW' | 'WAITLIST' | 'CANCELLED';
}): Promise<void> {
  for (let i = 0; i < opts.count; i++) {
    await sql`
      insert into attendees (
        registration_id, show_id, segment_id, full_name, name_source,
        allocation_type, status
      ) values (
        ${opts.registrationId}, ${opts.showId}, ${opts.segmentId},
        ${`Guest ${i + 1}`}, 'PROVIDED', ${opts.allocationType},
        ${opts.status ?? 'CONFIRMED'}
      )
    `;
  }
}

export async function setSystemSetting(key: string, value: unknown): Promise<void> {
  await sql`
    insert into system_settings (key, value) values (${key}, ${json(value)}::jsonb)
    on conflict (key) do update set value = excluded.value
  `;
}
