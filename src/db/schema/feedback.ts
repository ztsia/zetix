import { index, jsonb, pgTable, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { attendees, registrationForms } from './registrations';
import { shows } from './shows';
import { fk, pk } from './columns';

/**
 * `feedback_responses` — one attendee's answers to a `FEEDBACK` form
 * (spec/domain.md §5.1, spec/v2.md §13.5).
 *
 * **One response per attendee, not per registration.** *"How was your
 * evening?"* is not a group answer, and a party of four that split up at the
 * interval has four of them — which is also why the audience is attendees with
 * a `check_ins` row rather than registrations with a sent ticket (§13.5.1). A
 * manual or override admission counts: those people were in the hall.
 *
 * It is deliberately **not** a `form_responses` row. That table is the receipt
 * of a *registration* — it carries `raw`, an edit chain and an `edit_token`,
 * and every one of its consumers assumes a registration hangs off it. Feedback
 * has none of that and is keyed by attendee, so sharing the table would mean a
 * nullable identity column on the very table `one_response_per_identity`
 * depends on.
 *
 * `answers` is what was submitted; `form_schema` pins the schema it was
 * answered against, exactly as `form_responses.form_schema` does and for the
 * same reason (spec/v2.md §8.2.4) — the export builds its columns from the
 * pinned schema, so a later edit to the form cannot reshape a download of
 * answers already given (§8.5).
 *
 * `show_id` is denormalised from the attendee because every admin query filters
 * on it. Unlike `registrations` and `attendees` it needs no composite foreign
 * key: nothing about a feedback row is counted against a capacity, so a
 * disagreement here is a listing bug rather than a silent oversell
 * (spec/domain.md §5.2).
 */
export const feedbackResponses = pgTable(
  'feedback_responses',
  {
    id: pk(),
    formId: fk('form_id')
      .notNull()
      .references(() => registrationForms.id, { onDelete: 'cascade' }),
    attendeeId: fk('attendee_id')
      .notNull()
      .references(() => attendees.id, { onDelete: 'cascade' }),
    showId: fk('show_id')
      .notNull()
      .references(() => shows.id, { onDelete: 'cascade' }),

    answers: jsonb('answers').notNull(),
    formSchema: jsonb('form_schema').notNull(),

    /**
     * `submitted_at` and `updated_at` only — this table carries no `created_at`
     * and no `deleted_at` (spec/domain.md §5.1). A response is written when it
     * is submitted and revised in place; there is nothing here to soft-delete
     * that deleting the attendee would not take with it.
     */
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** "One response per attendee" (spec/v2.md §13.5), enforced by the database. */
    uniqueIndex('feedback_responses_attendee_form_key').on(t.attendeeId, t.formId),
    index('feedback_responses_form_idx').on(t.formId),
    index('feedback_responses_show_idx').on(t.showId),
  ],
);
