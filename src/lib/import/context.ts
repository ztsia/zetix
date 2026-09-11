import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { rethrowDbError } from '@/db/errors';
import { segmentPool } from '@/db/allocation';
import { resolveSetting } from '@/db/settings';
import type { PlanContext, PlayerMatch, SheetRow } from './plan';
import type { MappingProfile } from './profile';

/**
 * Everything the planner needs from the database, gathered before it runs
 * (spec/import.md §9.4, §9.5).
 *
 * The planner is pure so the dry run and the commit cannot disagree; this is the
 * one place that reads state, and it reads it once per run. Every operational
 * number here comes through `resolveSetting` — never a column and never a
 * literal (spec/README.md §2.2).
 */

export type SegmentTarget = {
  segmentId: number;
  showId: number;
  concertId: number;
  audienceMode: 'PUBLIC' | 'PLAYER_INVITED';
};

export async function loadSegmentTarget(segmentId: number): Promise<SegmentTarget> {
  try {
    const rows = await getDb().execute<{
      segment_id: string;
      show_id: string;
      concert_id: string;
      audience_mode: 'PUBLIC' | 'PLAYER_INVITED';
    }>(sql`
      select seg.id as segment_id,
             seg.show_id,
             s.concert_id,
             seg.audience_mode
        from show_segments seg
        join shows s on s.id = seg.show_id
       where seg.id = ${segmentId}
         and seg.deleted_at is null
    `);
    const row = rows[0];
    if (!row) throw new Error(`Segment ${segmentId} does not exist.`);
    return {
      segmentId: Number(row.segment_id),
      showId: Number(row.show_id),
      concertId: Number(row.concert_id),
      audienceMode: row.audience_mode,
    };
  } catch (error) {
    rethrowDbError(error);
  }
}

/**
 * Matches the sheet's player column against `players`, one query for all
 * distinct values rather than one per row.
 *
 * `NAME_FUZZY` runs `pg_trgm`'s own `similarity()` rather than a TypeScript
 * reimplementation: `import.fuzzy_match_threshold` is stated against that
 * function, and a second implementation would give a second answer to the same
 * question. `EMAIL` matching leans on `citext`, so it is already
 * case-insensitive in the column type rather than in a `lower()` here.
 */
export async function matchPlayers(
  concertId: number,
  values: readonly string[],
  strategy: 'EMAIL' | 'NAME' | 'NAME_FUZZY',
  threshold: number,
): Promise<Map<string, PlayerMatch>> {
  const out = new Map<string, PlayerMatch>();
  if (values.length === 0) return out;

  try {
    const db = getDb();
    /**
     * One row per value: `values ($1), ($2), ($3)`.
     *
     * Joining the placeholders bare gives `values ($1, $2, $3)`, which is a
     * single row of three *columns*. Postgres does not error — it names the
     * first column `needle` and discards the rest as `column2`, `column3` — so
     * the query succeeds and matches only the first value in the file. Every
     * player after the first then blocks with PLAYER_NOT_MATCHED, and the
     * screen offers to commit the remainder.
     */
    const list = sql.join(
      values.map((v) => sql`(${v})`),
      sql`, `,
    );

    if (strategy === 'EMAIL') {
      const rows = await db.execute<{ needle: string; id: string; full_name: string }>(sql`
        select v.needle, p.id, p.full_name
          from (values ${list}) as v(needle)
          join players p
            on p.email = v.needle::citext
           and p.concert_id = ${concertId}
           and p.is_active
           and p.deleted_at is null
      `);
      for (const r of rows) {
        out.set(r.needle, {
          playerId: Number(r.id),
          fullName: r.full_name,
          confidence: 1,
          needsConfirmation: false,
        });
      }
      return out;
    }

    if (strategy === 'NAME') {
      const rows = await db.execute<{ needle: string; id: string; full_name: string }>(sql`
        select v.needle, p.id, p.full_name
          from (values ${list}) as v(needle)
          join players p
            on lower(btrim(p.full_name)) = lower(btrim(v.needle))
           and p.concert_id = ${concertId}
           and p.is_active
           and p.deleted_at is null
      `);
      for (const r of rows) {
        out.set(r.needle, {
          playerId: Number(r.id),
          fullName: r.full_name,
          confidence: 1,
          needsConfirmation: false,
        });
      }
      return out;
    }

    // NAME_FUZZY: the best trigram match per value, flagged for confirmation
    // when it falls below the configured threshold (§9.3).
    const rows = await db.execute<{
      needle: string;
      id: string;
      full_name: string;
      score: number;
    }>(sql`
      select distinct on (v.needle)
             v.needle, p.id, p.full_name, similarity(p.full_name, v.needle) as score
        from (values ${list}) as v(needle)
        join players p
          on p.concert_id = ${concertId}
         and p.is_active
         and p.deleted_at is null
       where similarity(p.full_name, v.needle) > 0
       order by v.needle, score desc, p.id
    `);
    for (const r of rows) {
      const score = Number(r.score);
      out.set(r.needle, {
        playerId: Number(r.id),
        fullName: r.full_name,
        confidence: score,
        needsConfirmation: score < threshold,
      });
    }
    return out;
  } catch (error) {
    rethrowDbError(error);
  }
}

/**
 * Confirmed `BASE` seats per player in this segment.
 *
 * The predicates mirror `claim_seats()` exactly — active, undeleted, this
 * concert, not a cancelled registration — because this figure decides where
 * import stops calling a seat `BASE` (§9.5) and the engine decides whether it
 * grants one. Two different counts would promote a seat the engine would have
 * confirmed, or the reverse.
 */
export async function loadBaseAlreadyClaimed(segmentId: number): Promise<Map<number, number>> {
  try {
    const rows = await getDb().execute<{ player_id: string; claimed: string }>(sql`
      select r.player_id, count(*)::int as claimed
        from attendees a
        join registrations r on r.id = a.registration_id
       where a.segment_id = ${segmentId}
         and a.allocation_type = 'BASE'
         and a.status = 'CONFIRMED'
         and a.deleted_at is null
         and r.deleted_at is null
         and r.status <> 'CANCELLED'
         and r.player_id is not null
       group by r.player_id
    `);
    return new Map(rows.map((r) => [Number(r.player_id), Number(r.claimed)]));
  } catch (error) {
    rethrowDbError(error);
  }
}

/** Players who already hold a registration for this show (§9.4, blocking). */
export async function loadPlayersWithRegistration(showId: number): Promise<Set<number>> {
  try {
    const rows = await getDb().execute<{ player_id: string }>(sql`
      select distinct player_id
        from registrations
       where show_id = ${showId}
         and player_id is not null
         and deleted_at is null
         and status <> 'CANCELLED'
    `);
    return new Set(rows.map((r) => Number(r.player_id)));
  } catch (error) {
    rethrowDbError(error);
  }
}

/**
 * Parties already imported into this segment, keyed exactly as the planner keys
 * them: `contact_email|requested_at` in ISO (§9.2).
 *
 * **`citext` is lowered here rather than relied upon.** `registrations.contact_email`
 * is `citext`, so the database would happily compare it case-insensitively — but
 * this value never reaches a SQL comparison. It becomes a JavaScript `Map` key,
 * and `Map` does not know what `citext` is. The planner lowercases emails
 * through `transforms.lowercaseEmails`, so a stored "Alice@Example.com" would
 * build a key no planner lookup could ever find, and that party would import
 * again on every round.
 *
 * Cancelled and soft-deleted registrations are excluded on purpose: a party the
 * admin cancelled should re-import if it comes back in a later export, which is
 * the same predicate `loadPlayersWithRegistration` uses one function above.
 */
export async function loadExistingParties(
  segmentId: number,
): Promise<Map<string, { seats: number }>> {
  try {
    const rows = await getDb().execute<{
      contact_email: string;
      requested_at: string;
      seats: number;
    }>(sql`
      select lower(r.contact_email::text) as contact_email,
             r.requested_at,
             count(a.id)::int as seats
        from registrations r
        left join attendees a
          on a.registration_id = r.id
         and a.deleted_at is null
       where r.segment_id = ${segmentId}
         and r.contact_email is not null
         and r.requested_at is not null
         and r.deleted_at is null
         and r.status <> 'CANCELLED'
       group by r.contact_email, r.requested_at
    `);
    return new Map(
      rows.map((r) => [
        `${r.contact_email}|${new Date(r.requested_at).toISOString()}`,
        { seats: Number(r.seats) },
      ]),
    );
  } catch (error) {
    rethrowDbError(error);
  }
}

/**
 * Resolves an admin's explicit player choices, keyed by the cell value they were
 * made against (§9.3, "confirm or correct it").
 *
 * **The ids are re-read rather than trusted.** They arrive from a form, and a
 * player id from another concert would attach a registration to a stranger and
 * spend a quota that is not this concert's. Anything that is not an active,
 * undeleted player of this concert is dropped, which means the party goes back
 * to blocking — the safe direction, and visible in the next dry run.
 */
export async function loadPlayerOverrides(
  concertId: number,
  wanted: ReadonlyMap<string, number>,
): Promise<Map<string, { playerId: number; fullName: string }>> {
  const out = new Map<string, { playerId: number; fullName: string }>();
  const ids = [...new Set(wanted.values())];
  if (ids.length === 0) return out;

  try {
    const rows = await getDb().execute<{ id: string; full_name: string }>(sql`
      select id, full_name
        from players
       where concert_id = ${concertId}
         and is_active
         and deleted_at is null
         and id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
    `);
    const byId = new Map(rows.map((r) => [Number(r.id), r.full_name]));
    for (const [needle, playerId] of wanted) {
      const fullName = byId.get(playerId);
      if (fullName != null) out.set(needle, { playerId, fullName });
    }
    return out;
  } catch (error) {
    rethrowDbError(error);
  }
}

export async function buildPlanContext(
  target: SegmentTarget,
  profile: MappingProfile,
  rows: readonly SheetRow[],
  /** Explicit player choices from the dry-run screen, keyed by cell value. */
  playerOverrides: ReadonlyMap<string, number> = new Map(),
): Promise<PlanContext> {
  const ctx = {
    segmentId: target.segmentId,
    showId: target.showId,
    concertId: target.concertId,
  };

  const [
    baseQuota,
    maxTickets,
    extrasPolicy,
    pool,
    baseAlreadyClaimed,
    existing,
    existingParties,
  ] = await Promise.all([
    resolveSetting<number>('allocation.base_quota', ctx),
    resolveSetting<number>('form.max_tickets_per_response', ctx),
    resolveSetting<string>('allocation.extras_policy', ctx),
    segmentPool(target.segmentId),
    loadBaseAlreadyClaimed(target.segmentId),
    loadPlayersWithRegistration(target.showId),
    loadExistingParties(target.segmentId),
  ]);

  let playerMatches = new Map<string, PlayerMatch>();
  if (target.audienceMode === 'PLAYER_INVITED' && profile.playerMatch) {
    const column = profile.playerMatch.column;

    /**
     * Keyed by the **trimmed cell value**, because that is exactly what the
     * planner looks up. Lower-casing emails here instead produced a map whose
     * keys no match could ever be found under: the planner reads that column as
     * plain text, so "Alice@Example.com" in the sheet never found the
     * "alice@example.com" key this loop had written. Case-insensitivity belongs
     * in the comparison, not in the key — `players.email` is `citext` and the
     * NAME strategies lower both sides in SQL.
     */
    const distinct = new Set<string>();
    for (const row of rows) {
      const raw = (row.cells[column] ?? '').trim();
      if (raw !== '') distinct.add(raw);
    }
    const threshold =
      (await resolveSetting<number>('import.fuzzy_match_threshold', ctx)) ?? 1;
    playerMatches = await matchPlayers(
      target.concertId,
      [...distinct],
      profile.playerMatch.strategy,
      Number(threshold),
    );
  }

  return {
    audienceMode: target.audienceMode,
    // `claim_seats()` raises if this is unset, so a null here would surface as a
    // failed commit rather than a dry-run finding. It is reported by the caller.
    extrasPolicy: extrasPolicy === 'AUTO_FCFS' ? 'AUTO_FCFS' : 'REVIEW',
    baseQuota: target.audienceMode === 'PLAYER_INVITED' && baseQuota != null ? Number(baseQuota) : null,
    maxTicketsPerResponse: maxTickets == null ? null : Number(maxTickets),
    openSeats: pool.open_seats,
    extrasPool: pool.extras_pool,
    baseAlreadyClaimed,
    playersWithExistingRegistration: existing,
    existingParties,
    playerMatches,
    playerOverrides:
      target.audienceMode === 'PLAYER_INVITED'
        ? await loadPlayerOverrides(target.concertId, playerOverrides)
        : new Map(),
  };
}
