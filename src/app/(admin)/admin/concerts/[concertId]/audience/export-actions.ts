'use server';

import { z } from 'zod';
import { requireRole } from '@/lib/auth/guards';
import { maskForRole } from '@/lib/auth/mask';
import { audienceFilterSchema } from '@/lib/audience/filter';
import { exportParties, exportSeats, type PartyRow, type SeatRow } from '@/lib/audience/queries';
import { idSchema, selectionSchema } from '@/lib/commands/selection';
import { EXPORT_INPUT_ERROR, sortingSchema, type ExportResult } from '@/lib/export/sorting';

/**
 * The Audience tables' exports: the whole selection, never the page
 * (spec/v3.md §32.1).
 *
 * The same `{ ids } | { filter, excludedIds }` the commands take, resolved by
 * the same WHERE as the listing and `matchPartyIds` / `matchSeatIds`, so the
 * file holds exactly the rows "Select all N matching" named, or the rows
 * ticked across every page — and, with nothing ticked, the whole filter.
 *
 * `ADMIN` only, like every export; a Server Action is reachable directly, so
 * the check is here and not only on the hidden button. What leaves passes
 * through `maskForRole()` like every other read.
 */
const inputSchema = z.object({
  concertId: idSchema,
  selection: selectionSchema(audienceFilterSchema),
  sorting: sortingSchema,
});

export async function exportPartiesAction(input: unknown): Promise<ExportResult<PartyRow>> {
  const user = await requireRole('ADMIN');
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { error: EXPORT_INPUT_ERROR };
  const { concertId, selection, sorting } = parsed.data;
  return maskForRole(user.role, await exportParties(concertId, selection, sorting));
}

export async function exportSeatsAction(input: unknown): Promise<ExportResult<SeatRow>> {
  const user = await requireRole('ADMIN');
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { error: EXPORT_INPUT_ERROR };
  const { concertId, selection, sorting } = parsed.data;
  return maskForRole(user.role, await exportSeats(concertId, selection, sorting));
}
