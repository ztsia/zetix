import 'server-only';

import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { toNameCase } from '@/lib/names';
import { escapeMergeValues, renderTemplate } from './render';
import { MissingTemplateError } from './queue';

/**
 * The player notes digest (spec/email.md §11.3, spec/admin.md §14.2).
 *
 * **The one message in the system addressed to somebody with no registration**
 * (decision 22, `modules-v2.md` §3.1). Everything else about it is ordinary —
 * it renders from a template, lands in `email_outbox` as a `DRAFT`, and is
 * drained by the same dispatcher — but that one difference is the one the
 * schema was reshaped for, so it is worth stating what makes it safe:
 *
 * - `player_id` is set and `registration_id` is **null**, which the check
 *   constraint `num_nonnulls(registration_id, player_id) = 1` permits and a row
 *   with neither does not.
 * - `outbox_no_duplicate_pending_player` is the partial unique index over the
 *   same pending statuses as the registration one, so `on conflict do nothing`
 *   makes a second press harmless exactly as it does for a ticket blast.
 *
 * **Queued as `DRAFT`, and decision 23 is not narrowed here.** Decision 38
 * narrowed it for the feedback email on the grounds that it carries "no
 * attachment, no per-person merge beyond a name and a link, and nothing
 * irreplaceable". A digest is the opposite on the middle count: its whole body
 * is other people's words about this player, merged per person, and it is
 * exactly the message an orchestra would want to read before it goes out.
 */

export const DIGEST_TEMPLATE_KEY = 'player_notes_digest';

export type DigestResult = {
  /** Rows written. */
  queued: number;
  /** Players who already had a digest waiting; the index declined a second. */
  alreadyPending: number;
  /**
   * Players skipped, and why — reported rather than swallowed, because every
   * one of these is a player who will not hear from the audience and an admin
   * who was not told would never find out.
   */
  skipped: { playerId: number; playerName: string; reason: DigestSkip }[];
  unknownTokens: string[];
};

export type DigestSkip =
  /** `players.email` is nullable and an import need not supply one. */
  | 'NO_EMAIL'
  /**
   * Every note written to them is still `PENDING`, or was `HIDDEN` in triage.
   * A digest of nothing is worse than none: it tells a player the audience had
   * nothing to say to them.
   */
  | 'NO_APPROVED_NOTES';

/**
 * `"{body}" — from {name}`, which is `admin.md` §14.2's own rendering.
 *
 * Kept identical to the admin screen and the public wall so that all three say
 * the same thing about the same note. Joined with a blank line between items
 * rather than a single newline: §11.3 records that a single `\n` is a *soft*
 * break in Markdown, so a list joined with one arrives in the HTML half as one
 * run-on paragraph.
 */
export function notesList(notes: { body: string; displayName: string | null }[]): string {
  return notes
    .map((note) => `> ${note.body.replace(/\n/g, '\n> ')}\n>\n> — ${note.displayName ?? 'Anonymous'}`)
    .join('\n\n');
}

/**
 * Queue a digest for each of the named players.
 *
 * **The player ids are re-checked against this concert**, not trusted from the
 * caller, for the same reason the portal action re-checks them: an id is a
 * number in a form post, and a digest is somebody's mail.
 */
export async function queueNotesDigest(input: {
  concertId: number;
  playerIds: number[];
}): Promise<DigestResult> {
  const db = getDb();
  if (input.playerIds.length === 0) {
    return { queued: 0, alreadyPending: 0, skipped: [], unknownTokens: [] };
  }

  const templates = await db.execute<{ subject: string; body_md: string }>(sql`
    select subject, body_md from email_templates where key = ${DIGEST_TEMPLATE_KEY}
  `);
  const template = templates[0];
  if (!template) throw new MissingTemplateError(DIGEST_TEMPLATE_KEY);

  const [concert] = await db.execute<{ name: string }>(sql`
    select name from concerts where id = ${input.concertId} and deleted_at is null limit 1
  `);
  if (!concert) return { queued: 0, alreadyPending: 0, skipped: [], unknownTokens: [] };

  const ids = sql.join(input.playerIds.map((id) => sql`${id}`), sql`, `);

  const players = await db.execute<{
    id: string | number;
    full_name: string;
    email: string | null;
  }>(sql`
    select id, full_name, email from players
     where concert_id = ${input.concertId}
       and is_active
       and id in (${ids})
     order by full_name
  `);

  /**
   * **Approved notes only.** `moderation_status` is admin triage (§13.4), and
   * forwarding text nobody has read to the person it is about is the thing
   * triage exists to prevent — a digest is not the public wall, but it is
   * still the orchestra passing on words in its own name.
   */
  const noteRows = await db.execute<{
    to_player_id: string | number;
    body: string;
    display_name: string | null;
    is_anonymous: boolean;
  }>(sql`
    select to_player_id, body, display_name, is_anonymous
      from portal_notes
     where concert_id = ${input.concertId}
       and moderation_status = 'APPROVED'
       and to_player_id in (${ids})
     order by created_at
  `);

  const byPlayer = new Map<number, { body: string; displayName: string | null }[]>();
  for (const row of noteRows) {
    const key = Number(row.to_player_id);
    const entry = {
      body: row.body,
      /**
       * §13.4: anonymity hides the name "on the wall but never from admin".
       * A digest is neither — it goes to the player the note was written *to*,
       * and a writer who asked to be anonymous meant it about the person
       * reading their words, not only about strangers. Withheld here too.
       */
      displayName: row.is_anonymous ? null : row.display_name,
    };
    const existing = byPlayer.get(key);
    if (existing) existing.push(entry);
    else byPlayer.set(key, [entry]);
  }

  const skipped: DigestResult['skipped'] = [];
  const unknownTokens = new Set<string>();
  const rows: { playerId: number; email: string; name: string; subject: string; bodyMd: string; context: Record<string, string> }[] = [];

  for (const player of players) {
    const playerId = Number(player.id);
    const notes = byPlayer.get(playerId) ?? [];

    if (notes.length === 0) {
      skipped.push({ playerId, playerName: player.full_name, reason: 'NO_APPROVED_NOTES' });
      continue;
    }
    if (!player.email) {
      skipped.push({ playerId, playerName: player.full_name, reason: 'NO_EMAIL' });
      continue;
    }

    const context: Record<string, string> = {
      'concert.name': concert.name,
      'player.name': toNameCase(player.full_name),
      notes_list: notesList(notes),
      notes_count: String(notes.length),
    };
    const escaped = escapeMergeValues(context);
    const subject = renderTemplate(template.subject, escaped);
    const body = renderTemplate(template.body_md, escaped);
    for (const token of [...subject.unknown, ...body.unknown]) unknownTokens.add(token);

    rows.push({
      playerId,
      email: player.email,
      name: toNameCase(player.full_name),
      subject: subject.text,
      bodyMd: body.text,
      context,
    });
  }

  if (rows.length === 0) {
    return { queued: 0, alreadyPending: 0, skipped, unknownTokens: [...unknownTokens] };
  }

  const values = sql.join(
    rows.map(
      (r) =>
        sql`(${r.playerId}::bigint, ${r.email}::text, ${r.name}::text, ${r.subject}::text, ${r.bodyMd}::text, ${JSON.stringify(r.context)}::jsonb)`,
    ),
    sql`, `,
  );

  /**
   * `registration_id` is left out of the column list rather than written as
   * null, which is the same thing to Postgres and a clearer statement of
   * intent: this row has no registration, and the check constraint is what
   * enforces that exactly one key is present.
   */
  const inserted = await db.execute<{ id: string }>(sql`
    insert into email_outbox (
      player_id, template_key, to_email, to_name, subject, body_md, context, status
    )
    select v.player_id, ${DIGEST_TEMPLATE_KEY}, v.to_email, v.to_name,
           v.subject, v.body_md, v.context, 'DRAFT'
      from (values ${values}) as v(player_id, to_email, to_name, subject, body_md, context)
    on conflict do nothing
    returning id
  `);

  return {
    queued: inserted.length,
    /**
     * What the index declined. Reported rather than folded into `queued`,
     * because "already waiting" and "sent" are different answers to an admin
     * wondering why a player has not heard anything.
     */
    alreadyPending: rows.length - inserted.length,
    skipped,
    unknownTokens: [...unknownTokens],
  };
}
