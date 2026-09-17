import 'server-only';

import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';

/**
 * The note one attendee may leave, and who they may address it to
 * (spec/v2.md §13.4).
 *
 * **Addressing derives from the attendee's segment, not from the show.** One
 * show carries both audiences — for this concert it does (`CLAUDE.md`) — so
 * "which kind of guest is this" has no answer at the show level. A
 * `PLAYER_INVITED` attendee reaches their inviting player through
 * `registrations.player_id` and gets them prefilled and changeable; a `PUBLIC`
 * attendee never had one and gets the concert's players to search plus "the
 * whole orchestra". Reading the show's audience instead would prefill the wrong
 * player for half the hall, which is the kind of error nobody reports because
 * the note simply arrives in the wrong digest.
 *
 * **One note per attendee, and the database says so** —
 * `portal_notes_attendee_key`. An attendee belongs to exactly one show, so that
 * single-column unique index carries "one per attendee per show" whole
 * (spec/domain.md §5.2).
 */

/** A player as the addressing control offers them. */
export type NoteRecipient = {
  id: number;
  name: string;
  /** Both nullable on `players`; the control shows whichever it has. */
  instrument: string | null;
  section: string | null;
};

/** An attendee's own note, as the form reloads it for editing. */
export type ExistingNote = {
  id: number;
  body: string;
  toPlayerId: number | null;
  displayName: string | null;
  isAnonymous: boolean;
  /**
   * Shown back to the writer so that "waiting to be read" and "on the wall" are
   * different states on their screen. `moderation_status` is admin triage and
   * the writer sees only that much of it — never `HIDDEN` as a verdict, which
   * would be a rejection notice nobody wrote.
   */
  moderationStatus: 'PENDING' | 'APPROVED' | 'HIDDEN';
  wallStatus: 'NOT_PUBLISHED' | 'PUBLISHED';
};

export type NotesSectionData = {
  /** Every active player on this concert, for the search control. */
  players: NoteRecipient[];
  /**
   * The inviting player, prefilled for a `PLAYER_INVITED` attendee and null for
   * a `PUBLIC` one. Null also means "the whole orchestra" was chosen, which is
   * why the form tracks the two as one nullable value exactly as the column
   * does.
   */
  defaultToPlayerId: number | null;
  existing: ExistingNote | null;
  /** `portal.note_max_length`, resolved through the cascade by the caller. */
  maxLength: number | null;
};

/**
 * The three states the section has, and why `CLOSED` still carries its data.
 *
 * - `OFF` — `portal.notes_enabled` is false or unset. No section, nothing to
 *   show, and nothing read from the database.
 * - `CLOSED` — past `portal.notes_close_at`. **The section still draws**, and
 *   it still carries the writer's own note, because someone who left one last
 *   week and comes back to reread it must find it. A section that vanished at
 *   the deadline would look exactly like their note having been deleted.
 * - `OPEN` — the form accepts a new note or an edit.
 *
 * `CLOSED` and `OPEN` share a shape deliberately: the component renders the
 * same note either way and only the controls differ, so a reader of this type
 * cannot forget that a closed section has content.
 */
export type NotesResult =
  | { state: 'OFF' }
  | (NotesSectionData & { state: 'CLOSED' })
  | (NotesSectionData & { state: 'OPEN' });

/**
 * Whether notes are still being accepted, off the two settings that decide it.
 *
 * **Closed is a state the writer is shown, not a section that vanishes** — the
 * same call §13.2 makes for a closed feedback form. Someone who left a note
 * last week and comes back to reread it must still find it; a section that
 * disappeared at `notes_close_at` would look like their note had been deleted.
 *
 * Exported because the Server Action re-asks it rather than trusting that the
 * section drew itself correctly.
 */
export function notesAreOpen(input: { enabled: boolean; closeAt: Date | null; now?: Date }): boolean {
  if (!input.enabled) return false;
  if (!input.closeAt) return true;
  return (input.now ?? new Date()) <= input.closeAt;
}

/**
 * Everything the notes section needs, in one round trip for the note and one
 * for the roster.
 *
 * Two queries rather than one: the roster is per *concert* and the note is per
 * *attendee*, so joining them would return the whole player list once per row
 * of a one-row result. They are issued together below.
 */
export async function loadPortalNotes(input: {
  attendeeId: number;
  concertId: number;
  enabled: boolean;
  closeAt: Date | null;
  maxLength: number | null;
  now?: Date;
}): Promise<NotesResult> {
  if (!input.enabled) return { state: 'OFF' };

  const db = getDb();

  const [addressing, players, existing] = await Promise.all([
    /**
     * The attendee's own audience and inviting player, in one read.
     *
     * `audience_mode` comes off the **segment** (§13.4) and the inviting player
     * off the registration. A `PUBLIC` registration has a null `player_id`
     * already, so the case expression is not what makes public attendees
     * unaddressed — it is what stops a `PUBLIC` seat inheriting a player if one
     * were ever set on its registration by an import or an admin edit. The
     * column is nullable for both audiences and only the segment says which
     * rule applies.
     */
    db.execute<{ audience_mode: string; player_id: string | number | null }>(sql`
      select seg.audience_mode,
             case when seg.audience_mode = 'PLAYER_INVITED' then r.player_id end as player_id
        from attendees a
        join registrations  r   on r.id = a.registration_id
        join show_segments  seg on seg.id = a.segment_id
       where a.id = ${input.attendeeId}
       limit 1
    `),

    /**
     * **Active players only.** A deactivated player is one who is not in this
     * concert, and offering them as a recipient promises a digest that will
     * never be sent. An existing note already addressed to one keeps its
     * `to_player_id` — the column is not cleared by deactivation — so the admin
     * grouping still shows it and nothing is lost.
     */
    db.execute<{ id: string | number; full_name: string; instrument: string | null; section: string | null }>(sql`
      select id, full_name, instrument, section
        from players
       where concert_id = ${input.concertId}
         and is_active
       order by full_name
    `),

    db.execute<{
      id: string | number;
      body: string;
      to_player_id: string | number | null;
      display_name: string | null;
      is_anonymous: boolean;
      moderation_status: 'PENDING' | 'APPROVED' | 'HIDDEN';
      wall_status: 'NOT_PUBLISHED' | 'PUBLISHED';
    }>(sql`
      select id, body, to_player_id, display_name, is_anonymous,
             moderation_status, wall_status
        from portal_notes
       where attendee_id = ${input.attendeeId}
         and deleted_at is null
       limit 1
    `),
  ]);

  const note = existing[0];
  const data: NotesSectionData = {
    players: players.map((p) => ({
      id: Number(p.id),
      name: p.full_name,
      instrument: p.instrument,
      section: p.section,
    })),
    defaultToPlayerId:
      addressing[0]?.player_id == null ? null : Number(addressing[0].player_id),
    existing: note
      ? {
          id: Number(note.id),
          body: note.body,
          toPlayerId: note.to_player_id == null ? null : Number(note.to_player_id),
          displayName: note.display_name,
          isAnonymous: note.is_anonymous,
          moderationStatus: note.moderation_status,
          wallStatus: note.wall_status,
        }
      : null,
    maxLength: input.maxLength,
  };

  /**
   * **Closed is decided after the read, not before it.** The writer still gets
   * their note back to read; what they lose is the ability to change it. Doing
   * this the other way round would hand a closed section nothing to show.
   */
  const open = notesAreOpen({ enabled: true, closeAt: input.closeAt, now: input.now });
  return { ...data, state: open ? 'OPEN' : 'CLOSED' };
}
