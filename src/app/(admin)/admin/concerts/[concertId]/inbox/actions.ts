'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { dbErrorMessage } from '@/db/errors';
import { requireRole } from '@/lib/auth/guards';
import { idSchema } from '@/lib/commands/selection';
import { markHandled, ReplyError, sendReply, type ReplyResult } from '@/lib/inbox/reply';
import { runInboxSync } from '@/lib/inbox/run';

/**
 * The inbox's mutations (spec/v3.md §26.3, §26.5, §26.6). Every one is an
 * admin's (§28): a reply goes to a guest, and even a sync writes rows.
 */

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * A sync asked for from the console — on opening a record, from Check now, and
 * on the console's own timer — is kept well inside one request. The tick is
 * where a long catch-up happens; this only has to pick up the last few minutes.
 */
const CONSOLE_SYNC_MS = 12_000;

/** Longest reply accepted: a reply is a person writing, not a newsletter. */
const MAX_REPLY_CHARS = 20_000;

function refresh(concertId: number) {
  revalidatePath(`/admin/concerts/${concertId}`, 'layout');
}

function failure(error: unknown): { ok: false; error: string } {
  if (error instanceof ReplyError) return { ok: false, error: error.message };
  return { ok: false, error: dbErrorMessage(error) };
}

const replyInput = z.object({
  concertId: idSchema,
  messageId: idSchema,
  body: z.string().trim().min(1, 'Write something before sending.').max(MAX_REPLY_CHARS),
});

export async function sendReplyAction(
  concertId: number,
  messageId: number,
  body: string,
): Promise<ActionResult<ReplyResult>> {
  const user = await requireRole('ADMIN');
  const parsed = replyInput.safeParse({ concertId, messageId, body });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'That reply was malformed.' };
  try {
    const value = await sendReply({ ...parsed.data, actorId: user.id });
    refresh(parsed.data.concertId);
    return { ok: true, value };
  } catch (error) {
    return failure(error);
  }
}

const ref = z.object({ concertId: idSchema, messageId: idSchema });

export async function markHandledAction(concertId: number, messageId: number): Promise<ActionResult<number>> {
  const user = await requireRole('ADMIN');
  const parsed = ref.safeParse({ concertId, messageId });
  if (!parsed.success) return { ok: false, error: 'That message reference was malformed.' };
  try {
    const value = await markHandled({ ...parsed.data, actorId: user.id });
    refresh(parsed.data.concertId);
    return { ok: true, value };
  } catch (error) {
    return failure(error);
  }
}

export type SyncSummary = { status: 'synced' | 'not_configured' | 'failed'; stored: number; message: string | null };

export async function syncInboxAction(concertId: number): Promise<ActionResult<SyncSummary>> {
  await requireRole('ADMIN');
  const parsed = idSchema.safeParse(concertId);
  if (!parsed.success) return { ok: false, error: 'That concert reference was malformed.' };
  const result = await runInboxSync({ deadline: Date.now() + CONSOLE_SYNC_MS });
  if (result.status === 'not_configured') {
    return { ok: true, value: { status: 'not_configured', stored: 0, message: result.reason } };
  }
  if (result.status === 'failed') return { ok: true, value: { status: 'failed', stored: 0, message: result.error } };
  const stored = result.folders.reduce((n, f) => n + f.stored, 0);
  const folderError = result.folders.find((f) => f.error)?.error ?? null;
  if (stored > 0) refresh(parsed.data);
  return { ok: true, value: { status: folderError ? 'failed' : 'synced', stored, message: folderError } };
}
