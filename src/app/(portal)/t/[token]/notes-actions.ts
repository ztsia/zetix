'use server';

import { revalidatePath } from 'next/cache';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { dbErrorMessage } from '@/db/errors';
import { attendeeIdForToken, ticketStatus } from '@/lib/portal/status';
import { portalIsUnlocked } from '@/lib/portal/sections';
import { notesAreOpen } from '@/lib/portal/notes';

/**
 * Leaving or editing a note (spec/v2.md §13.4).
 *
 * **Every gate the section drew itself behind is re-asked here**, which is the
 * shape `N` set in `submitFeedbackAction` and the reason it left a test pair
 * sending a payload that names somebody else. The client sends a token and a
 * body; nothing else about the request is trusted, and in particular the
 * attendee is derived from the token rather than read from the payload.
 *
 * **`to_player_id` is checked against this concert's active roster**, not
 * merely against being a number. Without that check a guest could address a
 * note to any player of any concert in the database by editing one field, and
 * it would arrive in that player's digest with nothing anywhere to explain how.
 * The foreign key alone does not say *which concert*.
 */

/** Nothing but async functions may be exported from a `'use server'` file — see `feedback-actions.ts`. */

export type NoteSubmitState = {
  ok: boolean;
  /** Keyed by field, plus `_form` for everything that is not one. */
  errors: Record<string, string>;
};

const REFUSED: NoteSubmitState = {
  ok: false,
  errors: { _form: 'Notes are not being accepted for this concert.' },
};

/**
 * The payload, before the body's length is known.
 *
 * `portal.note_max_length` is resolved through the cascade per concert, so the
 * cap cannot live in this schema — it is checked below, against the number the
 * portal context carries. A literal here would be an operational value in a
 * `.ts` file (`CLAUDE.md`).
 */
const NotePayload = z.object({
  body: z.string(),
  /** `null` is "the whole orchestra", which is the same absence the column stores. */
  toPlayerId: z.number().int().positive().nullable().catch(null),
  displayName: z.string().nullable().catch(null),
  isAnonymous: z.boolean().catch(false),
});

export async function submitNoteAction(
  token: string,
  payload: unknown,
): Promise<NoteSubmitState> {
  const status = await ticketStatus(token);
  if (!status) return REFUSED;

  const unlocked = portalIsUnlocked({
    mode: status.portal.unlockMode,
    admitted: status.state === 'ADMITTED',
    cancelled: status.state === 'CANCELLED',
  });
  if (!unlocked || !status.portal.enabled) return REFUSED;

  /**
   * The section's own two gates, asked together exactly as the loader asks
   * them. A submit that arrives after the deadline did not come from the page,
   * which renders the closed section without a save control.
   */
  if (!notesAreOpen({ enabled: status.portal.notesEnabled, closeAt: status.portal.notesCloseAt })) {
    return REFUSED;
  }

  const parsed = NotePayload.safeParse(payload);
  if (!parsed.success) return REFUSED;
  const input = parsed.data;

  const body = input.body.trim();
  if (body.length === 0) {
    return { ok: false, errors: { body: 'Write something first.' } };
  }
  /**
   * **An unset cap does not mean unlimited.** `portal.note_max_length` is
   * catalogued and seeded, so null here means somebody deleted it rather than
   * that this concert wants essays; accepting a megabyte of text into a column
   * an admin screen has to render is the worse of the two failures.
   */
  const maxLength = status.portal.noteMaxLength;
  if (maxLength !== null && body.length > maxLength) {
    return {
      ok: false,
      errors: { body: `Please keep this to ${maxLength} characters — yours is ${body.length}.` },
    };
  }

  const attendeeId = await attendeeIdForToken(token);
  if (attendeeId === null) return REFUSED;

  /**
   * The recipient, verified against this concert's **active** roster.
   *
   * A player deactivated between the page loading and this submit reads as no
   * longer addressable, and the note becomes one for the whole orchestra rather
   * than being refused: the guest did nothing wrong and their words should not
   * be lost to an admin's roster edit. An id belonging to another concert
   * resolves to nothing here and lands in the same place.
   */
  let toPlayerId: number | null = null;
  if (input.toPlayerId !== null) {
    const rows = await getDb().execute<{ id: string | number }>(sql`
      select id from players
       where id = ${input.toPlayerId}
         and concert_id = ${status.concertId}
         and is_active
       limit 1
    `);
    toPlayerId = rows[0] ? Number(rows[0].id) : null;
  }

  /**
   * §13.4: `display_name` defaults to the attendee's name. Stored rather than
   * resolved at read time so that the wall keeps saying what the writer chose
   * even if an admin later corrects the spelling of their attendee row — the
   * note is their words, including their name.
   */
  const displayName = input.displayName?.trim() || status.attendeeName;

  try {
    await getDb().execute(sql`
      insert into portal_notes
        (concert_id, show_id, attendee_id, to_player_id, display_name, is_anonymous,
         body, moderation_status, wall_status)
      values
        (${status.concertId}, ${status.show.id}, ${attendeeId}, ${toPlayerId},
         ${displayName}, ${input.isAnonymous}, ${body}, 'PENDING', 'NOT_PUBLISHED')
      on conflict (attendee_id) do update
         set to_player_id = excluded.to_player_id,
             display_name = excluded.display_name,
             is_anonymous = excluded.is_anonymous,
             body         = excluded.body,

             -- **Editing returns the note to PENDING** (§13.4). Otherwise
             -- moderation reviews one text and the wall publishes another,
             -- which the spec names as the only way this surface could
             -- embarrass the orchestra.
             moderation_status = 'PENDING',

             -- **And takes it off the wall**, which §13.4 does not say in so
             -- many words but is the whole point of the sentence that precedes
             -- it: a PUBLISHED note left published through an edit puts
             -- unreviewed text in front of the audience *immediately*, which is
             -- worse than the case the rule was written for. The two flags stay
             -- independent as admin controls — this is not one flag driving the
             -- other, it is an edit invalidating both reviews, because both were
             -- reviews of text that no longer exists.
             wall_status = 'NOT_PUBLISHED',

             -- The previous verdict is no longer about this text, so the
             -- moderator and the time they decided go with it. Leaving them
             -- would credit an admin with approving words they never read.
             moderated_by = null,
             moderated_at = null,

             updated_at = now()
    `);
  } catch (error) {
    return { ok: false, errors: { _form: dbErrorMessage(error) } };
  }

  revalidatePath(`/t/${token}`);
  return { ok: true, errors: {} };
}
