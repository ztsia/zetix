import { formatInZone } from '@/lib/export';
import type { ResponseRow } from '../../queries';

/**
 * The response row as the table renders it, and the function that shapes one.
 *
 * **In a plain module on purpose.** This used to live beside the table, which
 * carries `'use client'` — so the server page importing it got a client
 * reference rather than a function, and calling it threw *"Attempted to call
 * responseRow() from the server but responseRow is on the client"*. The screen
 * returned a 500 the moment the form had a single response, and stayed green
 * with none, because `rows.map` never ran on an empty list. `pnpm test`,
 * `tsc`, `lint` and `build` were all clean with the page broken.
 *
 * A module with no directive is usable from both sides, which is what a
 * formatter that turns a database row into display text should be.
 */
export type ResponseTableRow = {
  id: number;
  submittedAt: string;
  identityKey: string | null;
  contactName: string | null;
  contactEmail: string | null;
  seats: number;
  superseded: boolean;
  isEdit: boolean;
  ipAddress: string | null;
};

/**
 * Formats one response for the table.
 *
 * The timestamp is rendered here, on the server, in the concert's zone rather
 * than the reader's (`CLAUDE.md`) — so the string the table shows and the
 * string the export writes come from the same call.
 */
export function responseRow(row: ResponseRow, timeZone: string): ResponseTableRow {
  return {
    id: row.id,
    submittedAt: formatInZone(row.submittedAt, timeZone),
    identityKey: row.identityKey,
    contactName: row.contactName,
    contactEmail: row.contactEmail,
    seats: row.seats,
    superseded: row.supersededById !== null,
    isEdit: row.supersedesId !== null,
    ipAddress: row.ipAddress,
  };
}
