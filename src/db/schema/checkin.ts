import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { checkInSource } from './enums';
import { appUsers } from './people';
import { attendees } from './registrations';
import { shows, showSegments } from './shows';
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

/**
 * `walk_ins` — people admitted with no ticket and no roster row
 * (spec/v3.md §32.2, decision 58).
 *
 * **An event per tap, never a counter and never a fabricated registration.** A
 * counter cannot merge offline taps from several phones or undo one mistake; a
 * nullable `check_ins.attendee_id` would silently change every count that joins
 * attendees; a fake registration would drag walk-ins into allocation, Audience
 * and email. So a walk-in is its own row, and every count that wants the hall
 * adds them explicitly.
 *
 * `client_id` is minted on the phone at tap time and is the idempotency key: a
 * re-sent drain inserts `on conflict do nothing`, which `check_ins` (which has
 * no unique key to lean on) could never do.
 *
 * `admitted_at` is the phone's clock and `synced_at` the server's, for the same
 * reason `check_ins` keeps both (spec/checkin.md §12.3). A revert stamps
 * `reverted_at`, never deletes (decision 7).
 */
export const walkIns = pgTable(
  'walk_ins',
  {
    id: pk(),
    clientId: uuid('client_id').notNull(),
    showId: fk('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' }),
    /** Optional: the show owns the hall, so a walk-in normally belongs to no segment. */
    segmentId: fk('segment_id'),
    headcount: integer('headcount').notNull(),
    /** A name or a note, if the usher took one. "No name is OK." */
    label: text('label'),
    operatorId: uuid('operator_id').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
    deviceId: text('device_id'),
    admittedAt: timestamp('admitted_at', { withTimezone: true }).notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
    revertedAt: timestamp('reverted_at', { withTimezone: true }),
    revertedBy: uuid('reverted_by').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    uniqueIndex('walk_ins_client_id_key').on(t.clientId),
    index('walk_ins_show_admitted_idx').on(t.showId, t.admittedAt),
    check('walk_ins_headcount_positive', sql`${t.headcount} > 0`),
    /** A segment, when given, must be one of this show's. */
    foreignKey({
      name: 'walk_ins_segment_show_fk',
      columns: [t.segmentId, t.showId],
      foreignColumns: [showSegments.id, showSegments.showId],
    }).onDelete('cascade'),
  ],
);
