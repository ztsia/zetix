'use server';

import { revalidatePath } from 'next/cache';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { dbErrorMessage, pgError } from '@/db/errors';
import { concerts } from '@/db/schema/concerts';
import { writeAuditLog } from '@/lib/audit';
import { requireRole } from '@/lib/auth/guards';
import { slugify, type FormState } from './form-state';

/**
 * Concert create and archive (spec/admin.md §14.1, `/concerts` — "list, create,
 * archive").
 *
 * `F2` shipped the list; these are the two mutations module `A` adds to it.
 *
 * **Each action re-checks `requireRole('ADMIN')` itself.** A Server Action is its own
 * POST entry point, so the page's guard does not cover it and `src/proxy.ts`
 * never reads a role (modules.md §5.2.1). Rendering a form behind an
 * authenticated page is not an authorization boundary.
 *
 * Nothing here supplies an operational value. A concert carries capacities and
 * quotas only through the cascade, and this screen creates none of them — the
 * numbers arrive on the shows screen, typed by an admin (CLAUDE.md).
 */

/** Postgres' unique-violation SQLSTATE, raised by `concerts_slug_key`. */
const UNIQUE_VIOLATION = '23505';

/**
 * An IANA zone name, checked against the runtime's own tz database rather than
 * a list in this file.
 *
 * A concert with no zone cannot render a show time at all (spec/domain.md
 * §6.1), so this is required at create time. That is not a code default — it is
 * the absence of one: the admin must say which zone, and nothing is assumed.
 */
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

/** A calendar date, or nothing. `starts_on` is a date, not an instant. */
const dateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker, or type YYYY-MM-DD.')
  .nullable()
  .catch(null);

const createSchema = z
  .object({
    name: z.string().trim().min(1, 'A concert needs a name.').max(200),
    slug: z
      .string()
      .trim()
      .max(64)
      .regex(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        'The slug may hold lowercase letters, digits and single hyphens.',
      ),
    season: z.string().trim().max(120).nullable().catch(null),
    timezone: timezoneSchema,
    startsOn: dateSchema,
    endsOn: dateSchema,
  })
  .refine((v) => !v.startsOn || !v.endsOn || v.endsOn >= v.startsOn, {
    message: 'The concert cannot end before it starts.',
    path: ['endsOn'],
  });

/** `''` is what an untouched optional input posts; it is absence, not a value. */
function optional(value: FormDataEntryValue | null): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text === '' ? null : text;
}

export async function createConcertAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  await requireRole('ADMIN');

  const name = String(formData.get('name') ?? '').trim();
  // A blank slug field means "derive it", which is what the form previews. The
  // client's value is re-derived rather than trusted, so the two cannot drift.
  const slug = optional(formData.get('slug')) ?? slugify(name);

  const parsed = createSchema.safeParse({
    name,
    slug,
    season: optional(formData.get('season')),
    timezone: String(formData.get('timezone') ?? '').trim(),
    startsOn: optional(formData.get('startsOn')),
    endsOn: optional(formData.get('endsOn')),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
  }

  try {
    const [created] = await getDb()
      .insert(concerts)
      .values({
        name: parsed.data.name,
        slug: parsed.data.slug,
        season: parsed.data.season,
        timezone: parsed.data.timezone,
        startsOn: parsed.data.startsOn,
        endsOn: parsed.data.endsOn,
        // A new concert is a draft. Nothing is configured yet — no shows, no
        // segments, no capacity — so it is not something an operator or an
        // import should be able to act on.
        status: 'DRAFT',
      })
      .returning({ id: concerts.id, name: concerts.name });

    await writeAuditLog({
      action: 'concert.created',
      entityType: 'concert',
      entityId: created.id,
      after: { name: created.name, slug: parsed.data.slug, timezone: parsed.data.timezone },
    });

    revalidatePath('/admin/concerts');
    return { error: null, message: `Created ${created.name}.` };
  } catch (error) {
    if (isUniqueViolation(error)) {
      return {
        error: `Another concert already uses the slug "${parsed.data.slug}". Slugs appear in links, so they have to be unique — try adding the season.`,
      };
    }
    return { error: dbErrorMessage(error) };
  }
}

/**
 * Archive or restore a concert (spec/admin.md §14.1).
 *
 * Archiving is a **status change, not a delete**. Decision 7 keeps everything
 * indefinitely with soft deletes only, and an archived concert still owns the
 * registrations, tickets and scan log of a night that actually happened —
 * `deleted_at` would hide the record of a concert people attended.
 *
 * It is therefore reversible, which is why this takes the target state rather
 * than being two near-identical actions.
 */
export async function setConcertArchivedAction(
  concertId: number,
  archived: boolean,
): Promise<FormState> {
  await requireRole('ADMIN');

  const parsed = z
    .object({ concertId: z.number().int().positive(), archived: z.boolean() })
    .safeParse({ concertId, archived });
  if (!parsed.success) return { error: 'Malformed request.' };

  try {
    const db = getDb();
    const [before] = await db
      .select({ id: concerts.id, name: concerts.name, status: concerts.status })
      .from(concerts)
      .where(and(eq(concerts.id, parsed.data.concertId), isNull(concerts.deletedAt)));

    if (!before) return { error: 'That concert no longer exists.' };

    // Restoring returns it to DRAFT rather than ACTIVE: what it was before
    // archiving is not recorded, and guessing ACTIVE would silently reopen a
    // concert to operators and imports. DRAFT is the state an admin can move
    // forward from deliberately.
    const next = parsed.data.archived ? 'ARCHIVED' : 'DRAFT';
    if (before.status === next) {
      return { error: null, message: `${before.name} is already ${next.toLowerCase()}.` };
    }

    await db
      .update(concerts)
      .set({ status: next, updatedAt: new Date() })
      .where(eq(concerts.id, parsed.data.concertId));

    await writeAuditLog({
      action: parsed.data.archived ? 'concert.archived' : 'concert.restored',
      entityType: 'concert',
      entityId: parsed.data.concertId,
      before: { status: before.status },
      after: { status: next },
    });

    revalidatePath('/admin/concerts');
    return {
      error: null,
      message: parsed.data.archived
        ? `Archived ${before.name}. Its tickets and scan log are untouched.`
        : `Restored ${before.name} as a draft.`,
    };
  } catch (error) {
    return { error: dbErrorMessage(error) };
  }
}

/**
 * Drizzle wraps the driver error, so the SQLSTATE is not on the error it
 * throws. `pgError` already walks the `cause` chain to find the original —
 * a second walk here would be the same code with its own off-by-one.
 */
function isUniqueViolation(error: unknown): boolean {
  return pgError(error)?.code === UNIQUE_VIOLATION;
}
