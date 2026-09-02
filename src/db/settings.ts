import { sql } from 'drizzle-orm';
import { getDb } from './client';
import { rethrowDbError } from './errors';

/**
 * The four-level configuration cascade (spec/README.md §2.2, spec/domain.md §6).
 *
 *   system_settings → concert.defaults → show.<field> → segment.<field>
 *
 * **Never read a raw column for a cascading value.** `show_segments.capacity`
 * being null does not mean the segment holds nothing; it means the segment does
 * not override, and the answer is further up.
 *
 * The resolution itself lives in Postgres (`resolve_setting`), not here.
 * `claim_seats()` needs the same walk while holding its row lock, and two
 * implementations of one cascade drift apart — the second one silently, because
 * nothing compares them. This module is the typed doorway to that function.
 */

export type SettingContext = {
  segmentId?: number | null;
  showId?: number | null;
  concertId?: number | null;
};

/**
 * The raw resolved value, or `null` when no level supplies one.
 *
 * `null` is a real answer for an operational value: capacities, quotas and
 * deadlines carry no install-time seed, so "nobody has set it" is exactly what
 * the admin UI must report at save time (spec/domain.md §6). Use
 * {@link requireSetting} where absence is a configuration error rather than a
 * state to render.
 */
export async function resolveSetting<T = unknown>(
  key: string,
  ctx: SettingContext = {},
): Promise<T | null> {
  try {
    const rows = await getDb().execute<{ resolve_setting: T | null }>(sql`
      select resolve_setting(
        ${key}::text,
        ${ctx.segmentId ?? null}::bigint,
        ${ctx.showId ?? null}::bigint,
        ${ctx.concertId ?? null}::bigint
      )
    `);
    return rows[0]?.resolve_setting ?? null;
  } catch (error) {
    rethrowDbError(error);
  }
}

/** Resolution failure, carrying the key so the admin UI can name the field. */
export class MissingSettingError extends Error {
  constructor(readonly key: string) {
    super(
      `No value for "${key}" at any level of the cascade. ` +
        'Operational values have no default in code — enter it in the admin UI.',
    );
    this.name = 'MissingSettingError';
  }
}

export async function requireSetting<T = unknown>(
  key: string,
  ctx: SettingContext = {},
): Promise<T> {
  const value = await resolveSetting<T>(key, ctx);
  if (value === null || value === undefined) throw new MissingSettingError(key);
  return value;
}

/**
 * Reads several keys in one round trip.
 *
 * A screen usually needs the whole configuration of one segment at once, and
 * eight sequential resolves is eight round trips for one render.
 */
export async function resolveSettings(
  keys: readonly string[],
  ctx: SettingContext = {},
): Promise<Record<string, unknown>> {
  const entries = await Promise.all(
    keys.map(async (key) => [key, await resolveSetting(key, ctx)] as const),
  );
  return Object.fromEntries(entries);
}
