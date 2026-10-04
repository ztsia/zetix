import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth/session';
import { hasRole } from '@/lib/auth/guards';
import { canAccessShow } from '@/lib/auth/show-access';
import { getDoorStats } from '@/lib/checkin/dashboard';

/**
 * `GET /api/checkin/stats?showId=` — the door's Stats tab (spec/v3.md §32.2,
 * decision 59).
 *
 * **Counts only, and still gated exactly like the manifest** (§32.4). The
 * numbers name nobody, but "an operator acts on assigned shows" is the rule,
 * and a read of an unassigned show's door would be the first to ignore it. So:
 * 401 without a session, 404 for a viewer, 404 for a show the caller is not
 * rostered on — never 403, so "not yours" and "not there" look the same.
 *
 * One implementation with the admin Door screen (`getCheckinStats`), so the
 * desk and the door never disagree about the house.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({ showId: z.coerce.number().int().positive() });

export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  if (!hasRole(user, 'ADMIN', 'OPERATOR')) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const parsed = querySchema.safeParse({
    showId: new URL(request.url).searchParams.get('showId'),
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'A numeric showId is required' }, { status: 400 });
  }
  const { showId } = parsed.data;
  if (!(await canAccessShow(user, showId))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json(await getDoorStats(showId, user.id), {
    headers: { 'Cache-Control': 'no-store' },
  });
}
