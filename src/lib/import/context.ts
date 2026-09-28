import 'server-only';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { rethrowDbError } from '@/db/errors';
import type { PlayerMatch } from './plan';

/**
 * What import reads from the database before it stages a file: the target
 * segment, and the roster the player column is matched against (§9.3).
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
