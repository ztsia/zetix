import 'server-only';

import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';

/**
 * What the Notes screen shows (spec/admin.md §14.2, spec/v2.md §13.4).
 *
 * **"The primary post-concert artefact"** is §14.2's own description, and it
 * shapes this file: every note on the concert is loaded, not just the published
 * ones, because the screen's job is the triage that decides which become
 * published. The audience-facing half of the same table is
 * `lib/portal/wall.ts`, which filters hard; this one deliberately does not.
 *
 * **The grouped-by-player view is admin-only, always** (decision 6), whatever
 * `portal.public_wall_visibility` says. It is how the orchestra prepares what
 * goes back to players, and no setting opens it to anybody else — which is why
 * it is computed here, behind `requireRole`, and has no counterpart under
 * `lib/portal/`.
 */

export type AdminNote = {
  id: number;
  body: string;
  displayName: string | null;
  isAnonymous: boolean;
  moderationStatus: 'PENDING' | 'APPROVED' | 'HIDDEN';
  wallStatus: 'NOT_PUBLISHED' | 'PUBLISHED';
  toPlayerId: number | null;
  toPlayerName: string | null;
  showId: number;
  showName: string;
  /** The writer, from their attendee row — never hidden from admin (§13.4). */
  attendeeName: string;
  createdAt: Date;
};

/** A player, their notes, and the count §14.2 asks for beside the heading. */
export type PlayerGroup = {
  /** Null is the "For the orchestra" group — §14.2's unaddressed bucket. */
  playerId: number | null;
  playerName: string;
  playerEmail: string | null;
  notes: AdminNote[];
  /**
   * Whether a digest is already waiting in the outbox for this player.
   *
   * Read so the button can say so rather than relying on the
   * `on conflict do nothing` to swallow a second press silently — an admin who
   * presses Queue twice and is told nothing assumes it failed
   * (`modules-v2.md` §3.1).
   */
  digestPending: boolean;
};

export type NotesScreen = {
  concertName: string;
  notes: AdminNote[];
  groups: PlayerGroup[];
  shows: { id: number; name: string }[];
  /** Every active player, for the filter control — including those with no notes. */
  players: { id: number; name: string }[];
};

export async function loadNotesScreen(concertId: number): Promise<NotesScreen | null> {
  const db = getDb();

  const [concert] = await db.execute<{ name: string }>(sql`
    select name from concerts where id = ${concertId} and deleted_at is null limit 1
  `);
  if (!concert) return null;

  const [noteRows, showRows, playerRows, pendingRows] = await Promise.all([
    db.execute<{
      id: string | number;
      body: string;
      display_name: string | null;
      is_anonymous: boolean;
      moderation_status: 'PENDING' | 'APPROVED' | 'HIDDEN';
      wall_status: 'NOT_PUBLISHED' | 'PUBLISHED';
      to_player_id: string | number | null;
      to_player_name: string | null;
      show_id: string | number;
      show_name: string;
      attendee_name: string;
      created_at: string;
    }>(sql`
      select n.id, n.body, n.display_name, n.is_anonymous,
             n.moderation_status, n.wall_status,
             n.to_player_id, p.full_name as to_player_name,
             n.show_id, s.name as show_name,
             a.full_name as attendee_name,
             n.created_at
        from portal_notes n
        join shows     s on s.id = n.show_id
        join attendees a on a.id = n.attendee_id
        -- Left, not inner: a note for the whole orchestra has no player, and an
        -- inner join here would hide every unaddressed note — which is most of
        -- them, and the only ones §14.2 calls natural wall candidates.
        left join players p on p.id = n.to_player_id
       where n.concert_id = ${concertId}
         and n.deleted_at is null
       order by n.created_at desc
    `),

    db.execute<{ id: string | number; name: string }>(sql`
      select id, name from shows
       where concert_id = ${concertId} and deleted_at is null
       order by starts_at nulls last, name
    `),

    db.execute<{ id: string | number; full_name: string; email: string | null }>(sql`
      select id, full_name, email from players
       where concert_id = ${concertId} and is_active
       order by full_name
    `),

    /**
     * Digests already waiting, by player. The same pending statuses the partial
     * unique index covers, so this reports exactly the rows a second queue
     * would decline to write.
     */
    db.execute<{ player_id: string | number }>(sql`
      select distinct player_id from email_outbox
       where template_key = 'player_notes_digest'
         and player_id is not null
         and status in ('DRAFT', 'QUEUED', 'SENDING')
    `),
  ]);

  const notes: AdminNote[] = noteRows.map((r) => ({
    id: Number(r.id),
    body: r.body,
    displayName: r.display_name,
    isAnonymous: r.is_anonymous,
    moderationStatus: r.moderation_status,
    wallStatus: r.wall_status,
    toPlayerId: r.to_player_id == null ? null : Number(r.to_player_id),
    toPlayerName: r.to_player_name,
    showId: Number(r.show_id),
    showName: r.show_name,
    attendeeName: r.attendee_name,
    createdAt: new Date(r.created_at),
  }));

  const players = playerRows.map((p) => ({
    id: Number(p.id),
    name: p.full_name,
    email: p.email,
  }));
  const digestPending = new Set(pendingRows.map((r) => Number(r.player_id)));

  return {
    concertName: concert.name,
    notes,
    groups: groupByPlayer(notes, players, digestPending),
    shows: showRows.map((s) => ({ id: Number(s.id), name: s.name })),
    players: players.map(({ id, name }) => ({ id, name })),
  };
}

/**
 * §14.2's grouped view: a section per player, plus "For the orchestra" for the
 * unaddressed.
 *
 * **Only players who were written to get a section.** A roster of eighty with
 * three notes between them would otherwise be seventy-seven empty headings, and
 * the view exists to prepare what goes back to players — an empty group is not
 * something anybody prepares. The filter control above still lists every
 * player, because "did anyone write to X?" is a question worth being able to
 * ask and get "no" for.
 *
 * **The orchestra group sorts last.** It is usually the largest and it is the
 * one that needs no per-player action; the sections that lead to a digest
 * belong at the top.
 */
function groupByPlayer(
  notes: AdminNote[],
  players: { id: number; name: string; email: string | null }[],
  digestPending: Set<number>,
): PlayerGroup[] {
  const byPlayer = new Map<number, AdminNote[]>();
  const orchestra: AdminNote[] = [];

  for (const note of notes) {
    if (note.toPlayerId === null) {
      orchestra.push(note);
      continue;
    }
    const existing = byPlayer.get(note.toPlayerId);
    if (existing) existing.push(note);
    else byPlayer.set(note.toPlayerId, [note]);
  }

  const known = new Map(players.map((p) => [p.id, p]));
  const groups: PlayerGroup[] = [...byPlayer.entries()]
    .map(([playerId, playerNotes]) => {
      const player = known.get(playerId);
      return {
        playerId,
        /**
         * A note whose player has since been deactivated keeps its group and is
         * labelled, rather than silently folding into "For the orchestra" — the
         * note was addressed to somebody and an admin reading this view needs
         * to know who, even if no digest can be sent.
         */
        playerName: player?.name ?? playerNotes[0].toPlayerName ?? 'Former player',
        playerEmail: player?.email ?? null,
        notes: playerNotes,
        digestPending: digestPending.has(playerId),
      };
    })
    .sort((a, b) => a.playerName.localeCompare(b.playerName));

  if (orchestra.length > 0) {
    groups.push({
      playerId: null,
      playerName: 'For the orchestra',
      playerEmail: null,
      notes: orchestra,
      digestPending: false,
    });
  }

  return groups;
}
