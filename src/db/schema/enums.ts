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

/**
 * What a form *is*, and therefore which system blocks are pre-built into it
 * (spec/v2.md §8.2, decision 35).
 *
 * This is the whole of V2's mapping model: a block's destination is chosen when
 * the block is created, never mapped afterwards, and `kind` is what chooses.
 * `PLAYER` and `PUBLIC` attach to a segment and create seats; `FEEDBACK`
 * attaches to a **show**, creates none, and collapses its registrant block to
 * the identity the attendee's own `qr_token` already resolved
 * (spec/domain.md §5.1, spec/v2.md §13.5).
 */
export const formKind = pgEnum('form_kind', ['PLAYER', 'PUBLIC', 'FEEDBACK']);
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

/**
 * V3 adds `STAGED` — rows sit in `import_rows` as an editable grid and commit in
 * as many passes as it takes (spec/v3.md §25.7) — and `UNDONE`, for a batch the
 * Undo import command has reversed. `DRY_RUN` stays for V1/V2 batches.
 */
export const importStatus = pgEnum('import_status', ['DRY_RUN', 'COMMITTED', 'STAGED', 'UNDONE']);

export const outboxStatus = pgEnum('outbox_status', [
  'DRAFT',
  'QUEUED',
  'SENDING',
  'SENT',
  'FAILED',
  'CANCELLED',
  /**
   * V3. Terminal: the inbox matched a delivery-status notification to this
   * message (spec/v3.md §26.4). Set only by the inbox, never by the
   * dispatcher, and never a pending status.
   */
  'BOUNCED',
]);

/**
 * What a message is *for* (spec/v3.md §24.2). The template is only how the
 * purpose is worded; the pending-message key is `(addressee, purpose)`, so a
 * redraft under a different template supersedes the first rather than sending
 * alongside it (decision 52).
 *
 * There is deliberately no column default. A default purpose would make
 * unrelated messages collide under the pending index — a missing one must fail
 * the insert.
 */
export const messagePurpose = pgEnum('message_purpose', [
  'RECEIPT',
  'VERIFICATION',
  'TICKETS',
  'EXTRAS_DECISION',
  'CANCELLATION',
  'REMINDER',
  'FEEDBACK',
  'NOTES_DIGEST',
  'PLAYER_INVITE',
  'REPLY',
]);

/** One stored mail message, either way (spec/v3.md §26.5). */
export const mailDirection = pgEnum('mail_direction', ['INBOUND', 'OUTBOUND']);

/** Stored so a "Not a duplicate" decision sticks (spec/v3.md §25.5). */
export const duplicateStatus = pgEnum('duplicate_status', ['OPEN', 'MERGED', 'DISMISSED']);

/** A command run (spec/v3.md §23.1). Preview writes nothing, so it has no status. */
export const commandRunStatus = pgEnum('command_run_status', [
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);

/** One target of a command run: done, skipped with a reason, or failed. */
export const commandItemStatus = pgEnum('command_item_status', [
  'PENDING',
  'DONE',
  'SKIPPED',
  'FAILED',
]);

/**
 * A staged import row (spec/v3.md §25.7). "Blocked" is not a status — it is a
 * `STAGED` row with issues, derived from `issues` rather than stored, so it
 * cannot disagree with them.
 */
export const importRowStatus = pgEnum('import_row_status', ['STAGED', 'COMMITTED', 'SKIPPED']);

/**
 * What a staged row does when its email already holds a party in the segment
 * (spec/v3.md §25.7): add seats to it (the default the grid offers), skip, or
 * keep a separate party.
 */
export const importMatchAction = pgEnum('import_match_action', ['ADD_SEATS', 'SKIP', 'SEPARATE']);

/**
 * Named ADMIN and VIEWER accounts, many scoped OPERATORs (decision 50, which
 * reverses 19; spec/v3.md §28). `VIEWER` reads every admin screen, runs
 * nothing, and sees contact details masked.
 */
export const userRole = pgEnum('user_role', ['ADMIN', 'OPERATOR', 'VIEWER']);
