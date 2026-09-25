'use server';

import { revalidatePath } from 'next/cache';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { dbErrorMessage } from '@/db/errors';
import { booklets } from '@/db/schema/booklets';
import { concerts } from '@/db/schema/concerts';
import { writeAuditLog } from '@/lib/audit';
import { requireRole } from '@/lib/auth/guards';
import type { FormState } from '../../form-state';

/**
 * The Portal screen's mutations (spec/v2.md §13.3).
 *
 * Upload lives in `/api/portal/booklet` rather than here — a Server Action caps
 * its request body below what a programme PDF reaches. These are the changes
 * that carry no file.
 */

const practicalSchema = z.object({
  /**
   * Markdown, rendered on the portal through `RichText` rather than as HTML, so
   * there is nothing to sanitise here. The cap is a sanity bound on a textarea,
   * not an operational value: it stops a paste of an entire programme becoming
   * a page nobody can scroll, and nothing about the concert depends on it.
   */
  practicalInfoMd: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.string().trim().max(20_000, 'That is longer than this section is for.').nullable(),
  ),
});

export async function savePracticalInfoAction(
  concertId: number,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  await requireRole('ADMIN');

  const parsed = practicalSchema.safeParse({
    practicalInfoMd: formData.get('practicalInfoMd') ?? '',
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
  }

  try {
    const db = getDb();
    const [before] = await db
      .select({ practicalInfoMd: concerts.practicalInfoMd })
      .from(concerts)
      .where(and(eq(concerts.id, concertId), isNull(concerts.deletedAt)));
    if (!before) return { error: 'That concert no longer exists.' };

    await db
      .update(concerts)
      .set({ practicalInfoMd: parsed.data.practicalInfoMd, updatedAt: new Date() })
      .where(eq(concerts.id, concertId));

    await writeAuditLog({
      action: 'concert.practical_info_changed',
      entityType: 'concerts',
      entityId: concertId,
      before: { practicalInfoMd: before.practicalInfoMd },
      after: { practicalInfoMd: parsed.data.practicalInfoMd },
    });
  } catch (error) {
    return { error: dbErrorMessage(error) };
  }

  revalidatePath(`/admin/concerts/${concertId}/portal`);
  return { error: null, message: 'Saved.' };
}

/**
 * Publish or unpublish one booklet.
 *
 * **A separate action from the upload, on purpose.** `booklets.published` is
 * what lets a programme be uploaded weeks early and released on the day, and an
 * upload that published itself would take that away. It is also the section's
 * own lifecycle — which is why marking a show `COMPLETED` never had to close the
 * portal (decision 39).
 */
export async function setBookletPublishedAction(
  concertId: number,
  bookletId: number,
  published: boolean,
): Promise<FormState> {
  await requireRole('ADMIN');

  try {
    const db = getDb();
    const [row] = await db
      .update(booklets)
      .set({ published })
      .where(and(eq(booklets.id, bookletId), eq(booklets.concertId, concertId)))
      .returning({ id: booklets.id, title: booklets.title });
    if (!row) return { error: 'That booklet no longer exists.' };

    await writeAuditLog({
      action: published ? 'booklet.published' : 'booklet.unpublished',
      entityType: 'booklets',
      entityId: row.id,
      after: { published },
    });
  } catch (error) {
    return { error: dbErrorMessage(error) };
  }

  revalidatePath(`/admin/concerts/${concertId}/portal`);
  return { error: null, message: published ? 'Published.' : 'Hidden from the portal.' };
}

export async function deleteBookletAction(
  concertId: number,
  bookletId: number,
): Promise<FormState> {
  await requireRole('ADMIN');

  try {
    const db = getDb();
    const [row] = await db
      .delete(booklets)
      .where(and(eq(booklets.id, bookletId), eq(booklets.concertId, concertId)))
      .returning({ id: booklets.id, title: booklets.title });
    if (!row) return { error: 'That booklet no longer exists.' };

    /**
     * The row goes; the stored PDF stays. `booklets` carries no `deleted_at` and
     * the asset store is shared with ticket artwork, so deleting bytes here
     * risks removing an object another row still points at — a booklet uploaded
     * twice is two rows over one path. An orphaned object costs storage; a
     * missing one costs a ticket render.
     */
    await writeAuditLog({
      action: 'booklet.deleted',
      entityType: 'booklets',
      entityId: row.id,
      before: { title: row.title },
    });
  } catch (error) {
    return { error: dbErrorMessage(error) };
  }

  revalidatePath(`/admin/concerts/${concertId}/portal`);
  return { error: null, message: 'Removed.' };
}
