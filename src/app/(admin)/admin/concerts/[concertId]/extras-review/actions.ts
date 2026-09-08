'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { dbErrorMessage } from '@/db/errors';
import { requireAdmin } from '@/lib/auth/guards';
import { commitReview } from '@/lib/registrations/review';
import type { FormState } from '../../form-state';
import { confirmsOverCapacity, OVERSELL_PHRASE } from '@/lib/registrations/confirmation';
import { segmentInConcert } from '../registrations/queries';

/**
 * Committing the extras review (spec/allocation.md §7.5).
 *
 * The transaction is `src/lib/registrations/review.ts`; this is the boundary
 * around it — validate the decisions, check the segment is this concert's,
 * insist on the typed confirmation before passing the override through.
 *
 * **The typed confirmation is checked here, not in the engine.** `promote_seats()`
 * takes a boolean; what §7.5 requires is that a person typed something
 * deliberate before that boolean is true. Keeping the two apart is what makes
 * the flag mean "a human confirmed this" rather than "some caller set it".
 */

const decisionSchema = z.object({
  registrationId: z.number().int().positive(),
  granted: z.number().int().min(0).max(1000),
});

const commitSchema = z.object({
  segmentId: z.number().int().positive(),
  decisions: z.array(decisionSchema).max(5000),
  override: z.boolean(),
  confirmation: z.string().trim().max(100),
});

export type CommitReviewInput = z.input<typeof commitSchema>;

export async function commitReviewAction(
  concertId: number,
  input: CommitReviewInput,
): Promise<FormState> {
  const admin = await requireAdmin();

  const parsed = commitSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message, message: null };
  const { segmentId, decisions, override, confirmation } = parsed.data;

  if (!(await segmentInConcert(concertId, segmentId))) {
    return { error: 'That segment does not belong to this concert.', message: null };
  }

  if (override && !confirmsOverCapacity(confirmation)) {
    return {
      error: `Type ${OVERSELL_PHRASE} to confirm a commit past the segment's or the hall's capacity.`,
      message: null,
    };
  }

  try {
    const result = await commitReview(segmentId, decisions, {
      override,
      // The words the admin actually typed, kept with the audit row: §7.5 asks
      // for the confirmation to be recorded, not merely required.
      reason: override
        ? `Committed past capacity. Confirmation typed: "${confirmation}".`
        : null,
      actorId: admin.id,
    });

    if (result.refused) {
      // Not an exception — the ceiling said no and nothing was written. The
      // database's sentence names the numbers and the ways out.
      return { error: result.refused, message: null };
    }

    revalidatePath(`/admin/concerts/${concertId}/extras-review`);
    revalidatePath(`/admin/concerts/${concertId}/registrations`);
    revalidatePath(`/admin/concerts/${concertId}/overview`);

    return {
      error: null,
      message:
        `${result.confirmed} seat${result.confirmed === 1 ? '' : 's'} confirmed, ` +
        `${result.waitlisted} waitlisted across ${result.registrations} ` +
        `part${result.registrations === 1 ? 'y' : 'ies'}. ` +
        'Their emails are queued from the Email screen — nothing has been sent.',
    };
  } catch (error) {
    return { error: dbErrorMessage(error), message: null };
  }
}
