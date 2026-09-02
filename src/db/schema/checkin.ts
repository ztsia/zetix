import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { checkInSource } from './enums';
import { appUsers } from './people';
import { attendees } from './registrations';
import { shows } from './shows';
import { fk, pk } from './columns';

/**
 * `check_ins` — append-only scan log, per show (spec/domain.md §5.1,
 * spec/checkin.md §12).
 *
 * **Append-only and reversible, never destructive** (decision 7). A mistaken
 * scan is undone by stamping `reverted_at`, not by deleting the row, so the
 * night's history stays reconstructable afterwards.
 *
 * It needs no segment column — that derives from the attendee, and the
 * composite foreign key on `attendees` already guarantees the attendee agrees
 * with its registration about which show it belongs to (spec/domain.md §5.2).
 *
 * `scanned_at` is when the phone read the QR; `synced_at` is when the row
 * reached the server. They differ by however long the usher was offline, which
 * is the whole point of the offline queue (spec/checkin.md §12.2).
 */
export const checkIns = pgTable(
  'check_ins',
  {
    id: pk(),
    attendeeId: fk('attendee_id')
      .notNull()
      .references(() => attendees.id, { onDelete: 'cascade' }),
    showId: fk('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' }),
    operatorId: uuid('operator_id').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
    deviceId: text('device_id'),

    scannedAt: timestamp('scanned_at', { withTimezone: true }).notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }),
    source: checkInSource('source').notNull(),

    /** Why an usher admitted someone whose ticket scanned amber or red (spec/README.md §2.4). */
    overrideReason: text('override_reason'),

    revertedAt: timestamp('reverted_at', { withTimezone: true }),
    revertedBy: uuid('reverted_by').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    /** The live dashboard reads the night in scan order (spec/checkin.md §12.4). */
    index('check_ins_show_scanned_idx').on(t.showId, t.scannedAt),
    index('check_ins_attendee_idx').on(t.attendeeId),
  ],
);
