'use server';

import { revalidatePath } from 'next/cache';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { dbErrorMessage } from '@/db/errors';
import { feedbackResponses } from '@/db/schema/feedback';
import { validateAnswers, type AnswerErrors } from '@/lib/forms/answers';
import { loadPortalFeedback } from '@/lib/portal/feedback';
import { attendeeIdForToken, ticketStatus } from '@/lib/portal/status';
import { portalIsUnlocked } from '@/lib/portal/sections';

/**
 * Submitting the post-show feedback form (spec/v2.md §13.5).
 *
 * **Every gate the section has is re-asked here.** The client sends a token and
 * a payload; nothing else about the request is trusted. In particular the form
 * is re-loaded from the show rather than taken from the submission, so a payload
 * naming another form — or another show's — cannot be written.
 *
 * **The identity is the token, and it is never in the payload.** §13.5's
 * `REGISTRANT` block "collapses to the identity resolved from the attendee's own
 * `qr_token`", so `attendee_id` is derived here and a client claiming to be
 * someone else has nothing to claim it with.
 */

export type FeedbackSubmitState = {
  ok: boolean;
  /** Keyed exactly as `validateAnswers` keys them, for the renderer. */
  errors: AnswerErrors;
};

/**
 * **Nothing but async functions may be exported from this file.** A `'use server'`
 * module that exports a constant fails at *request* time with "A 'use server'
 * file can only export async functions, found object" — `tsc` and ESLint both
 * pass, and the first sign of it is every page importing this route segment
 * answering 500. `src/app/(admin)/admin/concerts/form-state.ts` exists for
 * exactly this reason; a `FeedbackSubmitState` seed belongs beside the component
 * that needs one, not here. (`export type` is erased before the check and is
 * fine.)
 */

/** The one message every refusal that is not a field error shares. */
const REFUSED: FeedbackSubmitState = {
  ok: false,
  errors: { _form: 'This form is no longer accepting answers.' },
};

export async function submitFeedbackAction(
  token: string,
  payload: unknown,
): Promise<FeedbackSubmitState> {
  const status = await ticketStatus(token);
  if (!status) return REFUSED;

  const unlocked = portalIsUnlocked({
    mode: status.portal.unlockMode,
    admitted: status.state === 'ADMITTED',
    cancelled: status.state === 'CANCELLED',
    onHold: status.state === 'ON_HOLD',
  });
  if (!unlocked || !status.portal.enabled || !status.portal.feedbackEnabled) return REFUSED;

  /**
   * **Answered before the evening is over is refused**, because the section is
   * not drawn before then (§13.2's second row says "no feedback form") and a
   * submit that arrives anyway did not come from the page. The phase is read off
   * the clock, so this needs no flag and no job (decision 40).
   */
  if (!status.showIsOver) return REFUSED;

  const attendeeId = await attendeeIdForToken(token);
  if (attendeeId === null) return REFUSED;

  const form = await loadPortalFeedback({
    showId: status.show.id,
    concertId: status.concertId,
    attendeeId,
    closeAt: status.portal.feedbackCloseAt,
  });
  if ('state' in form) return REFUSED;

  /**
   * **Validated against the schema the form carries now**, and that schema is
   * pinned onto the row below. `L`'s builder bumps `schema_version` on every
   * edit, so an admin editing the questions between this guest loading the page
   * and submitting it means their answers are stored against the schema they are
   * being checked against — never against a newer one that would reshape what
   * they meant (§8.2.4).
   *
   * No repeater limits, because a `FEEDBACK` schema has no repeaters: the zod
   * contract refuses every seat block on this kind.
   */
  const result = validateAnswers(form.schema, payload, { limits: {} });
  if (!result.ok) return { ok: false, errors: result.errors };

  try {
    /**
     * **One response per attendee, enforced by the database** —
     * `feedback_responses_attendee_form_key`. Editing is an update of the same
     * row rather than a second one, so the upsert is the whole of the "may I
     * change my answer?" rule: a racing double-submit lands on the conflict
     * target and becomes one row, not two.
     */
    await getDb()
      .insert(feedbackResponses)
      .values({
        formId: form.id,
        attendeeId,
        showId: status.show.id,
        answers: result.answers,
        formSchema: form.schema,
      })
      .onConflictDoUpdate({
        target: [feedbackResponses.attendeeId, feedbackResponses.formId],
        set: {
          answers: result.answers,
          formSchema: form.schema,
          updatedAt: sql`now()`,
        },
      });
  } catch (error) {
    return { ok: false, errors: { _form: dbErrorMessage(error) } };
  }

  revalidatePath(`/t/${token}`);
  return { ok: true, errors: {} };
}
