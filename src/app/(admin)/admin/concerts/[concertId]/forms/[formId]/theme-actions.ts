'use server';

import { revalidatePath } from 'next/cache';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { writeAuditLog } from '@/lib/audit';
import { requireRole } from '@/lib/auth/guards';
import { deleteBanner } from '@/lib/forms/banner';
import { isHexColour, parseTheme, type FormTheme } from '@/lib/forms/theme';

/**
 * A form's theme (spec/v3.md §25.6), apart from the banner upload itself
 * (`/api/form-banners`, for the body size): the admin's colour override, and
 * removing the banner.
 */

type Result = { ok: true; theme: FormTheme | null } | { ok: false; error: string };

async function currentTheme(concertId: number, formId: number): Promise<{ theme: FormTheme | null } | null> {
  const [row] = await getDb().execute<{ theme: unknown }>(sql`
    select f.theme from registration_forms f
      left join show_segments g on g.id = f.segment_id
      join shows s on s.id = coalesce(f.show_id, g.show_id)
     where f.id = ${formId} and s.concert_id = ${concertId} and f.deleted_at is null
  `);
  return row ? { theme: parseTheme(row.theme) } : null;
}

async function store(formId: number, theme: FormTheme | null) {
  const empty = !theme || (!theme.bannerPath && !theme.colour && !theme.colourOverride);
  await getDb().execute(sql`
    update registration_forms
       set theme = ${empty ? null : JSON.stringify(theme)}::jsonb, updated_at = now()
     where id = ${formId}
  `);
  return empty ? null : theme;
}

/** Set, or with null clear, the admin's own colour. */
export async function saveFormColourAction(
  concertId: number,
  formId: number,
  colour: string | null,
): Promise<Result> {
  const admin = await requireRole('ADMIN');
  if (colour !== null && !isHexColour(colour)) return { ok: false, error: 'Choose a colour.' };
  const found = await currentTheme(concertId, formId);
  if (!found) return { ok: false, error: 'That form no longer exists.' };
  const theme = await store(formId, {
    bannerPath: found.theme?.bannerPath ?? null,
    colour: found.theme?.colour ?? null,
    colourOverride: colour?.toLowerCase() ?? null,
  });
  await writeAuditLog({
    action: 'form.theme_colour_set',
    entityType: 'registration_form',
    entityId: formId,
    before: { colourOverride: found.theme?.colourOverride ?? null },
    after: { colourOverride: colour },
    actorId: admin.id,
  });
  revalidatePath(`/admin/concerts/${concertId}/forms/${formId}`, 'layout');
  return { ok: true, theme };
}

/** Remove the banner, and the colour taken from it. The override stays. */
export async function removeFormBannerAction(concertId: number, formId: number): Promise<Result> {
  const admin = await requireRole('ADMIN');
  const found = await currentTheme(concertId, formId);
  if (!found) return { ok: false, error: 'That form no longer exists.' };
  const theme = await store(formId, {
    bannerPath: null,
    colour: null,
    colourOverride: found.theme?.colourOverride ?? null,
  });
  if (found.theme?.bannerPath) await deleteBanner(found.theme.bannerPath);
  await writeAuditLog({
    action: 'form.banner_removed',
    entityType: 'registration_form',
    entityId: formId,
    actorId: admin.id,
  });
  revalidatePath(`/admin/concerts/${concertId}/forms/${formId}`, 'layout');
  return { ok: true, theme };
}
