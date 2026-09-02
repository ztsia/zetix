import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { outboxStatus } from './enums';
import { citext } from './types';
import { registrations } from './registrations';
import { fk, pk, timestamps } from './columns';

/**
 * `email_outbox` — one row per *message*, and every message is addressed to a
 * registration (spec/domain.md §5.1, spec/email.md §11).
 *
 * **`registration_id` is not null, and that is load-bearing** (decision 22).
 * Every ticket-bearing email goes to a registrant: a player receives one
 * message carrying all their guests' PDFs, a public party receives theirs.
 * Guest email is optional, so an attendee is not reliably addressable at all.
 * Keying on a nullable `attendee_id` would also defeat the partial unique index
 * outright — two rows with a NULL key do not conflict in Postgres, so the
 * `on conflict do nothing` in spec/email.md §11.4 would silently do nothing for
 * exactly the player-invited audience, and a second click would queue every
 * player confirmation twice.
 *
 * `subject` and `body_md` hold the **rendered** message, not a template
 * reference, so an admin can edit any message before dispatch and the
 * dispatcher sends exactly what was reviewed (decision 23, spec/email.md §11.5).
 */
export const emailOutbox = pgTable(
  'email_outbox',
  {
    id: pk(),
    registrationId: fk('registration_id')
      .notNull()
      .references(() => registrations.id, { onDelete: 'cascade' }),
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

    /** The dispatcher's own query: what is due, oldest first (spec/email.md §11.2). */
    index('email_outbox_status_scheduled_idx').on(t.status, t.scheduledFor),
    index('email_outbox_registration_idx').on(t.registrationId),
  ],
);
