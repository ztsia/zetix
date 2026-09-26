import { z } from 'zod';
import { PURPOSES } from './purposes';

/**
 * The Messages view's filter (spec/v3.md §24.4): every message the concert
 * has, all purposes and all statuses, as one server-paged table.
 *
 * Pure and client-safe, like the Audience filter: the page parses the URL with
 * it, and the Messages commands validate their `{ filter, excludedIds }`
 * selection with the same schema, so "select all N matching" means on the
 * server what the table showed.
 */

export const MESSAGE_STATUSES = [
  'DRAFT',
  'QUEUED',
  'SENDING',
  'SENT',
  'FAILED',
  'BOUNCED',
  'CANCELLED',
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const MESSAGE_STATUS_LABEL: Record<MessageStatus, string> = {
  DRAFT: 'Draft',
  QUEUED: 'Queued',
  SENDING: 'Sending',
  SENT: 'Sent',
  FAILED: 'Failed',
  BOUNCED: 'Bounced',
  CANCELLED: 'Cancelled',
};

/**
 * The exits per status (§24.4), the one table the view's menus and the
 * record's Conversation tab both read. `SENDING` has none: the dispatcher
 * resolves it.
 */
export const MESSAGE_EXITS: Record<MessageStatus, readonly MessageExit[]> = {
  DRAFT: ['edit', 'cancel', 'delete'],
  QUEUED: ['edit', 'cancel', 'delete'],
  SENDING: [],
  FAILED: ['retry', 'fix-address', 'edit', 'cancel', 'delete'],
  SENT: ['resend', 'delete'],
  BOUNCED: ['fix-address', 'delete'],
  CANCELLED: ['delete'],
};

export type MessageExit = 'edit' | 'cancel' | 'delete' | 'retry' | 'fix-address' | 'resend';

export const messageFilterSchema = z
  .object({
    status: z.enum(MESSAGE_STATUSES).optional(),
    purpose: z.enum(PURPOSES).optional(),
    search: z.string().trim().max(200).optional(),
    registrationId: z.number().int().positive().optional(),
  })
  .strict();

export type MessageFilter = z.infer<typeof messageFilterSchema>;

/** The view's URL keys, parsed leniently: an unknown value is dropped, not an error. */
export function parseMessageFilter(search: Record<string, string | string[] | undefined>): MessageFilter {
  const one = (key: string) => {
    const value = search[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const status = MESSAGE_STATUSES.find((s) => s === one('status'));
  const purpose = PURPOSES.find((p) => p === one('purpose'));
  const text = one('q')?.trim();
  return {
    ...(status ? { status } : {}),
    ...(purpose ? { purpose } : {}),
    ...(text ? { search: text.slice(0, 200) } : {}),
  };
}
