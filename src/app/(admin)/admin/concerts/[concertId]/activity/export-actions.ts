'use server';

import { z } from 'zod';
import { requireRole } from '@/lib/auth/guards';
import { maskForRole } from '@/lib/auth/mask';
import { listActivity, type ActivityRow } from '@/lib/activity/queries';
import { idSchema } from '@/lib/commands/selection';
import { EXPORT_INPUT_ERROR, type ExportResult } from '@/lib/export/sorting';

/**
 * The Activity log's Changes export (spec/v3.md §32.1): the concert's audit
 * trail, every row the view and search match rather than the page on screen.
 * `ADMIN` only; a reason can hold an address.
 */
const inputSchema = z.object({
  concertId: idSchema,
  view: z.string().max(40).nullable(),
  search: z.string().max(200),
  runId: idSchema.nullable(),
});

export async function exportActivityAction(input: unknown): Promise<ExportResult<ActivityRow>> {
  const user = await requireRole('ADMIN');
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { error: EXPORT_INPUT_ERROR };
  const { concertId, view, search, runId } = parsed.data;
  const { rows } = await listActivity(concertId, {
    view,
    search,
    runId,
    pageIndex: 0,
    pageSize: null,
  });
  return maskForRole(user.role, rows);
}
