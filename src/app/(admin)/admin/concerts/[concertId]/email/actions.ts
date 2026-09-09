'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/guards';
import { queueBlast } from '@/lib/email/queue';
import {
  clearDeliveryForResend,
  confirmBatch,
  discardDrafts,
  editMessage,
  editTemplateAndRerender,
  markDelivered,
} from '@/lib/email/mutations';
import { seedDefaultTemplates } from '@/lib/email/defaults';
import { RESEND_PHRASE } from './confirmation';
import type { FormState } from '../../../concerts/form-state';

/**
 * Module `F`'s mutations (spec/email.md §11.5, §11.6).
 *
 * Server Actions, because every one is an admin button rather than a URL
 * anything external calls; the dispatcher is the exception and is a Route
 * Handler for exactly that reason (CLAUDE.md conventions).
 *
 * **Each re-checks `requireAdmin()` itself.** A Server Action is its own entry
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

const target = z.object({
  segmentId: z.number().int().positive(),
  templateKey: z.string().min(1),
});

function fail(error: unknown): FormState {
  return { error: error instanceof Error ? error.message : 'Something went wrong.' };
}

export async function prepareBlastAction(input: z.infer<typeof target>): Promise<FormState> {
  await requireAdmin();
  const parsed = target.safeParse(input);
  if (!parsed.success) return { error: 'Malformed request.' };

  try {
    await seedDefaultTemplates();
    const result = await queueBlast(parsed.data);
    revalidatePath('/admin/concerts', 'layout');

    /**
     * A template naming a token that does not resolve renders an empty string
     * into every message at once. Surfaced here rather than swallowed, while
     * the batch is still `DRAFT` and a person can fix the wording.
     */
    const warning =
      result.unknownTokens.length > 0
        ? ` Unknown token(s) in the template rendered as blank: ${result.unknownTokens.join(', ')}.`
        : '';

    return result.queued === 0
      ? { error: null, message: `Nothing to prepare — every seat here already has its ticket.${warning}` }
      : { error: null, message: `${result.queued} message(s) drafted for review.${warning}` };
  } catch (error) {
    return fail(error);
  }
}

export async function confirmBatchAction(input: z.infer<typeof target>): Promise<FormState> {
  const user = await requireAdmin();
  const parsed = target.safeParse(input);
  if (!parsed.success) return { error: 'Malformed request.' };

  try {
    const result = await confirmBatch({ ...parsed.data, actorId: user.id });
    revalidatePath('/admin/concerts', 'layout');
    return { error: null, message: `${result.queued} message(s) queued. Nothing sends until you press Send.` };
  } catch (error) {
    return fail(error);
  }
}

export async function discardDraftsAction(input: z.infer<typeof target>): Promise<FormState> {
  const user = await requireAdmin();
  const parsed = target.safeParse(input);
  if (!parsed.success) return { error: 'Malformed request.' };

  try {
    const result = await discardDrafts({ ...parsed.data, actorId: user.id });
    revalidatePath('/admin/concerts', 'layout');
    return { error: null, message: `${result.discarded} draft(s) withdrawn.` };
  } catch (error) {
    return fail(error);
  }
}

const messageEdit = z.object({
  outboxId: z.number().int().positive(),
  subject: z.string().min(1, 'A message needs a subject.'),
  bodyMd: z.string().min(1, 'A message needs a body.'),
});

export async function editMessageAction(formData: FormData): Promise<FormState> {
  const user = await requireAdmin();
  const parsed = messageEdit.safeParse({
    outboxId: Number(formData.get('outboxId')),
    subject: String(formData.get('subject') ?? ''),
    bodyMd: String(formData.get('bodyMd') ?? ''),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Malformed request.' };

  try {
    const result = await editMessage({ ...parsed.data, actorId: user.id });
    revalidatePath('/admin/concerts', 'layout');
    return result.updated
      ? { error: null, message: 'Message updated. A template re-render will now leave it alone.' }
      : { error: 'That message has already been queued, so it can no longer be edited.' };
  } catch (error) {
    return fail(error);
  }
}

const templateEdit = z.object({
  templateKey: z.string().min(1),
  subject: z.string().min(1, 'A template needs a subject.'),
  bodyMd: z.string().min(1, 'A template needs a body.'),
});

export async function editTemplateAction(formData: FormData): Promise<FormState> {
  const user = await requireAdmin();
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

const delivery = z.object({
  attendeeIds: z.array(z.number().int().positive()).min(1, 'Select at least one ticket.'),
  reason: z.string().trim().min(1, 'A short reason is required — it goes in the audit log.'),
});

/**
 * The selection travels through a hidden field as JSON, so it arrives as an
 * untrusted string.
 *
 * `JSON.parse` running before `zod` and outside a `try` throws a raw
 * `SyntaxError` at the Server Action boundary — a stack rather than the
 * structured error every other failure here returns (`CLAUDE.md` conventions:
 * validation failure returns a structured error, never a thrown stack).
 * Malformed input is a `null` the schema then rejects with a sentence.
 */
function parseIds(raw: FormDataEntryValue | null): unknown {
  try {
    return JSON.parse(String(raw ?? '[]'));
  } catch {
    return null;
  }
}

export async function markDeliveredAction(formData: FormData): Promise<FormState> {
  const user = await requireAdmin();
  const parsed = delivery.safeParse({
    attendeeIds: parseIds(formData.get('attendeeIds')),
    reason: String(formData.get('reason') ?? ''),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Malformed request.' };

  try {
    const result = await markDelivered({ ...parsed.data, actorId: user.id });
    revalidatePath('/admin/concerts', 'layout');
    return {
      error: null,
      message: `${result.marked} ticket(s) marked delivered. Nothing was sent.`,
    };
  } catch (error) {
    return fail(error);
  }
}

/**
 * §11.4: resend "is never the default path, and never operates on a whole
 * segment at once without a typed confirmation". The phrase is shared with the
 * screen so the two cannot disagree about what counts as deliberate — module
 * `B` learned the same lesson with its override phrase.
 */
const resend = delivery.extend({ confirmation: z.string() });

export async function resendTicketsAction(formData: FormData): Promise<FormState> {
  const user = await requireAdmin();
  const parsed = resend.safeParse({
    attendeeIds: parseIds(formData.get('attendeeIds')),
    reason: String(formData.get('reason') ?? ''),
    confirmation: String(formData.get('confirmation') ?? ''),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Malformed request.' };

  if (parsed.data.confirmation.trim() !== RESEND_PHRASE) {
    return { error: `Type “${RESEND_PHRASE}” to confirm. Nothing was changed.` };
  }

  try {
    const result = await clearDeliveryForResend({
      attendeeIds: parsed.data.attendeeIds,
      reason: parsed.data.reason,
      actorId: user.id,
    });
    revalidatePath('/admin/concerts', 'layout');
    return {
      error: null,
      message: `${result.cleared} ticket(s) will be included in the next blast.`,
    };
  } catch (error) {
    return fail(error);
  }
}
