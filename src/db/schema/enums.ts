import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Every closed vocabulary in spec/domain.md §5.1, as a Postgres enum rather
 * than text plus a check constraint: the database rejects a typo, and Drizzle
 * gives the TypeScript side a union type for free.
 *
 * These are vocabularies, not operational values — none of them is a capacity,
 * quota, deadline or cap, so none of them is subject to the no-code-defaults
 * rule (spec/README.md §2.1). Where a *choice* between these values is
 * configurable — `extras_policy` — the column cascades and the value is data.
 */

export const concertStatus = pgEnum('concert_status', ['DRAFT', 'ACTIVE', 'ARCHIVED']);
export const showStatus = pgEnum('show_status', ['DRAFT', 'OPEN', 'CLOSED', 'COMPLETED']);
export const portalUnlockMode = pgEnum('portal_unlock_mode', [
  'ON_ADMISSION',
  'OPEN_TO_ALL',
  'CLOSED',
]);
export const publicWallVisibility = pgEnum('public_wall_visibility', ['ADMIN_ONLY', 'AUDIENCE']);

/**
 * Audience mode belongs to the segment, never to the show — one hall on one
 * night can hold a public block and a player-invited block side by side
 * (decision 5, spec/allocation.md §7.1).
 */
export const audienceMode = pgEnum('audience_mode', ['PLAYER_INVITED', 'PUBLIC']);
export const extrasPolicy = pgEnum('extras_policy', ['REVIEW', 'AUTO_FCFS']);

export const formStatus = pgEnum('form_status', ['DRAFT', 'OPEN', 'CLOSED']);
export const registrationSource = pgEnum('registration_source', ['FORM', 'IMPORT', 'ADMIN']);

/**
 * One status vocabulary shared by registrations and attendees. Two identical
 * enums would force a cast every time cancellation sets both in the same
 * statement (spec/allocation.md §7.9), and buys nothing: the values are the
 * same set and always have been.
 */
export const bookingStatus = pgEnum('booking_status', [
  'CONFIRMED',
  'PENDING_REVIEW',
  'WAITLIST',
  'CANCELLED',
]);

export const allocationType = pgEnum('allocation_type', ['BASE', 'EXTRA', 'HELD', 'COMP']);

/** An attendee with no name is not an error — it tickets as a placeholder (spec/v2.md §8.2.1, decision 32). */
export const nameSource = pgEnum('name_source', ['PROVIDED', 'PLACEHOLDER']);

/** How a ticket reached its holder. MANUAL is the hand-delivery escape hatch (spec/email.md §11.6, decision 24). */
export const ticketSentSource = pgEnum('ticket_sent_source', ['EMAIL', 'MANUAL']);

export const checkInSource = pgEnum('check_in_source', ['ONLINE', 'OFFLINE_SYNC', 'MANUAL']);
export const backgroundKind = pgEnum('background_kind', ['IMAGE', 'PDF', 'NONE']);

export const moderationStatus = pgEnum('moderation_status', ['PENDING', 'APPROVED', 'HIDDEN']);
export const wallStatus = pgEnum('wall_status', ['NOT_PUBLISHED', 'PUBLISHED']);

export const importStatus = pgEnum('import_status', ['DRY_RUN', 'COMMITTED']);

export const outboxStatus = pgEnum('outbox_status', [
  'DRAFT',
  'QUEUED',
  'SENDING',
  'SENT',
  'FAILED',
  'CANCELLED',
]);

/** One shared ADMIN, many scoped OPERATORs (decisions 19 and 20). */
export const userRole = pgEnum('user_role', ['ADMIN', 'OPERATOR']);
