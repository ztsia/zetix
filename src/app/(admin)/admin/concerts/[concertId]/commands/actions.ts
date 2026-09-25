'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { dbErrorMessage } from '@/db/errors';
import { requireAdmin } from '@/lib/auth/guards';
import { getCommand } from '@/lib/commands/registry';
import {
  CommandInputError,
  cancelRun,
  continueRun,
  previewCommand,
  readRun,
  startCommand,
  type CommandInput,
  type Preview,
  type RunReport,
} from '@/lib/commands/runner';
import { idSchema } from '@/lib/commands/selection';

/**
 * The console's one doorway to the command runner (spec/v3.md §23.1).
 *
 * Every screen runs every command through these five actions, by name, so the
 * guard, the validation and the error handling are written once. The command's
 * own schemas validate the selection and parameters inside the runner; this
 * layer validates only the name and the ids it is handed directly.
 *
 * `requireAdmin()` is the guard until `R` replaces it with `requireRole()`
 * (spec/v3.md §28): a viewer must never reach a command.
 */

/**
 * How long one request works a run before handing it back.
 *
 * Infrastructure, not an operational value: it keeps a Server Action well
 * inside the platform's function limit and the 25s statement timeout
 * (`src/db/client.ts`). A run that needs longer is continued by the dialog's
 * own loop while it is open, and by the scheduler tick otherwise (§27.1).
 */
const REQUEST_BUDGET_MS = 15_000;

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: string };

const nameSchema = z.string().min(1).max(100);

function failure(error: unknown): { ok: false; error: string } {
  if (error instanceof CommandInputError) return { ok: false, error: error.message };
  return { ok: false, error: dbErrorMessage(error) };
}

function commandFor(name: unknown) {
  const parsed = nameSchema.safeParse(name);
  const command = parsed.success ? getCommand(parsed.data) : undefined;
  if (!command) throw new CommandInputError('That command does not exist.');
  return command;
}

export async function previewCommandAction(
  name: string,
  input: CommandInput,
): Promise<ActionResult<Preview>> {
  const user = await requireAdmin();
  try {
    return { ok: true, value: await previewCommand(commandFor(name), input, user.id) };
  } catch (error) {
    return failure(error);
  }
}

export async function runCommandAction(
  name: string,
  input: CommandInput,
): Promise<ActionResult<RunReport>> {
  const user = await requireAdmin();
  try {
    const report = await startCommand(commandFor(name), input, {
      actorId: user.id,
      deadline: Date.now() + REQUEST_BUDGET_MS,
    });
    revalidatePath(`/admin/concerts/${input.concertId}`, 'layout');
    return { ok: true, value: report };
  } catch (error) {
    return failure(error);
  }
}

const runRefSchema = z.object({ concertId: idSchema, runId: idSchema });

function runRef(concertId: unknown, runId: unknown) {
  const parsed = runRefSchema.safeParse({ concertId, runId });
  if (!parsed.success) throw new CommandInputError('That run reference was malformed.');
  return parsed.data;
}

/** The dialog's loop: work a paused run while its report is on screen. */
export async function continueRunAction(
  concertId: number,
  runId: number,
): Promise<ActionResult<RunReport>> {
  await requireAdmin();
  try {
    const ref = runRef(concertId, runId);
    const current = await readRun(ref.runId, ref.concertId);
    if (current.status !== 'RUNNING') return { ok: true, value: current };
    const report = await continueRun(
      commandFor(current.command),
      ref.runId,
      ref.concertId,
      Date.now() + REQUEST_BUDGET_MS,
    );
    if (report.status !== 'RUNNING') revalidatePath(`/admin/concerts/${ref.concertId}`, 'layout');
    return { ok: true, value: report };
  } catch (error) {
    return failure(error);
  }
}

export async function cancelRunAction(
  concertId: number,
  runId: number,
): Promise<ActionResult<RunReport>> {
  await requireAdmin();
  try {
    const ref = runRef(concertId, runId);
    const report = await cancelRun(ref.runId, ref.concertId);
    revalidatePath(`/admin/concerts/${ref.concertId}`, 'layout');
    return { ok: true, value: report };
  } catch (error) {
    return failure(error);
  }
}

export async function readRunAction(
  concertId: number,
  runId: number,
): Promise<ActionResult<RunReport>> {
  await requireAdmin();
  try {
    const ref = runRef(concertId, runId);
    return { ok: true, value: await readRun(ref.runId, ref.concertId) };
  } catch (error) {
    return failure(error);
  }
}
