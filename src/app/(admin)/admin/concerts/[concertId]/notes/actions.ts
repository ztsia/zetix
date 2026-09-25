'use server';

import { revalidatePath } from 'next/cache';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { dbErrorMessage } from '@/db/errors';
import { writeAuditLog } from '@/lib/audit';
import { requireRole } from '@/lib/auth/guards';
import { queueNotesDigest } from '@/lib/email/notes-digest';
import type { FormState } from '../../form-state';

/**
 * The Notes screen's mutations (spec/admin.md §14.2, spec/v2.md §13.4).
 *
 * **Every one of these is scoped to the concert in the URL**, not merely to the
 * ids posted. A note id is a number in a form post; without the concert
 * predicate an admin on one concert's screen could moderate or publish another
 * concert's notes by editing it. The screen is behind `requireRole` and an
 * admin may legitimately reach every concert, so this is not an authorization
 * boundary — it is the guarantee that a button does what the screen it is on
 * says it does.
 */

/**
 * The id list a bulk action accepts.
 *
 * **`safe()` rather than `int()`**: forty digits is an integral float that
 * `int()` accepts and Postgres rejects as a bigint. The cap is a request-size
 * bound and not an operational value — but 500 was below what this screen can
 * legitimately select, since a concert of several shows holds one note per
 * seat per show and Select-all is one click. Raised past any hall this system
 * will see, and the refusal below now says which limit was hit.
 */
const MAX_BULK = 5000;
const ids = z.array(z.number().int().safe().positive()).min(1).max(MAX_BULK);

/** The two refusals `ids` can produce, told apart — "too many" is not "none". */
function idProblem(count: number, noun: 'note' | 'player'): string {
  return count > MAX_BULK
    ? `That is ${count} ${noun}s at once, and ${MAX_BULK} is the most this can take. ` +
      'Narrow the filters and do it in batches.'
    : `Select at least one ${noun}.`;
}

/**
 * Approve or hide, individually or in bulk (§14.2).
 *
 * **`moderation_status` is admin triage and nothing else.** It does not
 * publish, it does not un-publish, and hiding a note that is already on the
 * wall is handled where it is read — `lib/portal/wall.ts` requires `APPROVED`
 * as well as `PUBLISHED`, so this decision takes effect immediately without
 * this action having to reach into the other flag. The two stay independent
 * (§13.4).
 */
export async function moderateNotesAction(
  concertId: number,
  noteIds: number[],
  status: 'APPROVED' | 'HIDDEN' | 'PENDING',
): Promise<FormState> {
  const user = await requireRole('ADMIN');

  const parsed = ids.safeParse(noteIds);
  if (!parsed.success) return { error: idProblem(noteIds.length, 'note') };

  try {
    const list = sql.join(parsed.data.map((id) => sql`${id}`), sql`, `);
    const rows = await getDb().execute<{ id: string }>(sql`
      update portal_notes
         set moderation_status = ${status},
             -- Who decided and when, so the grouped view can say a note has
             -- been through triage rather than merely that it is not pending.
             -- Cleared when a note is sent back to PENDING: the old verdict is
             -- no longer anybody's.
             moderated_by = ${status === 'PENDING' ? null : user.id},
             moderated_at = ${status === 'PENDING' ? null : sql`now()`},
             updated_at   = now()
       where concert_id = ${concertId}
         and id in (${list})
         and deleted_at is null
      returning id
    `);

    await writeAuditLog({
      action: `note.${status.toLowerCase()}`,
      entityType: 'portal_notes',
      entityId: null,
      after: { ids: rows.map((r) => Number(r.id)), moderationStatus: status },
    });

    revalidatePath(`/admin/concerts/${concertId}/notes`);
    return { error: null, message: summarise(rows.length, verb(status)) };
  } catch (error) {
    return { error: dbErrorMessage(error) };
  }
}

function verb(status: 'APPROVED' | 'HIDDEN' | 'PENDING'): string {
  if (status === 'APPROVED') return 'approved';
  if (status === 'HIDDEN') return 'hidden';
  return 'returned to review';
}

/**
 * Put notes on the public wall, or take them off (§14.2, decision 6).
 *
 * **A note addressed to a player is never published, and this refuses rather
 * than silently skipping.** §13.4 calls an addressed note personal mail bound
 * for that player's digest; publishing one is a privacy decision the writer
 * never made, and unlike every other mistake on this screen it cannot be
 * undone — a guest who has read it has read it.
 *
 * So the whole call is refused when the selection contains one, rather than
 * publishing the rest and mentioning the remainder. A partial success an admin
 * skims past is how the wrong note ends up public: they select forty, press
 * Publish, read "38 published", and never learn which two were not. Refusing
 * makes them look.
 *
 * **Publishing does not approve.** The two flags are independent (§13.4) and
 * the wall requires both, so an unapproved note that is published stays
 * invisible until somebody triages it. That is the safe direction, and it is
 * why this action does not helpfully set `moderation_status` on the way past.
 */
export async function setNotesOnWallAction(
  concertId: number,
  noteIds: number[],
  published: boolean,
): Promise<FormState> {
  await requireRole('ADMIN');

  const parsed = ids.safeParse(noteIds);
  if (!parsed.success) return { error: idProblem(noteIds.length, 'note') };

  try {
    const db = getDb();
    const list = sql.join(parsed.data.map((id) => sql`${id}`), sql`, `);

    if (published) {
      /**
       * **§13.4 permits publishing "only when the concert has the wall
       * enabled".** Nothing unsafe reaches a guest without this — the read
       * gates on `portal.public_wall_enabled` independently — but a screen
       * that lets an admin mark forty notes PUBLISHED on a concert with no
       * wall has told them forty times that something happened, and a guest
       * sees none of it. The failure is in what the admin believes, which is
       * the half no read-side gate can fix.
       *
       * It costs the curate-then-reveal workflow nothing:
       * `portal.public_wall_visibility = ADMIN_ONLY` is the state for
       * building the wall before anyone sees it, which is what that value is
       * for. This asks only that the wall exists.
       */
      const [wallSetting] = await db.execute<{ enabled: unknown }>(sql`
        select resolve_setting('portal.public_wall_enabled', null, null, ${concertId}) as enabled
      `);
      if (wallSetting?.enabled !== true) {
        return {
          error:
            'This concert has no public wall yet. Turn on “Public wall enabled” in Settings ' +
            'first — set visibility to ADMIN_ONLY if you want to choose the notes before ' +
            'anyone can read them.',
        };
      }

      const addressed = await db.execute<{ id: string; full_name: string | null }>(sql`
        select n.id, p.full_name
          from portal_notes n
          left join players p on p.id = n.to_player_id
         where n.concert_id = ${concertId}
           and n.id in (${list})
           and n.to_player_id is not null
           and n.deleted_at is null
      `);

      if (addressed.length > 0) {
        const names = [...new Set(addressed.map((r) => r.full_name ?? 'a player'))];
        return {
          error:
            `${addressed.length} of these ${addressed.length === 1 ? 'is' : 'are'} written to ` +
            `${names.slice(0, 3).join(', ')}${names.length > 3 ? ' and others' : ''}. ` +
            'A note for one player is personal — it goes in their digest, not on the wall. ' +
            'Deselect it and publish the rest.',
        };
      }
    }

    const rows = await db.execute<{ id: string }>(sql`
      update portal_notes
         set wall_status = ${published ? 'PUBLISHED' : 'NOT_PUBLISHED'},
             updated_at  = now()
       where concert_id = ${concertId}
         and id in (${list})
         and deleted_at is null
         ${published ? sql`and to_player_id is null` : sql``}
      returning id
    `);

    await writeAuditLog({
      action: published ? 'note.published' : 'note.unpublished',
      entityType: 'portal_notes',
      entityId: null,
      after: { ids: rows.map((r) => Number(r.id)) },
    });

    revalidatePath(`/admin/concerts/${concertId}/notes`);
    return {
      error: null,
      message: summarise(rows.length, published ? 'put on the wall' : 'taken off the wall'),
    };
  } catch (error) {
    return { error: dbErrorMessage(error) };
  }
}

/**
 * Queue `player_notes_digest` for the selected players (§14.2).
 *
 * The queueing itself is `lib/email/notes-digest.ts`, which is where the
 * outbox's two-key rule lives. This is the screen's half: check the admin,
 * report what happened in a sentence, and name anybody who was skipped —
 * a player with no email or with nothing approved will not hear from the
 * audience, and an admin who is not told will never find out.
 */
export async function queueDigestAction(
  concertId: number,
  playerIds: number[],
): Promise<FormState> {
  await requireRole('ADMIN');

  const parsed = ids.safeParse(playerIds);
  if (!parsed.success) return { error: idProblem(playerIds.length, 'player') };

  try {
    const result = await queueNotesDigest({ concertId, playerIds: parsed.data });

    await writeAuditLog({
      action: 'note.digest_queued',
      entityType: 'players',
      entityId: null,
      after: {
        playerIds: parsed.data,
        queued: result.queued,
        alreadyPending: result.alreadyPending,
        skipped: result.skipped,
      },
    });

    revalidatePath(`/admin/concerts/${concertId}/notes`);

    const parts: string[] = [];
    if (result.queued > 0) parts.push(summarise(result.queued, 'drafted', 'digest', 'digests'));
    if (result.alreadyPending > 0) {
      parts.push(`${result.alreadyPending} already waiting in the outbox`);
    }
    for (const skip of result.skipped) {
      parts.push(
        skip.reason === 'NO_EMAIL'
          ? `${skip.playerName} has no email address on file`
          : `${skip.playerName} has no approved notes yet`,
      );
    }
    /**
     * Reported as a message rather than an error even when nothing was queued.
     * Nothing failed — the admin asked a question and these are the answers,
     * and a red alert saying "Ada has no approved notes yet" reads as a fault
     * in the system rather than a step still to do.
     */
    return {
      error: null,
      message: parts.length > 0 ? `${parts.join('. ')}.` : 'Nothing to send.',
    };
  } catch (error) {
    return { error: dbErrorMessage(error) };
  }
}

/** "3 notes approved", "1 note approved" — the count an admin needs to trust a bulk action. */
function summarise(count: number, past: string, singular = 'note', plural = 'notes'): string {
  return `${count} ${count === 1 ? singular : plural} ${past}`;
}
