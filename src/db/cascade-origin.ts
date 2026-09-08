import { sql } from 'drizzle-orm';
import { getDb } from './client';
import { rethrowDbError } from './errors';

/**
 * Where a resolved setting actually comes from (spec/README.md §2.2).
 *
 * `resolveSetting` in `settings.ts` answers *what* a value is. An admin editing
 * the cascade also needs to know *which level said so* — a capacity field
 * showing "300" is misleading if the 300 belongs to the concert and this
 * segment overrides nothing. Without it the only way to discover that is to
 * clear the field and watch what happens, on production data.
 *
 * **The cascade is not reimplemented here.** `settings.ts` is explicit that two
 * implementations of one walk drift apart, silently, because nothing compares
 * them — so this asks Postgres for the same `resolve_setting()` the engine uses,
 * evaluated at four progressively wider contexts, and reads the origin off
 * where the answer changes.
 */

/** The four levels, plus the honest answer when nothing supplies a value. */
export type CascadeLevel = 'segment' | 'show' | 'concert' | 'system' | 'unset';

export type ResolvedSetting<T = unknown> = {
  key: string;
  /** The effective value — what the allocation engine will read. */
  value: T | null;
  origin: CascadeLevel;
};

export type CascadeScope = {
  segmentId?: number | null;
  showId?: number | null;
  concertId?: number | null;
};

/**
 * Resolves many keys for one scope in a single round trip.
 *
 * One query rather than four per key: a shows screen with two segments and six
 * cascading fields each is 48 resolutions, and as separate statements that is 48
 * round trips to render one page.
 *
 * **The same-value case is reported as inheritance.** If a show sets a capacity
 * its concert already had, the walk cannot distinguish "overridden to the same
 * number" from "not overridden", and this reports the wider level. That is the
 * more useful of the two readings — the effective value is identical either way,
 * and it never claims an override that does not change anything. Where the
 * distinction matters, read the raw column: a form asks "is this set *here*",
 * which is a column being null, not a question about the cascade.
 */
export async function resolveWithOrigin<T = unknown>(
  keys: readonly string[],
  scope: CascadeScope = {},
): Promise<Record<string, ResolvedSetting<T>>> {
  if (keys.length === 0) return {};

  try {
    const rows = await getDb().execute<{
      key: string;
      at_segment: T | null;
      at_show: T | null;
      at_concert: T | null;
      at_system: T | null;
    }>(sql`
      select
        k.key,
        resolve_setting(k.key, ${scope.segmentId ?? null}::bigint, ${scope.showId ?? null}::bigint, ${scope.concertId ?? null}::bigint) as at_segment,
        resolve_setting(k.key, null::bigint, ${scope.showId ?? null}::bigint, ${scope.concertId ?? null}::bigint) as at_show,
        resolve_setting(k.key, null::bigint, null::bigint, ${scope.concertId ?? null}::bigint) as at_concert,
        resolve_setting(k.key, null::bigint, null::bigint, null::bigint) as at_system
      -- The key list travels as one JSON parameter rather than a text[]:
      -- drizzle flattens a JS array into separate placeholders, so binding it
      -- as an array sends the first key alone and Postgres rejects it as a
      -- malformed array literal.
      from jsonb_array_elements_text(${JSON.stringify(keys)}::text::jsonb) as k(key)
    `);

    const out: Record<string, ResolvedSetting<T>> = {};
    for (const row of rows) {
      out[row.key] = {
        key: row.key,
        value: row.at_segment,
        origin: originOf(row),
      };
    }
    return out;
  } catch (error) {
    rethrowDbError(error);
  }
}

/**
 * The narrowest level whose answer differs from the next wider one.
 *
 * The walk is monotone — each level falls back to the one outside it — so a
 * level that changes the answer is a level that supplied it.
 */
function originOf(row: {
  at_segment: unknown;
  at_show: unknown;
  at_concert: unknown;
  at_system: unknown;
}): CascadeLevel {
  if (row.at_segment === null || row.at_segment === undefined) return 'unset';
  if (!same(row.at_segment, row.at_show)) return 'segment';
  if (!same(row.at_show, row.at_concert)) return 'show';
  if (!same(row.at_concert, row.at_system)) return 'concert';
  return 'system';
}

/** jsonb comes back as parsed JSON, so structural equality is the comparison. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

