import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { moderationStatus, wallStatus } from './enums';
import { concerts } from './concerts';
import { appUsers, players } from './people';
import { attendees } from './registrations';
import { shows } from './shows';
import { fk, pk, timestamps } from './columns';

/**
 * `portal_notes` — a note from an attendee, optionally addressed to a player
 * (spec/domain.md §5.1, spec/v2.md §13.4).
 *
 * **V2 builds this; V1 only carries the table** so the schema needs no
 * reshaping later (spec/README.md §4.2). Per-player grouping is always
 * admin-only; publishing to the public wall is always an explicit admin action
 * (decision 6).
 */
export const portalNotes = pgTable(
  'portal_notes',
  {
    id: pk(),
    concertId: fk('concert_id')
      .notNull()
      .references(() => concerts.id, { onDelete: 'cascade' }),
    showId: fk('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' }),
    attendeeId: fk('attendee_id')
      .notNull()
      .references(() => attendees.id, { onDelete: 'cascade' }),
    toPlayerId: fk('to_player_id').references(() => players.id, {
      onDelete: 'set null',
    }),

    displayName: text('display_name'),
    isAnonymous: boolean('is_anonymous').notNull().default(false),
    body: text('body').notNull(),

    moderationStatus: moderationStatus('moderation_status').notNull(),
    wallStatus: wallStatus('wall_status').notNull(),

    moderatedBy: uuid('moderated_by').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
    moderatedAt: timestamp('moderated_at', { withTimezone: true }),

    ...timestamps,
  },
  (t) => [
    /** "One note per attendee", enforced by the database (spec/domain.md §5.2). */
    uniqueIndex('portal_notes_attendee_key').on(t.attendeeId),
    index('portal_notes_concert_moderation_idx').on(t.concertId, t.moderationStatus),
    index('portal_notes_to_player_idx').on(t.toPlayerId),
    index('portal_notes_concert_wall_idx').on(t.concertId, t.wallStatus),
  ],
);
