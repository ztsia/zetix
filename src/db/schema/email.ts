import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { mailDirection, messagePurpose, outboxStatus } from './enums';
import { citext } from './types';
import { appUsers, players } from './people';
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

    /**
     * What the message is for (spec/v3.md §24.2). **The pending-message key**:
     * one pending message per addressee per purpose, whatever template words it.
     * No default — an insert that forgets it must fail, because a defaulted
     * purpose would make unrelated messages collide under the index below.
     */
    purpose: messagePurpose('purpose').notNull(),

    /**
     * How the purpose was worded. Null only for `REPLY`, which a person wrote
     * (spec/v3.md §26.6) — see `email_outbox_template_unless_reply`.
     */
    templateKey: text('template_key'),

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

    /**
     * Our own `Message-ID`, `<{id}.{random}@{sender-domain}>`, set when the
     * message is sent (spec/v3.md §26.2). Bounces and replies are matched back
     * through it, so it is unique.
     */
    messageId: text('message_id'),

    /**
     * The message that replaced this one (spec/v3.md §24.2). Drafting again for
     * a purpose cancels the pending draft and points it here, so switching
     * template can never send twice and the history says why it was cancelled.
     */
    supersededById: fk('superseded_by_id'),

    /** Set by the inbox with status `BOUNCED` (spec/v3.md §26.4). */
    bouncedAt: timestamp('bounced_at', { withTimezone: true }),
    /** The DSN's status code, e.g. `5.1.1`. */
    bounceCode: text('bounce_code'),
    /** The DSN's diagnostic text, as the receiving server wrote it. */
    bounceDetail: text('bounce_detail'),

    /** For a `REPLY`: the inbound message it answers, whose headers it threads under. */
    inReplyToMessageId: fk('in_reply_to_message_id').references(
      (): AnyPgColumn => emailMessages.id,
      { onDelete: 'set null' },
    ),

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
     *
     * **V3 keys it on `purpose`, not `template_key`** (spec/v3.md §24.2,
     * decision 52). Per template, a redraft under a different template did not
     * conflict with the first draft, so both sent. `REPLY` is left out: two
     * replies a person wrote are two messages, and superseding the first would
     * silently throw away something a human composed.
     */
    uniqueIndex('outbox_no_duplicate_pending')
      .on(t.registrationId, t.purpose)
      .where(sql`status in ('DRAFT', 'QUEUED', 'SENDING') and purpose <> 'REPLY'`),

    /**
     * The same guarantee for the one player-addressed template, over the same
     * pending statuses (`modules-v2.md` §3.1). Two indexes rather than one on
     * `coalesce(...)`: each is total over the rows it covers, and neither can be
     * defeated by a null the other was supposed to catch.
     */
    uniqueIndex('outbox_no_duplicate_pending_player')
      .on(t.playerId, t.purpose)
      .where(sql`status in ('DRAFT', 'QUEUED', 'SENDING') and purpose <> 'REPLY'`),

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

    /**
     * Every purpose but `REPLY` is worded by a template. A reply is written by
     * a person and has none (spec/v3.md §26.6).
     */
    check(
      'email_outbox_template_unless_reply',
      sql`template_key is not null or purpose = 'REPLY'`,
    ),

    uniqueIndex('email_outbox_message_id_key').on(t.messageId),

    foreignKey({
      name: 'email_outbox_superseded_by_fk',
      columns: [t.supersededById],
      foreignColumns: [t.id],
    }).onDelete('set null'),

        /** The dispatcher's own query: what is due, oldest first (spec/email.md §11.2). */
    index('email_outbox_status_scheduled_idx').on(t.status, t.scheduledFor),
    index('email_outbox_registration_idx').on(t.registrationId),
    index('email_outbox_player_idx').on(t.playerId),
  ],
);

/**
 * `email_threads` — one party's conversation (spec/v3.md §26.5): its outbound
 * messages, inbound replies and bounces, in order.
 *
 * **Addressed exactly as the outbox is**, and for the same reason: a thread
 * belongs to a registration, or — for the notes digest — to a player, never to
 * both and never to neither (decision 22). One thread per addressee, so the
 * record's Conversation tab is one query.
 *
 * Only threads the system started exist (§26.1): mail that matches no system
 * message is never stored, so there is no thread without an addressee.
 */
export const emailThreads = pgTable(
  'email_threads',
  {
    id: pk(),
    registrationId: fk('registration_id').references(() => registrations.id, {
      onDelete: 'cascade',
    }),
    playerId: fk('player_id').references(() => players.id, { onDelete: 'cascade' }),
    /** The newest message either way, so the Inbox lists threads newest first without a join. */
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('email_threads_registration_key').on(t.registrationId),
    uniqueIndex('email_threads_player_key').on(t.playerId),
    check('email_threads_one_addressee', sql`num_nonnulls(registration_id, player_id) = 1`),
    index('email_threads_last_message_idx').on(t.lastMessageAt),
  ],
);

/**
 * `email_messages` — one stored message, inbound or outbound (spec/v3.md §26).
 *
 * Outbound rows carry `outbox_id` — ours, sent by the dispatcher — or none, for
 * a reply someone wrote in Gmail itself and the sync read from Sent Mail
 * (§26.3). Inbound rows are replies and delivery-status notifications; a bounce
 * is `is_bounce` and points its `outbox_id` at the message it bounced.
 *
 * `message_id` is unique so a sync that reads the same message twice — from
 * INBOX and from Sent Mail, or on a retried tick — stores it once.
 *
 * `html` is **sanitised before it is stored**. It is mail from strangers and it
 * is rendered in the admin console; storing it raw would make every reader
 * responsible for a sanitiser it might forget.
 *
 * `handled_at` is what clears `REPLY_WAITING` (§26.5): an admin replied, or
 * marked the reply handled.
 */
export const emailMessages = pgTable(
  'email_messages',
  {
    id: pk(),
    threadId: fk('thread_id')
      .notNull()
      .references(() => emailThreads.id, { onDelete: 'cascade' }),
    direction: mailDirection('direction').notNull(),
    outboxId: fk('outbox_id').references((): AnyPgColumn => emailOutbox.id, {
      onDelete: 'set null',
    }),

    messageId: text('message_id'),
    inReplyTo: text('in_reply_to'),
    /** The `References` header, split. Not called `references` — a reserved word in SQL. */
    referenceIds: text('reference_ids').array(),

    fromEmail: citext('from_email'),
    fromName: text('from_name'),
    toEmail: citext('to_email'),
    subject: text('subject'),
    text: text('text'),
    html: text('html'),

    /** A delivery-status notification rather than a person writing (§26.4). */
    isBounce: boolean('is_bounce').notNull().default(false),

    /** When the message was sent, by its own `Date` header or our send time. */
    messageAt: timestamp('message_at', { withTimezone: true }).notNull(),

    /** Where the sync found it, for re-reading; null for a row written at send time. */
    folder: text('folder'),
    /** IMAP UIDs are unsigned 32-bit, past `integer`'s range. */
    uid: bigint('uid', { mode: 'number' }),

    handledAt: timestamp('handled_at', { withTimezone: true }),
    handledBy: uuid('handled_by').references(() => appUsers.id, { onDelete: 'set null' }),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('email_messages_message_id_key').on(t.messageId),
    index('email_messages_thread_idx').on(t.threadId, t.messageAt),
    index('email_messages_outbox_idx').on(t.outboxId),
  ],
);

/**
 * `mail_sync_state` — the IMAP cursor per folder (spec/v3.md §26.3).
 *
 * A sync reads UIDs above `last_uid`. IMAP UIDs are only meaningful within one
 * `uid_validity`; when the server reports a different one the cursor is void
 * and the folder is re-read from the fallback window, never trusted.
 */
export const mailSyncState = pgTable(
  'mail_sync_state',
  {
    id: pk(),
    folder: text('folder').notNull(),
    uidValidity: bigint('uid_validity', { mode: 'number' }),
    lastUid: bigint('last_uid', { mode: 'number' }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastError: text('last_error'),
    ...timestamps,
  },
  (t) => [uniqueIndex('mail_sync_state_folder_key').on(t.folder)],
);
