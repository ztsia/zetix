'use server';

import { revalidatePath } from 'next/cache';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { dbErrorMessage } from '@/db/errors';
import { systemSettings } from '@/db/schema/settings';
import { writeAuditLog } from '@/lib/audit';
import { requireAdmin } from '@/lib/auth/guards';
import { getSessionUser } from '@/lib/auth/session';
import { settingSpec } from './catalogue';
import type { FormState } from '../concerts/form-state';

/**
 * Writing the root of the cascade (spec/README.md §2.2, spec/domain.md §6).
 *
 * **A change here reaches every segment that does not override the key**, which
 * is why F1 put a constraint trigger on `system_settings` itself: editing
 * `allocation.base_quota`, `segment.capacity` or `capacity` re-checks the
 * configuration of every show in the database, and the whole edit is refused if
 * any of them ends up oversubscribed. That refusal is a sentence naming the
 * segment and the shortfall, and it is passed through untouched.
 *
 * Only keys in the catalogue can be written. The table is key/value with no
 * schema, so without that check a typo creates a new setting that nothing reads
 * and nobody notices — the failure mode is a value that looks set and is not.
 */

/**
 * The `::text::jsonb` double cast is load-bearing, exactly as in
 * `scripts/seed-settings.ts`.
 *
 * With a bare `::jsonb`, `postgres.js` infers the parameter type from the cast
 * and JSON-encodes the string that was already serialised, so the value lands
 * one level too deep — a jsonb *string* rather than a number, boolean or
 * object. Nothing errors. `keepalive.enabled` becomes `"true"` (still truthy),
 * and `allocation.extras_policy` becomes a string that never matches the
 * per-audience branch in `resolve_setting`, so a player segment silently
 * auto-grants extras that decision 4 says must be held for review.
 */
function jsonbParam(value: unknown) {
  return sql`${JSON.stringify(value)}::text::jsonb`;
}

/** Parses the posted string into the type the catalogue declares. */
function parseValue(kind: string, raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const text = raw.trim();

  switch (kind) {
    case 'number': {
      const n = Number(text);
      if (!Number.isFinite(n)) return { ok: false, error: `“${text}” is not a number.` };
      return { ok: true, value: n };
    }
    case 'boolean': {
      if (text === 'true' || text === 'false') return { ok: true, value: text === 'true' };
      return { ok: false, error: 'Choose on or off.' };
    }
    case 'json': {
      try {
        return { ok: true, value: JSON.parse(text) };
      } catch {
        return {
          ok: false,
          error:
            'That is not valid JSON. An extras policy looks like {"PLAYER_INVITED":"REVIEW","PUBLIC":"AUTO_FCFS"}.',
        };
      }
    }
    default:
      return { ok: true, value: text };
  }
}

export async function setSystemSettingAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  await requireAdmin();

  const parsed = z
    .object({ key: z.string().trim().min(1), value: z.string() })
    .safeParse({ key: formData.get('key') ?? '', value: formData.get('value') ?? '' });
  if (!parsed.success) return { error: 'Malformed request.' };

  const spec = settingSpec(parsed.data.key);
  if (!spec) {
    return {
      error: `“${parsed.data.key}” is not a setting this system reads. Nothing was changed.`,
    };
  }

  // An empty field clears the override rather than writing an empty string:
  // "nobody has set this" is a real state for an operational value, and it must
  // be reachable from the screen that set it (spec/domain.md §6).
  if (parsed.data.value.trim() === '') {
    return clearSystemSettingAction(parsed.data.key);
  }

  const value = parseValue(spec.kind, parsed.data.value);
  if (!value.ok) return { error: value.error };

  try {
    const db = getDb();
    const [before] = await db.execute<{ value: unknown }>(
      sql`select value from system_settings where key = ${parsed.data.key}`,
    );

    const user = await getSessionUser();
    await db.execute(sql`
      insert into system_settings (key, value, updated_at, updated_by)
      values (${parsed.data.key}, ${jsonbParam(value.value)}, now(), ${user?.id ?? null}::uuid)
      on conflict (key) do update
        set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by
    `);

    await writeAuditLog({
      action: 'setting.changed',
      entityType: 'system_setting',
      entityId: parsed.data.key,
      before: before?.value ?? null,
      after: value.value,
    });

    revalidatePath('/admin/settings');
    return { error: null, message: `Saved ${spec.label}.` };
  } catch (error) {
    // The `system_settings_guard` trigger re-checks every show when a capacity
    // or quota key changes, and refuses the edit naming the segment.
    return { error: dbErrorMessage(error) };
  }
}

/**
 * Removes the root value entirely.
 *
 * Not the same as setting it to zero. For an operational value this returns the
 * key to "nobody has set this", which the admin UI reports at save time rather
 * than falling back to anything (spec/domain.md §6). Removing the row that
 * supplies a resolved value is itself an edit to that value, which is why the
 * guard watches deletes too.
 */
export async function clearSystemSettingAction(key: string): Promise<FormState> {
  await requireAdmin();

  const spec = settingSpec(key);
  if (!spec) return { error: `“${key}” is not a setting this system reads.` };

  try {
    const db = getDb();
    const [before] = await db.execute<{ value: unknown }>(
      sql`select value from system_settings where key = ${key}`,
    );
    if (!before) return { error: null, message: `${spec.label} was already unset.` };

    await db.delete(systemSettings).where(sql`key = ${key}`);

    await writeAuditLog({
      action: 'setting.cleared',
      entityType: 'system_setting',
      entityId: key,
      before: before.value,
      after: null,
    });

    revalidatePath('/admin/settings');
    return {
      error: null,
      message: `Cleared ${spec.label}.${
        spec.operational
          ? ' Nothing supplies it now unless a concert, show or segment does.'
          : ''
      }`,
    };
  } catch (error) {
    return { error: dbErrorMessage(error) };
  }
}
