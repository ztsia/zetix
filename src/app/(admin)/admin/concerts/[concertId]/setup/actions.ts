'use server';

import { revalidatePath } from 'next/cache';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { dbErrorMessage, pgError } from '@/db/errors';
import { writeAuditLog } from '@/lib/audit';
import { requireRole } from '@/lib/auth/guards';
import { parseSettingValue, settingSpec } from '../../../settings/catalogue';
import type { FormState } from '../../form-state';
import { CONCERT_COLUMNS, type ConcertColumnKey } from './columns';

/**
 * Setup › Concert (spec/v3.md §29.1): editing the concert itself, and the
 * concert level of the cascade.
 *
 * **Each action re-checks `requireRole('ADMIN')`.** A Server Action is its own
 * POST entry point; the page's guard does not cover it.
 *
 * The concert level is `concerts.defaults`, a jsonb bag of the same keys
 * `system_settings` holds (spec/README.md §2.2) — except five portal keys,
 * which `resolve_setting()` reads from typed columns *before* the bag. Writing
 * those to the bag would be shadowed by whatever the column holds, so they are
 * written to their columns (`./columns.ts`).
 *
 * Nothing here needs its own oversubscription check: `concerts_entitlement_guard`
 * re-checks every segment of the concert when `defaults` changes (route 4 of
 * spec/allocation.md §7.4), and its refusal names the segment. It is passed
 * through untouched.
 */

const UNIQUE_VIOLATION = '23505';

const timezoneSchema = z
  .string()
  .trim()
  .min(1, 'Choose the timezone the concert happens in.')
  .refine((zone) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, 'That is not a recognised IANA timezone, for example "Asia/Kuala_Lumpur".');

const dateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker, or type YYYY-MM-DD.')
  .nullable();

const concertSchema = z
  .object({
    concertId: z.number().int().positive(),
    name: z.string().trim().min(1, 'A concert needs a name.').max(200),
    slug: z
      .string()
      .trim()
      .min(1, 'A concert needs a slug.')
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'The slug may hold lowercase letters, digits and single hyphens.'),
    season: z.string().trim().max(120).nullable(),
    timezone: timezoneSchema,
    startsOn: dateSchema,
    endsOn: dateSchema,
    // Archiving stays on the concert list, beside Restore, where it always was:
    // it takes the concert out of the working list, which is not an edit.
    status: z.enum(['DRAFT', 'ACTIVE']),
  })
  .refine((v) => !v.startsOn || !v.endsOn || v.endsOn >= v.startsOn, {
    message: 'The concert cannot end before it starts.',
    path: ['endsOn'],
  });

function optional(value: FormDataEntryValue | null): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text === '' ? null : text;
}

function refresh(concertId: number): void {
  // The sidebar's concert name and every screen's times read the concert.
  revalidatePath('/admin', 'layout');
  revalidatePath(`/admin/concerts/${concertId}/setup`);
  revalidatePath(`/admin/concerts/${concertId}/home`);
}

export async function updateConcertAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireRole('ADMIN');

  const parsed = concertSchema.safeParse({
    concertId: Number(formData.get('concertId')),
    name: String(formData.get('name') ?? ''),
    slug: String(formData.get('slug') ?? ''),
    season: optional(formData.get('season')),
    timezone: String(formData.get('timezone') ?? ''),
    startsOn: optional(formData.get('startsOn')),
    endsOn: optional(formData.get('endsOn')),
    status: formData.get('status'),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
  }
  const v = parsed.data;

  try {
    const db = getDb();
    const [before] = await db.execute<{
      name: string;
      slug: string;
      season: string | null;
      timezone: string | null;
      starts_on: string | null;
      ends_on: string | null;
      status: string;
    }>(sql`
      select name, slug, season, timezone, starts_on::text, ends_on::text, status::text
        from concerts where id = ${v.concertId} and deleted_at is null`);
    if (!before) return { error: 'That concert no longer exists.' };
    if (before.status === 'ARCHIVED') {
      return { error: 'This concert is archived. Restore it from the concert list before editing it.' };
    }

    await db.execute(sql`
      update concerts
         set name = ${v.name}, slug = ${v.slug}, season = ${v.season}, timezone = ${v.timezone},
             starts_on = ${v.startsOn}::date, ends_on = ${v.endsOn}::date,
             status = ${v.status}::concert_status, updated_at = now()
       where id = ${v.concertId}`);

    const after = {
      name: v.name,
      slug: v.slug,
      season: v.season,
      timezone: v.timezone,
      starts_on: v.startsOn,
      ends_on: v.endsOn,
      status: v.status,
    };
    const changed = Object.fromEntries(
      Object.entries(after).filter(([key, value]) => before[key as keyof typeof before] !== value),
    );
    if (Object.keys(changed).length === 0) return { error: null, message: 'Nothing changed.' };

    await writeAuditLog({
      action: 'concert.updated',
      entityType: 'concert',
      entityId: v.concertId,
      before: Object.fromEntries(Object.keys(changed).map((key) => [key, before[key as keyof typeof before]])),
      after: changed,
    });

    refresh(v.concertId);
    return {
      error: null,
      message:
        'timezone' in changed
          ? 'Saved. The timezone changed: show times keep the same instant, so check they still read right at the venue.'
          : 'Saved.',
    };
  } catch (error) {
    if (pgError(error)?.code === UNIQUE_VIOLATION) {
      return { error: `Another concert already uses the slug "${v.slug}".` };
    }
    return { error: dbErrorMessage(error) };
  }
}

const idSchema = z.number().int().positive();

/** The concert-level value of `key`, as stored — column or bag. */
async function readConcertValue(concertId: number, key: string): Promise<{ exists: boolean; value: unknown }> {
  const column = CONCERT_COLUMNS[key as ConcertColumnKey];
  const [row] = await getDb().execute<{ value: unknown }>(
    column
      ? sql`select to_jsonb(${sql.raw(column)}) as value from concerts where id = ${concertId} and deleted_at is null`
      : sql`select defaults -> ${key} as value from concerts where id = ${concertId} and deleted_at is null`,
  );
  return { exists: row !== undefined, value: row?.value ?? null };
}

/** Parses a value for one of the typed columns, which a bag value never has to satisfy. */
function columnValue(key: ConcertColumnKey, value: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (key === 'portal.notes_close_at') {
    const at = new Date(String(value));
    if (Number.isNaN(at.getTime())) {
      return { ok: false, error: 'That is not a timestamp. Use an ISO timestamp, for example 2026-11-20T23:00:00+08:00.' };
    }
    return { ok: true, value: at.toISOString() };
  }
  if (key === 'portal.public_wall_visibility') {
    const text = String(value).trim().toUpperCase();
    if (text !== 'ADMIN_ONLY' && text !== 'AUDIENCE') {
      return { ok: false, error: 'The wall is visible to ADMIN_ONLY or AUDIENCE.' };
    }
    return { ok: true, value: text };
  }
  return { ok: true, value };
}

export async function setConcertSettingAction(
  concertId: number,
  key: string,
  raw: string,
): Promise<FormState> {
  await requireRole('ADMIN');
  if (!idSchema.safeParse(concertId).success) return { error: 'Malformed request.' };

  const spec = settingSpec(key);
  if (!spec?.concert) {
    return { error: `“${key}” is not a setting a concert can override. Nothing was changed.` };
  }
  if (raw.trim() === '') return clearConcertSettingAction(concertId, key);

  const parsed = parseSettingValue(spec, raw);
  if (!parsed.ok) return { error: parsed.error };

  const column = CONCERT_COLUMNS[key as ConcertColumnKey];
  const value = column ? columnValue(key as ConcertColumnKey, parsed.value) : parsed;
  if (!value.ok) return { error: value.error };

  try {
    const before = await readConcertValue(concertId, key);
    if (!before.exists) return { error: 'That concert no longer exists.' };

    const db = getDb();
    if (column) {
      await db.execute(sql`
        update concerts set ${sql.raw(column)} = ${value.value}, updated_at = now()
         where id = ${concertId}`);
    } else {
      // The `::text::jsonb` double cast, as in the system-level action.
      await db.execute(sql`
        update concerts
           set defaults = coalesce(defaults, '{}'::jsonb) || jsonb_build_object(${key}::text, ${JSON.stringify(value.value)}::text::jsonb),
               updated_at = now()
         where id = ${concertId}`);
    }

    await writeAuditLog({
      action: 'concert.setting_changed',
      entityType: 'concert',
      entityId: concertId,
      before: { [key]: before.value },
      after: { [key]: value.value },
    });

    refresh(concertId);
    return { error: null, message: `Saved ${spec.label} for this concert.` };
  } catch (error) {
    // `concerts_entitlement_guard` refuses a quota or capacity that would
    // oversubscribe a segment, and names it.
    return { error: dbErrorMessage(error) };
  }
}

/**
 * Removes the concert's own value, so the key inherits from the system again.
 * Removing the value that supplies a capacity or quota is an edit to it, and
 * the same guard checks it.
 */
export async function clearConcertSettingAction(concertId: number, key: string): Promise<FormState> {
  await requireRole('ADMIN');
  if (!idSchema.safeParse(concertId).success) return { error: 'Malformed request.' };

  const spec = settingSpec(key);
  if (!spec?.concert) return { error: `“${key}” is not a setting a concert can override.` };

  try {
    const before = await readConcertValue(concertId, key);
    if (!before.exists) return { error: 'That concert no longer exists.' };
    if (before.value === null) return { error: null, message: `${spec.label} already inherits.` };

    const column = CONCERT_COLUMNS[key as ConcertColumnKey];
    await getDb().execute(
      column
        ? sql`update concerts set ${sql.raw(column)} = null, updated_at = now() where id = ${concertId}`
        : sql`update concerts set defaults = defaults - ${key}::text, updated_at = now() where id = ${concertId}`,
    );

    await writeAuditLog({
      action: 'concert.setting_cleared',
      entityType: 'concert',
      entityId: concertId,
      before: { [key]: before.value },
      after: { [key]: null },
    });

    refresh(concertId);
    return { error: null, message: `${spec.label} now inherits.` };
  } catch (error) {
    return { error: dbErrorMessage(error) };
  }
}
