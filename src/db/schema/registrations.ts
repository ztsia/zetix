import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  allocationType,
  bookingStatus,
  formKind,
  formStatus,
  nameSource,
  registrationSource,
  ticketSentSource,
} from './enums';
import { citext } from './types';
import { appUsers, players } from './people';
import { importBatches } from './imports';
import { shows, showSegments } from './shows';
import { ticketTemplates } from './tickets';
import { fk, pk, timestamps } from './columns';

/**
 * `registration_forms` — one active form per round, per segment
 * (spec/domain.md §5.1, spec/v2.md §8.2).
 *
 * A registration form belongs to a segment, and `kind` must agree with that
 * segment's `audience_mode`. A second registration round is a new form on the
 * same segment with a new `round_label`.
 *
 * **A `FEEDBACK` form belongs to a show instead** and creates no seats at all
 * (spec/v2.md §13.5), which is why both parents are nullable and a check
 * constraint picks exactly one of them from `kind`.
 *
 * V1 does not render these — registration for this concert ran on Google Forms
 * and arrived through import (decision 9). The table existed before V2 needed
 * it, which is why this migration adds columns rather than reshaping anything
 * (spec/README.md §4.2).
 */
export const registrationForms = pgTable(
  'registration_forms',
  {
    id: pk(),

    /**
     * Nullable since V2: a `FEEDBACK` form hangs off `show_id` instead. The
     * check constraint below is what keeps "exactly one parent" true rather
     * than merely intended.
     */
    segmentId: fk('segment_id').references(() => showSegments.id, { onDelete: 'cascade' }),

    /** The other parent. Set for `FEEDBACK` forms and null for the other two. */
    showId: fk('show_id').references(() => shows.id, { onDelete: 'cascade' }),

    /**
     * Which system blocks are pre-built into this form (spec/v2.md §8.2,
     * decision 35). There is no mapping step anywhere in V2, and this column is
     * the front of that guarantee.
     */
    kind: formKind('kind').notNull(),

    roundLabel: text('round_label'),
    title: text('title').notNull(),
    descriptionMd: text('description_md'),
    slug: text('slug').notNull(),
    schema: jsonb('schema'),

    /**
     * Bumped on every save, so a response can pin the schema it was answered
     * against (spec/v2.md §8.2.4) — the same pattern, for the same reason, as
     * pinning a ticket's template version (spec/tickets.md §10.5). Without it an
     * admin renaming a question retroactively changes what every earlier answer
     * meant.
     *
     * The default is 1 because a version counter starts somewhere; it is not an
     * operational value and nothing in spec/context.md sets it.
     */
    schemaVersion: integer('schema_version').notNull().default(1),

    opensAt: timestamp('opens_at', { withTimezone: true }),
    closesAt: timestamp('closes_at', { withTimezone: true }),
    maxResponses: integer('max_responses'),
    oneResponsePerIdentity: boolean('one_response_per_identity'),
    maxTicketsPerResponse: integer('max_tickets_per_response'),
    autoCloseOnCapacity: boolean('auto_close_on_capacity'),
    allowEditUntil: timestamp('allow_edit_until', { withTimezone: true }),
    confirmationMessageMd: text('confirmation_message_md'),
    status: formStatus('status').notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('registration_forms_slug_key').on(t.slug),
    index('registration_forms_segment_idx').on(t.segmentId),
    index('registration_forms_show_idx').on(t.showId),

    /**
     * **Exactly one parent, and `kind` says which** (spec/domain.md §5.1,
     * spec/v2.md §13.5).
     *
     * A `FEEDBACK` form attaches to a show; `PLAYER` and `PUBLIC` attach to a
     * segment, whose `audience_mode` they must agree with. Both halves are one
     * constraint because they are one rule: making `segment_id` nullable for
     * feedback's sake would otherwise let a player form exist with no segment at
     * all, and a registration form with no segment has nowhere to put its seats.
     *
     * The `audience_mode` half is not expressible cheaply here — it needs the
     * segment row — so it stays a handler check (`L`). What Postgres can settle,
     * it settles.
     */
    check(
      'registration_forms_one_parent',
      sql`case when kind = 'FEEDBACK'
                then show_id is not null and segment_id is null
                else segment_id is not null and show_id is null
           end`,
    ),
  ],
);

/**
 * `form_responses` — the exact submitted payload, never mutated
 * (spec/domain.md §5.1).
 *
 * `raw` is kept verbatim so a mapping mistake is always recoverable from what
 * the person actually typed, rather than from what we decided it meant.
 *
 * **An edit inserts a new row rather than mutating `raw`** (spec/v2.md §8.3.1),
 * chained through `supersedes_id`; the registration points at the newest. The
 * chain is the edit history, and it is what an admin reads when a registrant
 * disputes what they submitted.
 */
export const formResponses = pgTable(
  'form_responses',
  {
    id: pk(),
    formId: fk('form_id')
      .notNull()
      .references(() => registrationForms.id, { onDelete: 'cascade' }),
    raw: jsonb('raw').notNull(),

    /**
     * The schema as it stood at submit time (spec/v2.md §8.2.4).
     *
     * Not null for the same reason `raw` is not: a response whose schema is
     * unknown has lost what its answers *meant*, and the export builds its
     * columns from this rather than from the answers, so a null would silently
     * produce a row with nowhere to put it.
     */
    formSchema: jsonb('form_schema').notNull(),

    /**
     * The player id or the email — whatever `one_response_per_identity` means
     * for this form (spec/v2.md §8.3). Null when the form does not limit by
     * identity, which is why the unique index below is partial.
     *
     * **`citext`, not `text`.** §8.3 says "the lowercased email", and a `text`
     * column would leave that rule living in every handler that writes one:
     * `Ada@x.test` and `ada@x.test` would be two identities, the index would
     * not notice, and the form would take two responses from one person at
     * exactly the moment seats are scarce. The type is where this project
     * already puts case folding — `players.email` is `citext` for the same
     * reason, against a spec line that also said `lower(email)` — and the
     * schema freezes when this branch merges, so it is the type or nothing.
     *
     * A player id folds to itself, so the one column still serves both.
     */
    identityKey: citext('identity_key'),

    /** The response this edit replaces. Null starts a chain (spec/v2.md §8.3.1). */
    supersedesId: fk('supersedes_id'),

    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    editToken: text('edit_token'),
  },
  (t) => [
    index('form_responses_form_idx').on(t.formId),
    uniqueIndex('form_responses_edit_token_key').on(t.editToken),

    /** Self-reference, declared here because the table is not yet defined above. */
    foreignKey({
      name: 'form_responses_supersedes_fk',
      columns: [t.supersedesId],
      foreignColumns: [t.id],
    }).onDelete('set null'),

    /**
     * **What makes `one_response_per_identity` real** (spec/v2.md §8.3,
     * spec/domain.md §5.1).
     *
     * A read-then-write check in the handler is a race at precisely the moment
     * scarce seats attract double-clicks — the same reasoning that makes
     * `claim_seats()` a Postgres function rather than application code. Partial,
     * because a form that does not limit by identity writes null here and null
     * must not conflict with null.
     */
    uniqueIndex('form_responses_identity_key')
      .on(t.formId, t.identityKey)
      .where(sql`identity_key is not null`),
  ],
);

/**
 * `registrations` — a booking party (spec/domain.md §5.1).
 *
 * One registration is one party of N in **both** audiences: one email, N
 * `qr_token`s, N PDFs. There is no shared "admits 4" QR (decision 31).
 *
 * It carries **both** `show_id` and `segment_id` because almost every query
 * filters on one or the other. That denormalisation is made safe by a composite
 * foreign key rather than a trigger — see the constraint below (decision 27).
 */
export const registrations = pgTable(
  'registrations',
  {
    id: pk(),
    showId: fk('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' }),
    segmentId: fk('segment_id').notNull(),
    roundLabel: text('round_label'),

    playerId: fk('player_id').references(() => players.id, {
      onDelete: 'set null',
    }),
    formResponseId: fk('form_response_id').references(() => formResponses.id, {
      onDelete: 'set null',
    }),
    importBatchId: fk('import_batch_id').references(() => importBatches.id, {
      onDelete: 'set null',
    }),
    source: registrationSource('source').notNull(),

    contactName: text('contact_name').notNull(),
    contactEmail: citext('contact_email'),
    contactPhone: text('contact_phone'),

    /**
     * The queryable copy of this party's answers to `CUSTOM` blocks
     * (spec/v2.md §8.2.3).
     *
     * **It duplicates `form_responses.raw` on purpose.** `raw` is the immutable
     * receipt and exists only for `source = FORM`; an admin table or an export
     * reading it would show blanks for every imported and admin-created
     * registration, which is most of them. This is what screens, filters and
     * exports read; `raw` is what a dispute is settled from.
     */
    custom: jsonb('custom'),

    status: bookingStatus('status').notNull(),

    /**
     * **Verification gates the email, never the seat** (spec/v2.md §8.1.4).
     *
     * A public registration is `CONFIRMED` the moment it is submitted, because
     * seats are scarce and holding them for an unclicked link would give them
     * away. This timestamp decides only whether the ticket email is released:
     * an unverified registration is visible in admin, holds its seats, and is
     * excluded from the blast's eligible set until it verifies or an admin
     * overrides.
     *
     * Player forms do not verify — the address came from the roster, not from a
     * stranger typing it. Imported registrations skip it entirely: they never
     * received a link, and holding their tickets behind one would strand them
     * (spec/import.md §9.4). Neither case is expressed here; both are the
     * handler declining to set a token at all.
     */
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),

    /**
     * Unguessable, unique, and nullable — exactly like `players.invite_token`,
     * which is the same kind of secret reached by URL. Null for every
     * registration that is not gated.
     */
    verificationToken: text('verification_token'),

    /**
     * **The FCFS ordering key** (spec/allocation.md §7.4). The form submission
     * time, or for imports the original Google Form response timestamp — never
     * `created_at`. An import run a week later must preserve the order people
     * actually asked in, and with two registration rounds that matters more,
     * not less.
     */
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),

    createdBy: uuid('created_by').references(() => appUsers.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (t) => [
    /**
     * A registration can only sit in a segment that genuinely belongs to its
     * show. Postgres enforces it against `show_segments (id, show_id)` with no
     * trigger and no application check (spec/domain.md §5.2, decision 27).
     */
    foreignKey({
      name: 'registrations_segment_fk',
      columns: [t.segmentId, t.showId],
      foreignColumns: [showSegments.id, showSegments.showId],
    }).onDelete('cascade'),

    /**
     * Exists so `attendees` can carry the composite FK below (spec/domain.md
     * §5.2). A `unique` constraint rather than a unique index, for the same
     * reason as `show_segments_id_show_key`.
     */
    unique('registrations_id_segment_show_key').on(t.id, t.segmentId, t.showId),

    /** The extras review walk: strict FCFS within one segment (spec/allocation.md §7.5). */
    index('registrations_segment_status_requested_idx').on(t.segmentId, t.status, t.requestedAt),
    index('registrations_show_status_idx').on(t.showId, t.status),
    index('registrations_player_idx').on(t.playerId),

    uniqueIndex('registrations_verification_token_key').on(t.verificationToken),

    /**
     * **A party is imported once, however many times the sheet is re-uploaded**
     * (spec/import.md §9.2, decision 33).
     *
     * A Google Forms export is cumulative: the round 2 download is round 1 plus
     * the new responses. `(contact_email, requested_at)` is the pair §9.2 groups
     * a party on, and the only identity of a party that survives outside the
     * file — `requested_at` is the form response timestamp, not import time.
     *
     * `fix/import-reimport-dedup` closed this in application code with the show
     * row lock, and QA correctly pointed out that the index is the stronger
     * guarantee. It was deferred only because a migration before 19 Sep meant a
     * manual deployment step; that reason expired with the concert
     * (`modules-v2.md` §6).
     *
     * **Despite the name, it governs every source, not just `IMPORT`.** The
     * archived SQL is unconditional and is carried verbatim, which is the right
     * call — a public form double-submit and an admin creating the same party
     * twice are the same mistake as a re-uploaded sheet, and refusing all three
     * is better than refusing one. The cost is the error an admin sees: a raw
     * `duplicate key … "registrations_no_duplicate_import"` on a path that is
     * not an import. Mapping that to a sentence belongs to whichever screen
     * raises it, not here; `tests/schema/v2-delta.test.ts` pins the behaviour so
     * it is a known property rather than a surprise.
     *
     * Partial on `deleted_at is null`, because a delete means the row should
     * never have existed (spec/allocation.md §7.6) and an export still carrying
     * it is bringing in something genuinely absent. A *cancelled* party still
     * counts as imported and is still covered here — cancellation is an admin
     * decision about a registration that exists, and it can be restored (§7.9).
     *
     * A party with no `contact_email` is not covered: two nulls never conflict
     * in Postgres, which is the same known limit the code path has.
     */
    uniqueIndex('registrations_no_duplicate_import')
      .on(t.segmentId, t.contactEmail, t.requestedAt)
      .where(sql`deleted_at is null`),
  ],
);

/**
 * `attendees` — one row per seat, one ticket, one QR (spec/domain.md §5.1).
 *
 * An attendee with no name is not an error: it tickets as a placeholder
 * (decision 32). Guest email is optional, which is precisely why email is
 * addressed to the registration and never to a seat (decision 22).
 */
export const attendees = pgTable(
  'attendees',
  {
    id: pk(),
    registrationId: fk('registration_id').notNull(),
    showId: fk('show_id').notNull(),
    segmentId: fk('segment_id').notNull(),

    /**
     * Not null: §5.1 marks only `email` as nullable here, and an unnamed
     * attendee gets the generated placeholder "Guest of {contact_name}" rather
     * than a null (decision 32, spec/v2.md §8.2.1). The door searches this
     * string and the renderer prints it; a null finds nobody and prints blank.
     */
    fullName: text('full_name').notNull(),
    nameSource: nameSource('name_source').notNull(),
    email: citext('email'),

    /**
     * This seat's own answers to custom fields inside a repeater
     * (spec/v2.md §8.2.3) — "any dietary requirements?" asked once per guest
     * rather than once per party. The queryable copy, for the same reason as
     * `registrations.custom`.
     */
    custom: jsonb('custom'),

    /** BASE and EXTRA drive the §7.2 pool arithmetic; HELD and COMP sit outside it. */
    allocationType: allocationType('allocation_type').notNull(),

    /** Human-readable, printed on the ticket, typed at the door (spec/tickets.md §10.1). */
    ticketCode: text('ticket_code'),

    /**
     * 128 bits of CSPRNG entropy, and the only thing inside the QR.
     * **Immutable for the life of the attendee** — reissuing re-renders the PDF
     * and may repin the template version, but never mints a new token, because
     * a guest who kept the printed first copy must still get through the door
     * (decision 28, spec/tickets.md §10.1 rule 3).
     */
    qrToken: text('qr_token'),

    status: bookingStatus('status').notNull(),

    ticketIssuedAt: timestamp('ticket_issued_at', { withTimezone: true }),

    /**
     * **The per-seat delivery truth and the dedup key for repeat blasts**
     * (spec/email.md §11.4). Set only on confirmed delivery — a successful send,
     * or an admin marking it delivered by hand — never on queueing. Cancelling
     * never clears it: a ticket that was delivered was delivered, and the door
     * needs to know the code exists so it can say "cancelled — refer to desk"
     * rather than "not found" (spec/allocation.md §7.9).
     */
    ticketSentAt: timestamp('ticket_sent_at', { withTimezone: true }),
    ticketSentSource: ticketSentSource('ticket_sent_source'),

    /** Set when a field bound into the template changes after sending (spec/tickets.md §10.6). */
    needsReissue: boolean('needs_reissue').notNull().default(false),

    /**
     * Pinned at issue time and never re-read from the show or concert
     * (spec/tickets.md §10.5). Rendering always uses the pinned pair, so a later
     * template edit cannot silently change a ticket someone already holds.
     */
    ticketTemplateId: fk('ticket_template_id').references(() => ticketTemplates.id, {
      onDelete: 'set null',
    }),
    ticketTemplateVersion: integer('ticket_template_version'),

    ...timestamps,
  },
  (t) => [
    /**
     * An attendee cannot disagree with its registration about segment or show.
     * Moving a registration between segments updates parent and children in one
     * transaction; this constraint is what stops it being done by half
     * (spec/domain.md §5.2, decision 27).
     */
    foreignKey({
      name: 'attendees_registration_fk',
      columns: [t.registrationId, t.segmentId, t.showId],
      foreignColumns: [registrations.id, registrations.segmentId, registrations.showId],
    }).onDelete('cascade'),

    uniqueIndex('attendees_qr_token_key').on(t.qrToken),
    uniqueIndex('attendees_ticket_code_key').on(t.ticketCode),

    /**
     * Every capacity count in spec/allocation.md §7.2 runs against this index.
     * §5.1 names it as `(segment_id, status)`; `allocation_type` is appended
     * because `base_claimed(p)` filters on it as well, and a superset of the
     * specified index still serves every query the specified one would.
     */
    index('attendees_segment_status_idx').on(t.segmentId, t.status, t.allocationType),
    index('attendees_show_status_idx').on(t.showId, t.status),
    index('attendees_registration_idx').on(t.registrationId),
    index('attendees_template_idx').on(t.ticketTemplateId),
  ],
);
