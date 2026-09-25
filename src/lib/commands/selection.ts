import { z } from 'zod';

/**
 * What a command acts on (spec/v3.md §22.3).
 *
 * Two shapes, and the difference between them is the point:
 *
 * - **`{ ids }`** — rows the admin ticked by hand. A short, explicit list of
 *   things they could see.
 * - **`{ filter, excludedIds }`** — "select all N matching". The *query*, not the
 *   rows it matched when the page rendered. The server resolves it inside the
 *   command's own transaction, so what runs is what matches at run time, and
 *   unticking a row after selecting all of them adds it to `excludedIds` rather
 *   than degrading the selection into a list the browser assembled.
 *
 * A client never sends a list of every matching id. That was V2's
 * `matchingTicketIdsAction`: correct for one screen, capped, and stale the
 * moment it arrived. This generalises it.
 *
 * `command_runs.selection` stores exactly what the command received, so a run
 * read back from the Activity log says which of the two it was.
 */
export type Selection<F> = { ids: number[] } | { filter: F; excludedIds: number[] };

/** A database id as it crosses the Server Action boundary. */
export const idSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** The zod schema for a {@link Selection} over a command's own filter. */
export function selectionSchema<F>(filter: z.ZodType<F>) {
  return z.union([
    z.object({ ids: z.array(idSchema) }).strict(),
    z.object({ filter, excludedIds: z.array(idSchema) }).strict(),
  ]);
}

export function isFilterSelection<F>(
  selection: Selection<F>,
): selection is { filter: F; excludedIds: number[] } {
  return 'filter' in selection;
}
