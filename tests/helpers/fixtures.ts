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
/**
 * ids come back from `postgres.js` as **strings**, because a Postgres `bigint`
 * does not fit a JS number in general. Ours always will at this scale, so every
 * helper coerces on the way out and the declared `Promise<number>` is true —
 * rather than every caller having to remember that `id === 3` is false.
 */
const ts = (value: Date | string | null | undefined): string | null =>
  value == null ? null : typeof value === 'string' ? value : value.toISOString();

/**
 * jsonb goes over the wire as a stringified value cast with `::text::jsonb`,
 * not via `sql.json()` — same Vitest realm problem as `ts()` above, which
 * surfaces as "Received an instance of Array" or "Received type number".
 *
 * The cast goes through `text` deliberately, matching `scripts/seed-settings.ts`.
 * A bare `::jsonb` makes `postgres.js` JSON-encode the already-serialised string
 * and store it one level too deep. Under Vitest that happens to come out right,
 * which is precisely the trap: a fixture that writes correctly while the
 * shipping script writes a double-encoded blob tests nothing about production.
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
  return Number(row.id);
}

export async function createShow(concertId: number, capacity: number | null): Promise<number> {
  const [row] = await sql<{ id: number }[]>`
    insert into shows (concert_id, name, status, capacity, starts_at)
    values (${concertId}, 'Test Show', 'OPEN', ${capacity}, now() + interval '30 days')
    returning id
  `;
  return Number(row.id);
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
  return Number(row.id);
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
    ids.push(Number(row.id));
  }
  return ids;
}

/**
 * A strictly increasing default `requested_at`.
 *
 * Written when `registrations_no_duplicate_import` was unique on
 * `(segment_id, contact_email, requested_at)` and this helper's one constant
 * email could collide within a millisecond. V3 dropped that index
 * (spec/v3.md §30.1); monotonic is kept because it matches what the column
 * means: `requested_at` is the FCFS ordering key (spec/allocation.md §7.4), so
 * parties created in order should sort in order.
 */
let lastRequestedAt = 0;
function nextRequestedAt(): string {
  lastRequestedAt = Math.max(Date.now(), lastRequestedAt + 1);
  return new Date(lastRequestedAt).toISOString();
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
      ${opts.status ?? 'CONFIRMED'}, ${ts(opts.requestedAt) ?? nextRequestedAt()}
    )
    returning id
  `;
  return Number(row.id);
}

/**
 * Writes attendees directly, bypassing `claim_seats()`.
 *
 * Only for arranging a *starting state* a test then measures — never for
 * asserting that granting works. Production has no such path: every grant,
 * including a manual admin one, routes through `claim_seats()`
 * (spec/allocation.md §7.6).
 *
 * The database enforces that, so this has to opt out explicitly per
 * transaction. The opt-out is deliberately noisy: if you find yourself reaching
 * for it outside a fixture, the thing you want is `claimSeats()`.
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
    await sql.begin(async (tx) => {
      await tx`select set_config('zetix.granting', 'on', true)`;
      await tx`
      insert into attendees (
        registration_id, show_id, segment_id, full_name, name_source,
        allocation_type, status
      ) values (
        ${opts.registrationId}, ${opts.showId}, ${opts.segmentId},
        ${`Guest ${i + 1}`}, 'PROVIDED', ${opts.allocationType},
        ${opts.status ?? 'CONFIRMED'}
      )
    `;
    });
  }
}

/**
 * Runs `fn` in a transaction that is allowed to write `attendees` directly.
 *
 * The database refuses direct inserts so that every grant goes through
 * `claim_seats()` and the §7.2 counters stay true (spec/allocation.md §7.6).
 * Tests that arrange a starting state, or that probe a constraint the trigger
 * would otherwise mask, opt out here — visibly, one transaction at a time.
 */
export function withDirectAttendeeWrites<T>(
  fn: (tx: typeof sql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select set_config('zetix.granting', 'on', true)`;
    return fn(tx as unknown as typeof sql);
  }) as Promise<T>;
}

/**
 * Mints a token and pins a template on every confirmed seat of a show, the way
 * `tickets/issue.ts` does.
 *
 * Fixtures need this because a ticket-bearing blast refuses a party that still
 * has a seat to issue (spec/email.md §11.4). A suite that seeds attendees and
 * never issues them is arranging a state the blast now declines, so the thing
 * it means to test — idempotency, editing, confirming — never gets to run.
 *
 * The token only has to be unique and the right shape, `[0-9A-Za-z]{22}`: md5
 * is hex, so 22 characters of it qualify.
 */
export async function issueTickets(concertId: number, showId: number): Promise<void> {
  const [template] = await sql<{ id: string }[]>`
    insert into ticket_templates (
      concert_id, name, version, background_kind,
      page_width_pt, page_height_pt, layout, is_default
    ) values (
      ${concertId}, 'Fixture', 1, 'NONE', 595, 280,
      ${json({ canvas: { width_pt: 595, height_pt: 280, dpi: 300 }, elements: [] })}::text::jsonb,
      false
    )
    -- Callable more than once per concert: returns the template already made
    -- rather than colliding on (concert_id, name, version).
    on conflict (concert_id, name, version) do update set version = excluded.version
    returning id
  `;
  await sql`
    update attendees a
       set qr_token = coalesce(a.qr_token, substr(md5(random()::text || a.id::text), 1, 22)),
           ticket_template_id = ${Number(template.id)},
           ticket_template_version = 1,
           ticket_issued_at = coalesce(a.ticket_issued_at, now())
     where a.show_id = ${showId}
       and a.status = 'CONFIRMED'
       and a.deleted_at is null
  `;
}

export async function setSystemSetting(key: string, value: unknown): Promise<void> {
  await sql`
    insert into system_settings (key, value) values (${key}, ${json(value)}::text::jsonb)
    on conflict (key) do update set value = excluded.value
  `;
}
