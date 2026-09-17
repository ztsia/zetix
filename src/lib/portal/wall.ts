import 'server-only';

import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { wallIsPublic, type PublicWallVisibility } from './wall-visibility';

/**
 * The public notes wall (spec/v2.md §13.4, spec/admin.md §14.2).
 *
 * **Two gates, and an admin action behind both of them.** A note reaches this
 * list only if `portal.public_wall_enabled` is on, `portal.public_wall_visibility`
 * is `AUDIENCE`, and an admin has explicitly set its `wall_status` to
 * `PUBLISHED` (decision 6). Nothing here publishes anything; this is the read
 * side only.
 *
 * **The wall is not paginated and carries no row cap**, which was not the
 * first answer here. An arbitrary `limit` looked prudent and was a bug of
 * exactly the kind `CLAUDE.md` names: a number governing what the audience
 * sees, living in a `.ts` file, that no admin could raise. It also failed
 * silently in the worst direction — a writer past the cap was told "On the
 * public wall" by their own portal page while their note was rendered to
 * nobody.
 *
 * It is not replaced with a setting, because the bound is already structural
 * and real: `portal_notes_attendee_key` allows **one note per attendee**, an
 * attendee is a seat, and seats are bounded by the hall. Every note here also
 * passed an explicit admin action to get published (decision 6), so the number
 * on the page is one the orchestra chose note by note. A concert that
 * published four hundred notes meant to.
 *
 * **Addressed notes never appear, and the filter is here as well as in the
 * admin action that publishes.** A note written to one player is personal mail
 * bound for their digest (§13.4). The admin side refuses to publish one at all,
 * so this filter should be unreachable — it is kept because "should be
 * unreachable" is exactly the assumption that a later bulk-update, a migration
 * or a hand-edit quietly breaks, and the cost of being wrong is somebody's
 * personal message on a public page.
 */

export type WallNote = {
  id: number;
  body: string;
  /** Null when the writer asked for their name to be withheld (§13.4). */
  displayName: string | null;
};

/**
 * Published notes for a concert, newest first, or an empty list when the wall
 * is not public.
 *
 * The visibility check is made here rather than left to the caller so that no
 * future second caller can reach the rows without it.
 */
export async function loadPublicWall(input: {
  concertId: number;
  enabled: boolean;
  visibility: PublicWallVisibility | null;
}): Promise<WallNote[]> {
  if (!wallIsPublic({ enabled: input.enabled, visibility: input.visibility })) return [];

  const rows = await getDb().execute<{
    id: string | number;
    body: string;
    display_name: string | null;
    is_anonymous: boolean;
  }>(sql`
    select id, body, display_name, is_anonymous
      from portal_notes
     where concert_id = ${input.concertId}
       and wall_status = 'PUBLISHED'
       -- Moderation and publication are independent flags (§13.4), so this is
       -- not redundant with the line above: an admin who publishes a note and
       -- later hides it in triage has made a decision, and the wall must
       -- honour the later one.
       and moderation_status = 'APPROVED'
       and to_player_id is null
       -- portal_notes carries deleted_at like every soft-deletable table here,
       -- and a removed note must be removed from the wall first of all.
       -- (No backticks in a comment inside a template literal: they end it.)
       and deleted_at is null
     order by created_at desc
  `);

  return rows.map((row) => ({
    id: Number(row.id),
    body: row.body,
    /**
     * **Anonymity is applied here, not in the component.** §13.4 hides the name
     * on the wall and never from admin, so the name exists in the row and the
     * only safe place to drop it is the query result that feeds a public page.
     * A component deciding this would ship the name to the browser and rely on
     * JSX not to print it.
     */
    displayName: row.is_anonymous ? null : row.display_name,
  }));
}
