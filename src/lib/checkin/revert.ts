import 'server-only';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { checkIns } from '@/db/schema/checkin';
import { writeAuditLog } from '@/lib/audit';

/**
 * Reverting a mistaken scan (spec/checkin.md §12.4, decision 7).
 *
 * **`check_ins` is append-only. This stamps `reverted_at`; it never deletes.**
 * The night's history has to stay reconstructable afterwards, and "this scan was
 * undone at 19:42 by the admin" is a different fact from "this scan never
 * happened" — only one of them is true, and only one of them can be explained to
 * someone who was turned away.
 *
 * **Module `H` owns this write and `G` only reads it.** The scanner excludes
 * reverted rows when deciding whether an attendee is already through
 * (`/api/checkin/scan`), so a revert makes the next genuine scan of that ticket
 * read as a fresh admission rather than a duplicate — which is the entire point
 * of being able to undo one.
 */

export class RevertError extends Error {}

export async function revertCheckIn({
  checkInId,
  showId,
  actorId,
  reason,
}: {
  checkInId: number;
  /**
   * The show the admin was looking at.
   *
   * Passed and matched rather than derived from the row, so a forged id cannot
   * revert a scan belonging to a show the caller never opened.
   */
  showId: number;
  actorId: string;
  reason?: string | null;
}): Promise<{ attendeeId: number }> {
  const db = getDb();

  const [existing] = await db
    .select({
      id: checkIns.id,
      attendeeId: checkIns.attendeeId,
      showId: checkIns.showId,
      scannedAt: checkIns.scannedAt,
      source: checkIns.source,
      revertedAt: checkIns.revertedAt,
    })
    .from(checkIns)
    .where(and(eq(checkIns.id, checkInId), eq(checkIns.showId, showId)))
    .limit(1);

  if (!existing) throw new RevertError('That scan is no longer in this show’s log.');
  if (existing.revertedAt) throw new RevertError('That scan has already been reverted.');

  /**
   * Guarded on `reverted_at is null` in the statement itself, not only by the
   * read above.
   *
   * Two admins watching the same dashboard and clicking the same row is the
   * expected case at a door, and without the guard the second click would
   * overwrite the first one's `reverted_at` and `reverted_by` — quietly
   * reattributing the revert to whoever was slower.
   */
  const updated = await db
    .update(checkIns)
    .set({ revertedAt: sql`now()`, revertedBy: actorId })
    .where(and(eq(checkIns.id, checkInId), isNull(checkIns.revertedAt)))
    .returning({ id: checkIns.id, attendeeId: checkIns.attendeeId });

  if (updated.length === 0) {
    throw new RevertError('That scan has already been reverted.');
  }

  await writeAuditLog({
    action: 'checkin.reverted',
    entityType: 'check_ins',
    entityId: checkInId,
    before: {
      attendeeId: existing.attendeeId,
      showId: existing.showId,
      scannedAt: existing.scannedAt?.toISOString() ?? null,
      source: existing.source,
      revertedAt: null,
    },
    after: { revertedBy: actorId },
    reason: reason ?? null,
    actorId,
  });

  return { attendeeId: updated[0]!.attendeeId };
}
