'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { dbErrorMessage } from '@/db/errors';
import { requireAdmin } from '@/lib/auth/guards';
import { createOperatorAuthAdmin } from '@/lib/operators/auth-admin';
import {
  createOperator,
  OperatorProvisionError,
  regenerateAccessCode,
  setOperatorActive,
  setShowAssignments,
} from '@/lib/operators/provision';
import type { OperatorFormState } from './form-state';

/**
 * Operator provisioning actions (spec/admin.md §14.3, spec/checkin.md §12.1).
 *
 * **Every action re-checks `requireAdmin()` itself.** A Server Action is its own
 * POST entry point, so the page's guard does not cover it and `src/proxy.ts`
 * never reads a role (modules.md §5.2.1). These actions create Supabase Auth
 * users and hand out the credential that reaches an attendee roster, so the one
 * that is missing a guard is the one that matters.
 *
 * **The service-role client is constructed inside the guard, never above it.**
 * It bypasses RLS entirely, and this is one of exactly two audited paths allowed
 * to hold it (`src/lib/supabase/admin.ts`).
 *
 * Nothing here supplies an operational value — an operator has no capacity,
 * quota or deadline attached to them (CLAUDE.md).
 */

const displayNameSchema = z
  .string()
  .trim()
  .min(1, 'An operator needs a display name — it is what they type to sign in.')
  .max(120, 'That display name is too long.');

const userIdSchema = z.string().uuid('Malformed request.');

/**
 * Turns a provisioning failure into something an admin can act on.
 *
 * `OperatorProvisionError` is a refusal with a written explanation — a name
 * clash, a show outside this concert — and its message is rendered verbatim. A
 * missing service-role key gets its own sentence because it is not a mistake the
 * admin made: no cloud session holds that key (spec/local.md §5b, §7), so the
 * screen builds and this one action can only run from a machine that has it.
 */
function toFormError(error: unknown): OperatorFormState {
  if (error instanceof OperatorProvisionError) return { error: error.message };
  if (error instanceof Error && error.message.includes('SUPABASE_SERVICE_ROLE_KEY')) {
    return {
      error:
        'Creating an operator needs the Supabase service-role key, which this ' +
        'deployment does not hold. Run it from a machine that has it ' +
        '(docs/local.md §5b).',
    };
  }
  return { error: dbErrorMessage(error) };
}

export async function createOperatorAction(
  _prev: OperatorFormState,
  formData: FormData,
): Promise<OperatorFormState> {
  const admin = await requireAdmin();

  const parsed = displayNameSchema.safeParse(formData.get('displayName') ?? '');
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
  }

  const concertId = Number(formData.get('concertId'));
  if (!Number.isInteger(concertId) || concertId <= 0) return { error: 'Malformed request.' };

  try {
    const operator = await createOperator(
      { displayName: parsed.data, actorId: admin.id },
      createOperatorAuthAdmin(),
    );

    revalidatePath(`/admin/concerts/${concertId}/operators`);
    return {
      error: null,
      message: `Created ${operator.displayName}.`,
      // The code is returned to be shown **once** (spec/admin.md §14.3). It is
      // never stored in readable form and never written to the audit log, so
      // this response is the only chance the admin has to copy it.
      issued: { displayName: operator.displayName, accessCode: operator.accessCode },
    };
  } catch (error) {
    return toFormError(error);
  }
}

export async function regenerateAccessCodeAction(
  userId: string,
  concertId: number,
): Promise<OperatorFormState> {
  const admin = await requireAdmin();

  const parsed = z
    .object({ userId: userIdSchema, concertId: z.number().int().positive() })
    .safeParse({ userId, concertId });
  if (!parsed.success) return { error: 'Malformed request.' };

  try {
    const rotated = await regenerateAccessCode(
      { userId: parsed.data.userId, actorId: admin.id },
      createOperatorAuthAdmin(),
    );

    revalidatePath(`/admin/concerts/${parsed.data.concertId}/operators`);
    return {
      error: null,
      message: `Issued a new code for ${rotated.displayName ?? 'the operator'}.`,
      issued: {
        displayName: rotated.displayName ?? 'Operator',
        accessCode: rotated.accessCode,
      },
    };
  } catch (error) {
    return toFormError(error);
  }
}

export async function setOperatorActiveAction(
  userId: string,
  isActive: boolean,
  concertId: number,
): Promise<OperatorFormState> {
  const admin = await requireAdmin();

  const parsed = z
    .object({
      userId: userIdSchema,
      isActive: z.boolean(),
      concertId: z.number().int().positive(),
    })
    .safeParse({ userId, isActive, concertId });
  if (!parsed.success) return { error: 'Malformed request.' };

  try {
    await setOperatorActive({
      userId: parsed.data.userId,
      isActive: parsed.data.isActive,
      actorId: admin.id,
    });

    revalidatePath(`/admin/concerts/${parsed.data.concertId}/operators`);
    return {
      error: null,
      message: parsed.data.isActive
        ? 'That operator can sign in again.'
        : 'Deactivated. Their session stops working on their next request.',
    };
  } catch (error) {
    return toFormError(error);
  }
}

export async function setShowAssignmentsAction(
  userId: string,
  concertId: number,
  showIds: number[],
): Promise<OperatorFormState> {
  const admin = await requireAdmin();

  const parsed = z
    .object({
      userId: userIdSchema,
      concertId: z.number().int().positive(),
      // Bounded so a hand-made request cannot ask for an unbounded insert. This
      // is a request-size limit, not an operational value from context.md.
      showIds: z.array(z.number().int().positive()).max(200),
    })
    .safeParse({ userId, concertId, showIds });
  if (!parsed.success) return { error: 'Malformed request.' };

  try {
    await setShowAssignments({
      userId: parsed.data.userId,
      concertId: parsed.data.concertId,
      showIds: parsed.data.showIds,
      actorId: admin.id,
    });

    revalidatePath(`/admin/concerts/${parsed.data.concertId}/operators`);
    return {
      error: null,
      message:
        parsed.data.showIds.length === 0
          ? 'Removed every assignment. They can sign in and will see an empty show list.'
          : `Assigned to ${parsed.data.showIds.length} show${parsed.data.showIds.length === 1 ? '' : 's'}.`,
    };
  } catch (error) {
    return toFormError(error);
  }
}
