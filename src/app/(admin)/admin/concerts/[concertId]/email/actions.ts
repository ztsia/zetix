'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireRole } from '@/lib/auth/guards';
import { editTemplateAndRerender } from '@/lib/email/mutations';
import type { FormState } from '../../../concerts/form-state';

/**
 * The email template editor's one mutation (spec/email.md §11.5).
 *
 * The rest of module `F`'s actions — prepare, confirm, discard, edit one
 * message, mark delivered, resend — were retired with the Email screen: they
 * are the send wizard and the Delivery and Messages commands now
 * (spec/v3.md §24).
 *
 * **Each re-checks `requireRole('ADMIN')` itself.** A Server Action is its own entry
 * point, so the page's guard does not cover it and the proxy never reads a role
 * (modules.md §5.2.1). `tests/email/action-guards.test.ts` fails if one of
 * these calls is deleted — the failure an independent pass found in `D` and
 * `F2`, where removing a guard left both suites green.
 *
 * **The actor is passed down explicitly.** `writeAuditLog` resolves it with its
 * own query otherwise, and inside a transaction on a `max: 1` pool that query
 * waits for the connection the transaction holds — the request deadlocks
 * against itself rather than failing (`src/lib/audit.ts`).
 */

function fail(error: unknown): FormState {
  return { error: error instanceof Error ? error.message : 'Something went wrong.' };
}

const templateEdit = z.object({
  templateKey: z.string().min(1),
  subject: z.string().min(1, 'A template needs a subject.'),
  bodyMd: z.string().min(1, 'A template needs a body.'),
});

export async function editTemplateAction(formData: FormData): Promise<FormState> {
  const user = await requireRole('ADMIN');
  const parsed = templateEdit.safeParse({
    templateKey: String(formData.get('templateKey') ?? ''),
    subject: String(formData.get('subject') ?? ''),
    bodyMd: String(formData.get('bodyMd') ?? ''),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Malformed request.' };

  try {
    const result = await editTemplateAndRerender({ ...parsed.data, actorId: user.id });
    revalidatePath('/admin/concerts', 'layout');
    const preserved =
      result.preserved > 0
        ? ` ${result.preserved} hand-edited message(s) were left as they are.`
        : '';
    return { error: null, message: `Template saved. ${result.rerendered} draft(s) re-rendered.${preserved}` };
  } catch (error) {
    return fail(error);
  }
}
