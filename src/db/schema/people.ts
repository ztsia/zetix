import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { userRole } from './enums';
import { citext } from './types';
import { concerts } from './concerts';
import { shows, showSegments } from './shows';
import { createdAt, fk, pk, timestamps } from './columns';

/**
 * `app_users` — backed by Supabase Auth (spec/domain.md §5.1).
 *
 * `id` **is** the `auth.users.id`, which is why this is the one table in the
 * schema keyed by uuid rather than a bigint identity. Every column elsewhere
 * that names a person (`created_by`, `actor_id`, `operator_id`, …) follows it.
 *
 * Two very different populations share the table (decisions 20 and 50):
 *
 * - **Named console accounts**, `ADMIN` or read-only `VIEWER`, each a committee
 *   member signing in with email and password, provisioned from Settings ›
 *   People (spec/v3.md §28). V1's single shared admin (decision 19) is gone.
 * - **Many `OPERATOR`s**, provisioned from the admin UI, one per usher, scoped
 *   to assigned shows.
 *
 * There is no sign-up flow, so the first ADMIN cannot be created through the
 * UI — `scripts/bootstrap-admin.ts` does it from the environment, and is also
 * the way back in if every admin is locked out (spec/local.md §5).
 */
export const appUsers = pgTable('app_users', {
  id: uuid('id').primaryKey(),
  email: citext('email').notNull(),
  displayName: text('display_name'),
  role: userRole('role').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

/**
 * `operator_show_assignments` — which ushers may see which shows.
 *
 * This table is the authorization boundary for the check-in manifest, which is
 * the full attendee roster: the endpoint must verify assignment *before*
 * returning data, and RLS must independently make the same request impossible
 * (decision 20, spec/checkin.md §12.3, §14.3).
 *
 * `ADMIN` ignores this table entirely and sees every show. An operator with no
 * assignments logs in and sees an empty show list — correct behaviour for an
 * account created but not yet rostered, not an error.
 */
export const operatorShowAssignments = pgTable(
  'operator_show_assignments',
  {
    id: pk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUsers.id, { onDelete: 'cascade' }),
    showId: fk('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' }),
    assignedBy: uuid('assigned_by').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
    ...createdAt,
  },
  (t) => [
    uniqueIndex('operator_show_assignments_user_show_key').on(t.userId, t.showId),
    /** "Who is rostered on this show" — the operator provisioning screen (spec/checkin.md §12.4). */
    index('operator_show_assignments_show_idx').on(t.showId),
  ],
);

/**
 * `players` — a performer, scoped to a concert (spec/domain.md §5.1).
 *
 * A player consumes zero seats in the player segment of their own show — they
 * are on stage (decision 3). `invite_token` is unguessable and is how a player
 * reaches their own registration link without an account.
 */
export const players = pgTable(
  'players',
  {
    id: pk(),
    concertId: fk('concert_id')
      .notNull()
      .references(() => concerts.id, { onDelete: 'cascade' }),
    fullName: text('full_name').notNull(),
    email: citext('email'),
    instrument: text('instrument'),
    section: text('section'),
    inviteToken: text('invite_token').notNull(),

    /**
     * Deactivating a player removes their base entitlement from the segment
     * total, which is one of the three mutations the §7.4 guard watches — the
     * other direction, reactivating, is what the guard blocks.
     */
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    /**
     * §5.1 writes this as `unique (concert_id, lower(email))`. `email` is
     * `citext`, so a plain unique already is that, with the case-folding in the
     * type rather than repeated in every index and query.
     */
    uniqueIndex('players_concert_email_key').on(t.concertId, t.email),
    uniqueIndex('players_invite_token_key').on(t.inviteToken),
  ],
);

/**
 * `player_allocations` — player × segment → quota override.
 *
 * Quota is uniform across players in practice, so the admin UI edits it at
 * segment level and this table usually stays empty. The per-player override
 * column exists because it costs one nullable column now and removes a
 * migration later (decision 2). Null resolves up the cascade like every other
 * operational value.
 */
export const playerAllocations = pgTable(
  'player_allocations',
  {
    id: pk(),
    playerId: fk('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    segmentId: fk('segment_id')
      .notNull()
      .references(() => showSegments.id, { onDelete: 'cascade' }),
    baseQuotaOverride: integer('base_quota_override'),
    notes: text('notes'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('player_allocations_player_segment_key').on(t.playerId, t.segmentId),
    /** "Every override in this segment" — the §7.4 guard's own query. */
    index('player_allocations_segment_idx').on(t.segmentId),
  ],
);
