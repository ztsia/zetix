import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { outboxStatus } from './enums';
import { citext } from './types';
import { players } from './people';
import { registrations } from './registrations';
import { fk, pk, timestamps } from './columns';

/**
 * `email_outbox` — one row per *message*, and every message is addressed to a
 * registration (spec/domain.md §5.1, spec/email.md §11).
 *
 * **Every message has exactly one addressee, and that is load-bearing**
 * (decision 22, `modules-v2.md` §3.1).
 *
 * Every ticket-bearing email goes to a registrant: a player receives one
 * message carrying all their guests' PDFs, a public party receives theirs.
 * Guest email is optional, so an attendee is not reliably addressable at all.
 * Keying on a nullable `attendee_id` would also defeat the partial unique index
 * outright — two rows with a NULL key do not conflict in Postgres, so the
 * `on conflict do nothing` in spec/email.md §11.4 would silently do nothing for
 * exactly the player-invited audience, and a second click would queue every
 * player confirmation twice.
 *
 * **V2 adds the one exception, without weakening any of that.**
 * `player_notes_digest` is addressed to a *player*, who has no registration
 * (spec/email.md §11.3, spec/v2.md §13.4), so `registration_id` had to become
 * nullable to hold such a row. That is the exact move the warning above is
 * about — but the warning is about *swapping* the key for a nullable one, not
 * about adding a **disjoint second key**. So both keys stay total: a check
 * constraint requires exactly one of them, and each has its own partial unique
 * index over the same pending statuses. A registration-addressed row still
 * carries a non-null `registration_id`, and `outbox_no_duplicate_pending` bites
 * exactly as it did before.
 *
 * Without the check, a row with both keys null would conflict with nothing and
 * `on conflict do nothing` would silently do nothing — the failure the
 * non-negotiable exists to prevent, arriving by a different door.
 *
 * `subject` and `body_md` hold the **rendered** message, not a template
 * reference, so an admin can edit any message before dispatch and the
 * dispatcher sends exactly what was reviewed (decision 23, spec/email.md §11.5).
 */
export const emailOutbox = pgTable(
  'email_outbox',
  {
    id: pk(),
    /** Set for every message but `player_notes_digest`. See the check below. */
    registrationId: fk('registration_id').references(() => registrations.id, {
      onDelete: 'cascade',
    }),

    /** Set only for `player_notes_digest`, the one player-addressed email. */
    playerId: fk('player_id').references(() => players.id, { onDelete: 'cascade' }),

    templateKey: text('template_key').notNull(),

    toEmail: citext('to_email').notNull(),
    toName: text('to_name'),

    subject: text('subject').notNull(),
    bodyMd: text('body_md').notNull(),

    /** The merge values the body was rendered from, kept so a bad render is explainable. */
    context: jsonb('context'),
    attachmentPaths: jsonb('attachment_paths'),

    status: outboxStatus('status').notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),

    ...timestamps,
  },
  (t) => [
    /**
     * **What makes a repeat blast safe** (spec/email.md §11.4, decision 16).
     *
     * Only *pending* rows conflict, so a registration can legitimately be
     * emailed the same template again once the first message has SENT — that is
     * the added-guest case, and it is correct. What it stops is the admin who
     * is unsure whether their first click registered and clicks again.
     *
     * Do not omit it, and do not widen it: without this index the
     * `on conflict do nothing` in §11.4 is decoration.
     */
    uniqueIndex('outbox_no_duplicate_pending')
      .on(t.registrationId, t.templateKey)
      .where(sql`status in ('DRAFT', 'QUEUED', 'SENDING')`),

    /**
     * The same guarantee for the one player-addressed template, over the same
     * pending statuses (`modules-v2.md` §3.1). Two indexes rather than one on
     * `coalesce(...)`: each is total over the rows it covers, and neither can be
     * defeated by a null the other was supposed to catch.
     */
    uniqueIndex('outbox_no_duplicate_pending_player')
      .on(t.playerId, t.templateKey)
      .where(sql`status in ('DRAFT', 'QUEUED', 'SENDING')`),

    /**
     * **Exactly one addressee.** This is what keeps both keys total, and it is
     * the whole of §3.1's warning: without it a row with both keys null
     * conflicts with nothing, `on conflict do nothing` silently does nothing,
     * and a double-queued digest sends twice with no error anywhere.
     */
    check(
      'email_outbox_one_addressee',
      sql`num_nonnulls(registration_id, player_id) = 1`,
    ),

    /** The dispatcher's own query: what is due, oldest first (spec/email.md §11.2). */
    index('email_outbox_status_scheduled_idx').on(t.status, t.scheduledFor),
    index('email_outbox_registration_idx').on(t.registrationId),
    index('email_outbox_player_idx').on(t.playerId),
  ],
);
