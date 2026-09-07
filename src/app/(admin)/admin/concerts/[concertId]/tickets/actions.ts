'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/guards';
import { writeAuditLog } from '@/lib/audit';
import { dismissReissue, issueTickets, reissueTickets } from '@/lib/tickets/issue';

/**
 * The two ticket mutations (spec/tickets.md §10.5).
 *
 * Server Actions, because both are admin buttons rather than URLs anything
 * external calls (CLAUDE.md conventions). **Each re-checks `requireAdmin()`
 * itself**: a Server Action is its own entry point, so the page's guard does
 * not cover it, and the proxy never reads a role (modules.md §5.2.1).
 *
 * Both are audited. Decision 19 gives up per-person attribution by design —
 * one shared ADMIN account — so the log records what happened and when, which
 * is the part that survives.
 */

const scopeSchema = z.object({
  concertId: z.number().int().positive(),
  showId: z.number().int().positive().optional(),
  segmentId: z.number().int().positive().optional(),
  attendeeIds: z.array(z.number().int().positive()).optional(),
});

export type TicketActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

export async function issueTicketsAction(
  input: z.infer<typeof scopeSchema>,
): Promise<TicketActionResult> {
  await requireAdmin();

  const parsed = scopeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Malformed request.' };

  try {
    const result = await issueTickets(parsed.data);
    await writeAuditLog({
      action: 'tickets.issued',
      entityType: 'concert',
      entityId: parsed.data.concertId,
      after: {
        minted: result.minted,
        pinned: result.pinned,
        // Per show, because a show may override its concert's template
        // (domain.md §5.1) — a single id here would misreport what was pinned.
        templates: result.templates,
        scope: scopeOf(parsed.data),
      },
    });

    if (result.minted === 0 && result.pinned === 0) {
      return { ok: true, message: 'Every ticket in scope was already issued.' };
    }
    return {
      ok: true,
      message: `Issued ${result.pinned} ticket${result.pinned === 1 ? '' : 's'}.`,
    };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

export async function reissueTicketsAction(
  input: z.infer<typeof scopeSchema>,
): Promise<TicketActionResult> {
  await requireAdmin();

  const parsed = scopeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Malformed request.' };

  try {
    const result = await reissueTickets(parsed.data);
    await writeAuditLog({
      action: 'tickets.reissued',
      entityType: 'concert',
      entityId: parsed.data.concertId,
      after: {
        repinned: result.repinned,
        requeued: result.requeued,
        templates: result.templates,
        scope: scopeOf(parsed.data),
      },
    });

    return {
      ok: true,
      message:
        `Repinned ${result.repinned} ticket${result.repinned === 1 ? '' : 's'}. ` +
        `${result.requeued} will be resent.`,
    };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

function scopeOf(input: z.infer<typeof scopeSchema>) {
  return {
    showId: input.showId ?? null,
    segmentId: input.segmentId ?? null,
    attendees: input.attendeeIds?.length ?? null,
  };
}

/**
 * Errors from the ticket layer are written for an admin to act on — "Concert 4
 * has no timezone, so a ticket cannot be rendered for it" — so they are shown
 * rather than swallowed into a generic failure.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

/** Re-render the screen after a mutation so the counts are current. */
export async function refreshTickets(concertId: number): Promise<void> {
  revalidatePath(`/admin/concerts/${concertId}/tickets`);
}

/**
 * §10.6's other exit: clear the flag without resending.
 *
 * Audited like the other two, because it is the one that makes a divergence
 * stop being reported — an admin should be able to see later that somebody
 * decided a change was cosmetic, even though decision 19 costs us *which*
 * admin.
 */
export async function dismissReissueAction(
  input: z.infer<typeof scopeSchema>,
): Promise<TicketActionResult> {
  await requireAdmin();

  const parsed = scopeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Malformed request.' };

  try {
    const dismissed = await dismissReissue(parsed.data);
    await writeAuditLog({
      action: 'tickets.reissue_dismissed',
      entityType: 'concert',
      entityId: parsed.data.concertId,
      after: { dismissed, scope: scopeOf(parsed.data) },
    });
    return {
      ok: true,
      message:
        `Dismissed ${dismissed} reissue flag${dismissed === 1 ? '' : 's'} as cosmetic. ` +
        'No ticket was re-rendered and nothing will be resent.',
    };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}
