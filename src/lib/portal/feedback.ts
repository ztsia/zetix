import 'server-only';

import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { feedbackResponses } from '@/db/schema/feedback';
import { registrationForms } from '@/db/schema/registrations';
import { resolveFormCopy } from '@/lib/forms/resolve-copy';
import { parseFormSchema, type FormSchema } from '@/lib/forms/schema';
import type { CopyValues } from '@/lib/forms/copy';

/**
 * The feedback form a show's portal offers, and this attendee's answer to it
 * (spec/v2.md §13.5).
 *
 * **Found by show, not by slug.** `loadFormBySlug` serves `/f/{slug}`, where a
 * registrant arrives with a URL; here the guest arrives with a `qr_token` and
 * the form is whichever `FEEDBACK` form hangs off their show. That is the whole
 * reason `registration_forms.show_id` is nullable alongside `segment_id`
 * (`J`'s `registration_forms_one_parent`).
 *
 * **No seat blocks, so no seat arithmetic.** A `FEEDBACK` schema may carry only
 * `CUSTOM` blocks — the zod contract refuses anything else — so there are no
 * repeater caps to resolve and `segment_pool()` is never consulted. This is why
 * the loader is small: the expensive half of `loadFormBySlug` is entirely about
 * seats.
 */

export type PortalFeedbackForm = {
  id: number;
  schema: FormSchema;
  schemaVersion: number;
  title: string;
  descriptionMd: string | null;
  copy: CopyValues;
  /** This attendee's existing answer, if they have already left one. */
  existing: { id: number; answers: unknown } | null;
};

/**
 * Why the section is not being drawn, when it is not.
 *
 * `null` from the loader would collapse "this show runs no feedback form" and
 * "you have already answered" into one silence, and they need different copy —
 * the second is a thank-you.
 */
export type FeedbackUnavailable = { state: 'NONE' } | { state: 'CLOSED' };

export type PortalFeedbackResult = PortalFeedbackForm | FeedbackUnavailable;

export async function loadPortalFeedback(input: {
  showId: number;
  concertId: number;
  attendeeId: number;
  /** `portal.feedback_close_at`, already resolved through the cascade. */
  closeAt: Date | null;
  now?: Date;
}): Promise<PortalFeedbackResult> {
  const now = input.now ?? new Date();

  const [row] = await getDb()
    .select({
      id: registrationForms.id,
      schema: registrationForms.schema,
      schemaVersion: registrationForms.schemaVersion,
      title: registrationForms.title,
      descriptionMd: registrationForms.descriptionMd,
      status: registrationForms.status,
    })
    .from(registrationForms)
    .where(
      and(
        eq(registrationForms.showId, input.showId),
        eq(registrationForms.kind, 'FEEDBACK'),
      ),
    );

  if (!row) return { state: 'NONE' };

  /**
   * A `DRAFT` form is not shown, exactly as `loadFormBySlug` refuses one. An
   * admin building next month's questions must not have them appear on tonight's
   * portal.
   */
  if (row.status !== 'OPEN') return { state: 'NONE' };

  /**
   * **A closed form still renders, as a closed form.** The guest followed a link
   * from an email we sent them; "we have stopped collecting answers" is an
   * answer, and silence is not.
   */
  if (input.closeAt && now > input.closeAt) return { state: 'CLOSED' };

  const parsed = parseFormSchema(row.schema);
  /**
   * A schema that no longer parses is treated as no form at all, which is what
   * `loadFormBySlug` does for the same case and for the same reason: a guest can
   * do nothing about it, and half-rendering an invalid schema is how a form asks
   * a question it cannot store the answer to.
   */
  if (!parsed.ok) return { state: 'NONE' };

  const [existing] = await getDb()
    .select({ id: feedbackResponses.id, answers: feedbackResponses.answers })
    .from(feedbackResponses)
    .where(
      and(
        eq(feedbackResponses.attendeeId, input.attendeeId),
        eq(feedbackResponses.formId, row.id),
      ),
    );

  return {
    id: row.id,
    schema: parsed.schema,
    schemaVersion: row.schemaVersion,
    title: row.title,
    descriptionMd: row.descriptionMd,
    /**
     * `{{token}}` interpolation resolves from the show up, with no segment —
     * every cascade read simply starts one level higher (§2.2). A feedback form
     * quoting `{{base_quota}}` is odd but not wrong, and refusing to resolve it
     * would print the braces at the audience.
     */
    copy: await resolveFormCopy({ showId: input.showId, concertId: input.concertId }),
    existing: existing ? { id: existing.id, answers: existing.answers } : null,
  };
}
