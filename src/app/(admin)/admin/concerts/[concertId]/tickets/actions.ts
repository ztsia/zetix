'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { asc, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { attendees, registrations } from '@/db/schema/registrations';
import { showSegments, shows } from '@/db/schema/shows';
import { requireAdmin } from '@/lib/auth/guards';
import { writeAuditLog } from '@/lib/audit';
import { dismissReissue, issueTickets, reissueTickets } from '@/lib/tickets/issue';
import {
  BOOKING_STATUSES,
  TICKET_STATES,
  ticketWhere,
  type TicketFilters,
} from './filters';

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

/**
 * The ceiling on "select everything that matches".
 *
 * Not an operational value in the cascade sense (CLAUDE.md) — it caps a payload
 * of integers, not a capacity, quota or rate. It exists so a mis-clicked filter
 * on a future festival cannot post tens of thousands of ids through a Server
 * Action; this concert's largest segment is 244.
 */
const MAX_SELECTABLE = 5000;

const filtersSchema = z.object({
  concertId: z.number().int().positive(),
  showId: z.number().int().positive().nullable(),
  segmentId: z.number().int().positive().nullable(),
  status: z.enum(BOOKING_STATUSES).nullable(),
  ticketState: z.enum(TICKET_STATES).nullable(),
  search: z.string().max(200),
});

export type MatchingIdsResult =
  | { ok: true; ids: number[] }
  | { ok: false; error: string };

/**
 * Every attendee behind the current filters, not just the page on screen.
 *
 * The table offers Gmail's "select all N that match" once a whole page is
 * ticked, and this is what that promise resolves to. **It re-derives the set
 * server-side from the same `ticketWhere()` the page rendered with**, rather
 * than trusting a count the browser did the arithmetic for — the ids then flow
 * through the existing `attendeeIds` scope, so the mutation's blast radius stays
 * an explicit list the admin can be shown, exactly as it is for a hand-ticked
 * selection.
 */
export async function matchingTicketIdsAction(
  input: z.infer<typeof filtersSchema>,
): Promise<MatchingIdsResult> {
  await requireAdmin();

  const parsed = filtersSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Malformed request.' };

  const { concertId, ...rest } = parsed.data;
  const filters: TicketFilters = rest;

  try {
    const rows = await getDb()
      .select({ id: attendees.id })
      .from(attendees)
      .innerJoin(registrations, eq(registrations.id, attendees.registrationId))
      .innerJoin(shows, eq(shows.id, attendees.showId))
      .innerJoin(showSegments, eq(showSegments.id, attendees.segmentId))
      .where(ticketWhere(concertId, filters))
      .orderBy(asc(attendees.id))
      .limit(MAX_SELECTABLE + 1);

    if (rows.length > MAX_SELECTABLE) {
      return {
        ok: false,
        error:
          `More than ${MAX_SELECTABLE} tickets match. Narrow the filters ` +
          'before selecting them all.',
      };
    }
    return { ok: true, ids: rows.map((row) => row.id) };
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
  // Only a cache refresh, but still reachable by name from any browser.
  await requireAdmin();
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
