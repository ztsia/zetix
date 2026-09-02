import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { audienceMode, extrasPolicy, portalUnlockMode, showStatus } from './enums';
import { concerts } from './concerts';
import { ticketTemplates } from './tickets';
import { fk, pk, timestamps } from './columns';

/**
 * `shows` — one hall on one night (spec/domain.md §5.1).
 *
 * The show owns the **physical room**: how many bodies fit, and the door. It
 * carries no audience mode — that belongs to the segment, because one hall on
 * one night can hold a public block and a player-invited block at the same time
 * (decision 5, spec/allocation.md §7.1).
 *
 * **One capacity, not three.** No soft threshold and no `held_seats` column:
 * seats you want to withhold are simply seats you give to no segment. If the
 * hall is 400 and the segments total 390, ten seats are held (decision 21).
 */
export const shows = pgTable(
  'shows',
  {
    id: pk(),
    concertId: fk('concert_id')
      .notNull()
      .references(() => concerts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),

    /** Stored UTC, rendered in `concert.timezone`, never the viewer's (spec/domain.md §6.1). */
    startsAt: timestamp('starts_at', { withTimezone: true }),
    doorsOpenAt: timestamp('doors_open_at', { withTimezone: true }),

    venueName: text('venue_name'),
    venueAddress: text('venue_address'),

    /**
     * The hall. Nullable because it cascades like every other operational value
     * and has no code default (spec/README.md §2.1); null means "not set here",
     * never zero. Read it through `resolveSetting`, never directly.
     */
    capacity: integer('capacity'),

    portalUnlockMode: portalUnlockMode('portal_unlock_mode'),
    status: showStatus('status').notNull(),

    /**
     * Nullable so a concert can set one template for all its shows and a single
     * show can override it. Resolves show → concert (`ticket.default_template_id`)
     * → the seeded global default. Never read this column directly
     * (spec/domain.md §5.1).
     */
    ticketTemplateId: fk('ticket_template_id').references(() => ticketTemplates.id, {
      onDelete: 'set null',
    }),

    ...timestamps,
  },
  (t) => [index('shows_concert_idx').on(t.concertId)],
);

/**
 * `show_segments` — a slice of one show's capacity with its own audience model
 * (spec/domain.md §5.1, spec/allocation.md §7.1).
 *
 * **This is where allocation happens.** Every formula in spec/allocation.md §7.2
 * is evaluated per segment, never per show; the show-level check is only that
 * the segments fit inside the hall.
 *
 * Segments do not borrow from each other automatically. When the player segment
 * closes with unclaimed seats and public demand remains, an admin moves the
 * numbers explicitly and it is logged (spec/allocation.md §7.7). Automatic
 * borrowing would make the number of people arriving at the door
 * unpredictable — the one number front of house needs to trust.
 */
export const showSegments = pgTable(
  'show_segments',
  {
    id: pk(),
    showId: fk('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    audienceMode: audienceMode('audience_mode').notNull(),

    /** This segment's slice of the hall. Cascades; no code default. */
    capacity: integer('capacity'),

    /** Seats each active player is entitled to. PLAYER_INVITED only. Cascades. */
    baseQuota: integer('base_quota'),

    /** After this, unclaimed base releases into this segment's extras pool (§7.2). */
    baseClaimDeadline: timestamp('base_claim_deadline', { withTimezone: true }),

    extrasPolicy: extrasPolicy('extras_policy'),
    allowPartialGrant: boolean('allow_partial_grant'),
    maxTicketsPerResponse: integer('max_tickets_per_response'),

    displayOrder: integer('display_order').notNull().default(0),

    ...timestamps,
  },
  (t) => [
    /** At most one segment per audience mode per show (spec/domain.md §5.1). */
    uniqueIndex('show_segments_show_audience_key').on(t.showId, t.audienceMode),

    /**
     * Exists only so `registrations` can carry a composite foreign key on
     * `(segment_id, show_id)` — the constraint that makes it impossible for a
     * registration to sit in a segment belonging to a different show
     * (spec/domain.md §5.2, decision 27).
     *
     * A `unique` **constraint**, not a unique index: Postgres will only point a
     * foreign key at a non-deferrable unique or primary key constraint, and
     * rejects a bare unique index with "there is no unique constraint matching
     * given keys". Drizzle emits a constraint for `unique()` and an index for
     * `uniqueIndex()`, and only the former is inlined into `create table`,
     * which also puts it before the `alter table … add foreign key` that needs
     * it.
     */
    unique('show_segments_id_show_key').on(t.id, t.showId),
  ],
);
