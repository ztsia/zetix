import 'server-only';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { operatorShowAssignments } from '@/db/schema/people';
import type { SessionUser } from './session';

/**
 * May this user act on this show? (decision 20, spec/checkin.md §12.3, §14.3)
 *
 * **This is the authorization boundary for the attendee roster.** The check-in
 * manifest is every attendee's name for a show, so "which shows is this operator
 * rostered on" is not a convenience filter — it is the only thing standing
 * between one usher and the whole audience list.
 *
 * It lives here, rather than inline in the page that needed it first, because
 * module `G`'s manifest endpoint has to make exactly the same decision. Two
 * implementations of one authorization rule drift apart, and the second one
 * drifts silently.
 *
 * `ADMIN` ignores assignments entirely and sees every show; `VIEWER` sees none.
 * An operator with no
 * assignments is refused everything, which is correct for a provisioned-but-not-
 * rostered account rather than an error.
 */
export async function canAccessShow(
  user: Pick<SessionUser, 'id' | 'role'>,
  showId: number,
): Promise<boolean> {
  if (!Number.isInteger(showId) || showId <= 0) return false;
  if (user.role === 'ADMIN') return true;
  // A viewer reads the console, never a door roster (spec/v3.md §28). They hold
  // no assignments, so the query below would refuse them too; saying so here
  // keeps that true if someone ever assigns one.
  if (user.role !== 'OPERATOR') return false;

  const rows = await getDb()
    .select({ id: operatorShowAssignments.id })
    .from(operatorShowAssignments)
    .where(
      and(
        eq(operatorShowAssignments.userId, user.id),
        eq(operatorShowAssignments.showId, showId),
      ),
    )
    .limit(1);

  return rows.length > 0;
}
