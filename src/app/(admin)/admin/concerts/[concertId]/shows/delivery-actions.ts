'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { dbErrorMessage } from '@/db/errors';
import { requireRole } from '@/lib/auth/guards';
import { idSchema } from '@/lib/commands/selection';
import {
  DeliveryDefaultsError,
  loadSegmentDelivery,
  saveSegmentDelivery,
  type SegmentDelivery,
} from '@/lib/delivery/defaults';
import { seedDefaultTemplates } from '@/lib/email/defaults';

/**
 * A segment's delivery defaults (spec/v3.md §24.2): the ticket design and the
 * ticket email the send wizard starts from. Admin only, like every edit to a
 * segment.
 */

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: string };

const ref = z.object({ concertId: idSchema, segmentId: idSchema });

export async function segmentDeliveryAction(
  concertId: number,
  segmentId: number,
): Promise<ActionResult<SegmentDelivery>> {
  await requireRole('ADMIN');
  const parsed = ref.safeParse({ concertId, segmentId });
  if (!parsed.success) return { ok: false, error: 'That segment reference was malformed.' };
  try {
    // The ticket templates must exist to be offered; seeding never overwrites.
    await seedDefaultTemplates();
    const found = await loadSegmentDelivery(parsed.data.concertId, parsed.data.segmentId);
    return found ? { ok: true, value: found } : { ok: false, error: 'That segment is not part of this concert.' };
  } catch (error) {
    return { ok: false, error: dbErrorMessage(error) };
  }
}

const choiceSchema = z.object({
  designId: idSchema.nullable(),
  ticketTemplate: z.string().min(1).max(100).nullable(),
});

export async function saveSegmentDeliveryAction(
  concertId: number,
  segmentId: number,
  choice: { designId: number | null; ticketTemplate: string | null },
): Promise<ActionResult<null>> {
  const user = await requireRole('ADMIN');
  const parsed = ref.safeParse({ concertId, segmentId });
  const values = choiceSchema.safeParse(choice);
  if (!parsed.success || !values.success) return { ok: false, error: 'That request was malformed.' };
  try {
    await saveSegmentDelivery(parsed.data.concertId, parsed.data.segmentId, values.data, user.id);
    revalidatePath(`/admin/concerts/${parsed.data.concertId}/shows`);
    return { ok: true, value: null };
  } catch (error) {
    if (error instanceof DeliveryDefaultsError) return { ok: false, error: error.message };
    return { ok: false, error: dbErrorMessage(error) };
  }
}
