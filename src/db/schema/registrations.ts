import {
  boolean,
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
 * A form belongs to a segment, and the segment's `audience_mode` decides which
 * form type renders. A second registration round is a new form on the same
 * segment with a new `round_label`.
 *
 * V1 does not render these — registration for this concert runs on Google Forms
 * and arrives through import (decision 9). The table exists now so V2 reshapes
 * nothing (spec/README.md §4.2).
 */
export const registrationForms = pgTable(
  'registration_forms',
  {
    id: pk(),
    segmentId: fk('segment_id')
      .notNull()
      .references(() => showSegments.id, { onDelete: 'cascade' }),
    roundLabel: text('round_label'),
    title: text('title').notNull(),
    descriptionMd: text('description_md'),
    slug: text('slug').notNull(),
    schema: jsonb('schema'),
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
  ],
);

/**
 * `form_responses` — the exact submitted payload, never mutated
 * (spec/domain.md §5.1).
 *
 * `raw` is kept verbatim so a mapping mistake is always recoverable from what
 * the person actually typed, rather than from what we decided it meant.
 */
export const formResponses = pgTable(
  'form_responses',
  {
    id: pk(),
    formId: fk('form_id')
      .notNull()
      .references(() => registrationForms.id, { onDelete: 'cascade' }),
    raw: jsonb('raw').notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    editToken: text('edit_token'),
  },
  (t) => [
    index('form_responses_form_idx').on(t.formId),
    uniqueIndex('form_responses_edit_token_key').on(t.editToken),
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

    status: bookingStatus('status').notNull(),

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

    fullName: text('full_name'),
    nameSource: nameSource('name_source').notNull(),
    email: citext('email'),

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
