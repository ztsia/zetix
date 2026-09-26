'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { dbErrorMessage } from '@/db/errors';
import { requireRole } from '@/lib/auth/guards';
import { getCommand } from '@/lib/commands/registry';
import { CommandInputError, startCommand, type RunReport } from '@/lib/commands/runner';
import { idSchema } from '@/lib/commands/selection';
import { changeContactEmail } from '@/lib/delivery/address';
import { editParams, loadMessage, type MessageRow } from '@/lib/delivery/messages';

/**
 * The Messages exits that are more than a command over a selection
 * (spec/v3.md §24.4): reading one message's body to edit it, and "fix address
 * and retry / resend", which changes the party's contact email and then runs
 * the command. Every one is an admin's (§28): a body carries ticket links.
 */

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Keeps a message action inside the function limit; one row runs well within it. */
const REQUEST_BUDGET_MS = 15_000;

function failure(error: unknown): { ok: false; error: string } {
  if (error instanceof CommandInputError) return { ok: false, error: error.message };
  return { ok: false, error: dbErrorMessage(error) };
}

function refresh(concertId: number) {
  revalidatePath(`/admin/concerts/${concertId}`, 'layout');
}

async function runOne(name: string, concertId: number, id: number, actorId: string, params: unknown = {}) {
  const def = getCommand(name);
  if (!def) throw new CommandInputError('That command does not exist.');
  return startCommand(def, { concertId, selection: { ids: [id] }, params }, {
    actorId,
    deadline: Date.now() + REQUEST_BUDGET_MS,
  });
}

/** The first skip or failure of a one-row run, in words, or null when it ran. */
function outcomeError(report: RunReport): string | null {
  const item = report.items[0];
  if (!item || item.status === 'DONE') return null;
  const reason = (item.outcome as { reason?: unknown } | null)?.reason;
  return item.error ?? (typeof reason === 'string' ? reason : 'It could not be done.');
}

const ref = z.object({ concertId: idSchema, messageId: idSchema });

export async function loadMessageAction(
  concertId: number,
  messageId: number,
): Promise<ActionResult<MessageRow & { bodyMd: string }>> {
  await requireRole('ADMIN');
  const parsed = ref.safeParse({ concertId, messageId });
  if (!parsed.success) return { ok: false, error: 'That message reference was malformed.' };
  try {
    const message = await loadMessage(getDb(), parsed.data.concertId, parsed.data.messageId);
    return message ? { ok: true, value: message } : { ok: false, error: 'That message no longer exists.' };
  } catch (error) {
    return failure(error);
  }
}

export async function editMessageAction(
  concertId: number,
  messageId: number,
  subject: string,
  bodyMd: string,
): Promise<ActionResult<null>> {
  const user = await requireRole('ADMIN');
  const parsed = ref.safeParse({ concertId, messageId });
  const words = editParams.safeParse({ subject, bodyMd });
  if (!parsed.success) return { ok: false, error: 'That message reference was malformed.' };
  if (!words.success) return { ok: false, error: words.error.issues[0]?.message ?? 'Check the subject and message.' };
  try {
    const report = await runOne('messages.edit', parsed.data.concertId, parsed.data.messageId, user.id, words.data);
    refresh(parsed.data.concertId);
    const error = outcomeError(report);
    return error ? { ok: false, error } : { ok: true, value: null };
  } catch (error) {
    return failure(error);
  }
}

const emailSchema = z.string().trim().min(3).max(320).email('That is not an email address.');

/**
 * **Fix address and retry** (a failed message) or **fix address and resend**
 * (a bounced one). The address is the party's, so it is changed there — which
 * also re-addresses anything else waiting — and then the message's own command
 * runs, reaching the party at the new address.
 */
export async function fixAddressAction(
  concertId: number,
  messageId: number,
  email: string,
): Promise<ActionResult<{ issue: string | null; then: 'retried' | 'resent' }>> {
  const user = await requireRole('ADMIN');
  const parsed = ref.safeParse({ concertId, messageId });
  const address = emailSchema.safeParse(email);
  if (!parsed.success) return { ok: false, error: 'That message reference was malformed.' };
  if (!address.success) return { ok: false, error: address.error.issues[0]?.message ?? 'That is not an email address.' };
  try {
    const message = await loadMessage(getDb(), parsed.data.concertId, parsed.data.messageId);
    if (!message) return { ok: false, error: 'That message no longer exists.' };
    if (!message.registrationId) {
      return { ok: false, error: 'This message is to a player. Change the address on the player instead.' };
    }
    if (message.status !== 'FAILED' && message.status !== 'BOUNCED') {
      return { ok: false, error: 'Only a failed or bounced message has its address fixed here.' };
    }
    const changed = await changeContactEmail(parsed.data.concertId, message.registrationId, address.data, user.id);
    if (!changed) return { ok: false, error: 'The party no longer exists in this concert.' };

    const then = message.status === 'FAILED' ? 'retried' : 'resent';
    const report = await runOne(
      then === 'retried' ? 'messages.retry' : 'messages.resend',
      parsed.data.concertId,
      parsed.data.messageId,
      user.id,
    );
    refresh(parsed.data.concertId);
    const error = outcomeError(report);
    return error
      ? { ok: false, error: `The address is changed, but the message was not ${then}: ${error}` }
      : { ok: true, value: { issue: changed.issue, then } };
  } catch (error) {
    return failure(error);
  }
}
