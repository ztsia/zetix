'use server';

import { z } from 'zod';
import { getDb } from '@/db/client';
import { requireRole } from '@/lib/auth/guards';
import { maskForRole } from '@/lib/auth/mask';
import { idSchema, selectionSchema } from '@/lib/commands/selection';
import { exportMessages, type MessageRow } from '@/lib/delivery/messages';
import { messageFilterSchema } from '@/lib/delivery/message-filter';
import { EXPORT_INPUT_ERROR, type ExportResult } from '@/lib/export/sorting';

/**
 * The Messages list's export (spec/v3.md §32.1): the bounced and failed lists
 * are what an admin wants out, and no other screen exports these rows.
 *
 * The whole selection — the ticked messages across every page, or the tab and
 * search minus what was unticked — through the listing's own WHERE. `ADMIN`
 * only: the file carries every recipient's address.
 */
const inputSchema = z.object({
  concertId: idSchema,
  selection: selectionSchema(messageFilterSchema),
});

export async function exportMessagesAction(input: unknown): Promise<ExportResult<MessageRow>> {
  const user = await requireRole('ADMIN');
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { error: EXPORT_INPUT_ERROR };
  const { concertId, selection } = parsed.data;
  return maskForRole(user.role, await exportMessages(getDb(), concertId, selection));
}
