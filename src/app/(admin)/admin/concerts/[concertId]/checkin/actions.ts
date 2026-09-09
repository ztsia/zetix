'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { dbErrorMessage } from '@/db/errors';
import { requireAdmin } from '@/lib/auth/guards';
import { canAccessShow } from '@/lib/auth/show-access';
import { RevertError, revertCheckIn } from '@/lib/checkin/revert';
import type { FormState } from '../../form-state';

/**
 * Reverting a mistaken scan from the dashboard (spec/checkin.md §12.4).
 *
 * **`requireAdmin()` here, not on the page alone.** A Server Action is its own
 * POST entry point (modules.md §5.2.1). Reverting is an admin action only — an
 * operator at the door can admit anyone, but undoing the record of an admission
 * is not theirs to do, and `requireAdmin()` is what says so.
 *
 * `canAccessShow()` runs as well. For an `ADMIN` it is always true, so it buys
 * nothing today — it is here because it is the same authorization question the
 * manifest and scan endpoints ask, and the day this screen grows a role that is
 * not `ADMIN` is the day a missing check becomes a hole (decision 20).
 */
const schema = z.object({
  checkInId: z.number().int().positive(),
  showId: z.number().int().positive(),
  concertId: z.number().int().positive(),
  /** Optional, and recorded in `audit_log` rather than on the row. */
  reason: z.string().trim().max(500).nullable().catch(null),
});

export async function revertCheckInAction(input: {
  checkInId: number;
  showId: number;
  concertId: number;
  reason?: string | null;
}): Promise<FormState> {
  const admin = await requireAdmin();

  const parsed = schema.safeParse({ ...input, reason: input.reason ?? null });
  if (!parsed.success) return { error: 'Malformed request.' };

  // 404-shaped refusal, as everywhere else that takes a showId: probing ids must
  // not distinguish "not yours" from "not there" (modules.md §5.2.1).
  if (!(await canAccessShow(admin, parsed.data.showId))) {
    return { error: 'That show is not available.' };
  }

  try {
    await revertCheckIn({
      checkInId: parsed.data.checkInId,
      showId: parsed.data.showId,
      actorId: admin.id,
      reason: parsed.data.reason,
    });

    revalidatePath(`/admin/concerts/${parsed.data.concertId}/checkin`);
    return { error: null, message: 'Reverted. The ticket can be admitted again.' };
  } catch (error) {
    if (error instanceof RevertError) return { error: error.message };
    return { error: dbErrorMessage(error) };
  }
}
