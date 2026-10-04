import { z } from 'zod';

/**
 * A table's sort order as it crosses the Server Action boundary, for the
 * whole-set export loaders (spec/v3.md §32.1).
 *
 * Only ever an id to look up in a listing's own map of sortable columns —
 * `orderBy()` drops any id it does not know — so nothing here reaches SQL as
 * text. Bounded so a hostile caller cannot send ten thousand of them.
 */
export const sortingSchema = z
  .array(z.object({ id: z.string().max(60), desc: z.boolean() }).strict())
  .max(8);

/** What a whole-set export loader returns: the rows, or a sentence. */
export type ExportResult<T> = T[] | { error: string };

/** Said when a loader is handed something it cannot read. */
export const EXPORT_INPUT_ERROR = 'That export request was malformed. Reload the page and try again.';
