import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import type { PickerPlayer } from './player-picker';

/**
 * Who is filling this form in, resolved from the URL (spec/v2.md §8.1).
 *
 * A player arrives at `/f/{slug}?k={token}` and the token *is* the credential —
 * no password, no account (`ref.md` §7). Everyone else arrives at `/f/{slug}`
 * with nothing, and on a public form that is correct: identity is self-declared
 * and verified afterwards by the link in §8.1.4.
 *
 * **The token is scoped to the concert, not just looked up.** A player of
 * concert A holding a valid token must not resolve on concert B's form: their
 * quota, their segment and their seats all belong to the other event, and the
 * prefill would silently attach a stranger to this one. The join below is what
 * makes that impossible, and it is why this takes a `concertId` rather than
 * just a token.
 */

export type Registrant =
  /** A public form, or a player form reached with no token at all. */
  | { kind: 'ANONYMOUS' }
  /**
   * A token that resolved to an active player of *this* concert.
   *
   * `baseAlreadyClaimed` is what the base repeater must be sized from — see
   * {@link resolveRegistrant}.
   */
  | {
      kind: 'PLAYER';
      playerId: number;
      fullName: string;
      email: string | null;
      baseAlreadyClaimed: number;
    }
  /**
   * A token was supplied and did not resolve — wrong concert, deactivated
   * player, or simply not a token.
   *
   * **One state for all three reasons**, following the ticket page's rule
   * (§13.2) and `loadFormBySlug`'s: telling someone which part of their guess
   * was right is one bit more than telling them nothing, and the token is
   * unguessable precisely so that guessing is the only attack available.
   */
  | { kind: 'UNKNOWN_TOKEN' };

/**
 * The shape a token may be, checked before it reaches the database.
 *
 * Same reasoning as `load.ts`'s slug guard: a query parameter is untrusted
 * input, and without this a `%00` travels into a parameterised query and
 * Postgres raises `22021` — a 500 with an empty body, on a public route, for
 * something that is simply not a token.
 *
 * **The guard is about characters, not length.** It carries no minimum: a short
 * token is not a security problem because it simply matches no row, and a floor
 * here would be this module inventing a policy about how
 * `players.invite_token` is minted — which belongs to whatever mints it, and
 * which the test fixtures reasonably ignore.
 */
const TOKEN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Resolve `?k={token}` against this concert's players.
 *
 * **`baseAlreadyClaimed` is counted with the engine's own query, not §7.2's
 * prose.** The two differ: `claim_seats()` also excludes seats whose
 * registration is `CANCELLED` or soft-deleted
 * (`drizzle/0001_allocation_engine.sql`), which the definition in
 * `allocation.md` §7.2 does not spell out.
 *
 * In ordinary operation those two clauses decide nothing, because
 * `registrations_cancel_cascade` carries both states down to the attendees and
 * the `a.` filters already exclude the rows. They earn their place in the one
 * state §7.8 names directly — *"a cancel committing mid-claim leaves
 * `CONFIRMED` seats under a dead registration"* — where the seats look live and
 * the engine does not believe in them. Sizing the base repeater against seats
 * the engine will not grant is the failure, so this matches the engine clause
 * for clause rather than matching the prose.
 *
 * This is the number `resolveRepeaterLimits` needs for `GUESTS_BASE`, which
 * `K` cannot count for itself: it may not touch allocation, so it defaults to
 * zero, and zero is right for a form nobody has filled in and wrong for a
 * player coming back for round 2 (§8.1.1).
 */
export async function resolveRegistrant(
  token: string | null | undefined,
  concertId: number,
  segmentId: number | null,
): Promise<Registrant> {
  if (token == null || token === '') return { kind: 'ANONYMOUS' };
  if (!TOKEN.test(token)) return { kind: 'UNKNOWN_TOKEN' };

  const rows = await getDb().execute<{
    id: string;
    full_name: string;
    email: string | null;
    base_claimed: number;
  }>(sql`
    select
      p.id,
      p.full_name,
      p.email,
      /**
       * Mirrors claim_seats()'s own count exactly. Null segment — a FEEDBACK
       * form — has no base allocation to count, and the correlated subquery
       * simply returns zero rather than needing a second code path.
       */
      coalesce((
        select count(*)::int
          from attendees a
          join registrations r on r.id = a.registration_id
         where a.segment_id = ${segmentId}::bigint
           and r.player_id = p.id
           and a.allocation_type = 'BASE'
           and a.status = 'CONFIRMED'
           and a.deleted_at is null
           and r.deleted_at is null
           and r.status <> 'CANCELLED'
      ), 0) as base_claimed
    from players p
    where p.invite_token = ${token}
      and p.concert_id = ${concertId}::bigint
      -- A deactivated player has no base entitlement (§7.4), so their token
      -- resolving would offer rows the engine would refuse.
      and p.is_active
    limit 1
  `);

  const row = rows[0];
  if (!row) return { kind: 'UNKNOWN_TOKEN' };

  return {
    kind: 'PLAYER',
    playerId: Number(row.id),
    fullName: row.full_name,
    email: row.email,
    // `postgres.js` returns bigint as text; count(*)::int is a number, but the
    // cast is free and the same trap already bit `L` on `coalesce(show_id)`.
    baseAlreadyClaimed: Number(row.base_claimed),
  };
}

/**
 * The player form's picker (spec/v3.md §25.2): the active roster, each with
 * the base seats they have left in this segment.
 *
 * **The picker is the registrant's claim, not proof** — which is why every
 * party passes the review gate (§25.4) and why duplicate detection looks
 * across players (§25.5). So it shows names only: no address, no token.
 *
 * `remaining` counts as `claim_seats()` does — the player's own quota
 * override, else the segment's `allocation.base_quota`, less the confirmed
 * base seats of their live parties — and is null where no quota resolves,
 * which the engine reads as "owed nothing".
 */
export type RosterEntry = PickerPlayer;

export async function rosterForPicker(concertId: number, segmentId: number): Promise<RosterEntry[]> {
  const rows = await getDb().execute<{ id: string; full_name: string; quota: number | null; claimed: number }>(sql`
    select p.id, p.full_name,
           coalesce(pa.base_quota_override,
                    (resolve_setting('allocation.base_quota', ${segmentId}::bigint) #>> '{}')::int) as quota,
           (select count(*)::int
              from attendees a
              join registrations r on r.id = a.registration_id
             where a.segment_id = ${segmentId}::bigint
               and r.player_id = p.id
               and a.allocation_type = 'BASE'
               and a.status = 'CONFIRMED'
               and a.deleted_at is null
               and r.deleted_at is null
               and r.status <> 'CANCELLED') as claimed
      from players p
      left join player_allocations pa on pa.player_id = p.id and pa.segment_id = ${segmentId}::bigint
     where p.concert_id = ${concertId}::bigint
       and p.is_active
       and p.deleted_at is null
     order by p.full_name, p.id
  `);
  return rows.map((row) => ({
    id: Number(row.id),
    name: row.full_name,
    remaining: row.quota === null ? null : Math.max(0, Number(row.quota) - Number(row.claimed)),
  }));
}

/**
 * A player picked on the form, resolved as a token would be — scoped to this
 * concert, active, not deleted. Anything else is `UNKNOWN_TOKEN`: the picker
 * only ever offers valid ids, so a miss is a stale page or a crafted request.
 */
export async function resolvePickedPlayer(
  playerId: number,
  concertId: number,
  segmentId: number | null,
): Promise<Registrant> {
  if (!Number.isSafeInteger(playerId) || playerId <= 0) return { kind: 'UNKNOWN_TOKEN' };
  const [row] = await getDb().execute<{ id: string; full_name: string; email: string | null; base_claimed: number }>(sql`
    select p.id, p.full_name, p.email,
           coalesce((
             select count(*)::int
               from attendees a
               join registrations r on r.id = a.registration_id
              where a.segment_id = ${segmentId}::bigint
                and r.player_id = p.id
                and a.allocation_type = 'BASE'
                and a.status = 'CONFIRMED'
                and a.deleted_at is null
                and r.deleted_at is null
                and r.status <> 'CANCELLED'
           ), 0) as base_claimed
      from players p
     where p.id = ${playerId}::bigint
       and p.concert_id = ${concertId}::bigint
       and p.is_active
       and p.deleted_at is null
  `);
  if (!row) return { kind: 'UNKNOWN_TOKEN' };
  return {
    kind: 'PLAYER',
    playerId: Number(row.id),
    fullName: row.full_name,
    // The roster address is the player's, not the registrant's: a guest who
    // picks a player must not have that player's email filled in for them.
    email: null,
    baseAlreadyClaimed: Number(row.base_claimed),
  };
}
