import { notFound } from 'next/navigation';
import { and, eq, isNull } from 'drizzle-orm';
import { count } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { shows } from '@/db/schema/shows';
import { concerts } from '@/db/schema/concerts';
import { operatorShowAssignments } from '@/db/schema/people';
import { resolveSetting } from '@/db/settings';
import { requireScannerUser } from '@/lib/auth/guards';
import { canAccessShow } from '@/lib/auth/show-access';
import { ScannerShell } from './scanner-shell';

/**
 * One show, at the door (spec/checkin.md §12, spec/surfaces.md §15.4).
 *
 * **The assignment check is enforced here, before anything renders**, and F2
 * wrote it that way for a reason worth keeping: reaching a show by typing its
 * id must fail exactly as reaching it from the list would. A 404 rather than a
 * 403, so "you may not see this show" and "this show does not exist" are
 * indistinguishable to someone probing ids (decision 20, modules.md §5.2.1).
 *
 * Everything below this line is client-side, because everything below this line
 * has to work with the network gone. This component's whole job is to hand the
 * shell the few server facts it cannot derive offline — chiefly **when the
 * manifest expires**, which is show start plus `checkin.manifest_ttl_hours`
 * resolved through the four-level cascade. That is computed here rather than on
 * the phone because a device with a wrong clock is most of why a TTL fails at a
 * door.
 */
export default async function ScannerShowPage({
  params,
}: {
  params: Promise<{ showId: string }>;
}) {
  const user = await requireScannerUser();
  const { showId } = await params;
  const id = Number(showId);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const db = getDb();
  const rows = await db
    .select({
      id: shows.id,
      name: shows.name,
      venueName: shows.venueName,
      startsAt: shows.startsAt,
      doorsOpenAt: shows.doorsOpenAt,
      concertId: shows.concertId,
      timezone: concerts.timezone,
    })
    .from(shows)
    .innerJoin(concerts, eq(concerts.id, shows.concertId))
    .where(and(eq(shows.id, id), isNull(shows.deletedAt)))
    .limit(1);

  const show = rows[0];
  if (!show) notFound();
  if (!(await canAccessShow(user, id))) notFound();

  /**
   * **No operational value reaches code** (`CLAUDE.md`). The TTL is a settings
   * key, resolved segment → show → concert → system, and `null` is a real
   * answer meaning nobody has set one. The scanner treats that as "never
   * expires" rather than refusing to work, because a door is not improved by
   * waiting on an admin to fill in a field.
   */
  const ttlHours = await resolveSetting<number>('checkin.manifest_ttl_hours', {
    showId: id,
    concertId: show.concertId,
  });

  const expiresAt =
    ttlHours != null && show.startsAt
      ? new Date(show.startsAt.getTime() + ttlHours * 3_600_000).toISOString()
      : null;

  const debounceMs = await resolveSetting<number>('checkin.scan_debounce_ms', {
    showId: id,
    concertId: show.concertId,
  });

  /**
   * Walk-ins are off unless the concert turns them on, and one tap records at
   * most `checkin.walk_in_max_headcount` people (spec/v3.md §32.5). Both are
   * re-checked by the server on sync; these only decide what the phone offers.
   */
  const [walkInsEnabled, walkInMax] = await Promise.all([
    resolveSetting<boolean>('checkin.walk_ins_enabled', { showId: id, concertId: show.concertId }),
    resolveSetting<number>('checkin.walk_in_max_headcount', { showId: id, concertId: show.concertId }),
  ]);

  /**
   * **With exactly one assignment the show pill is read-only** (§12.1).
   *
   * The pill exists so an usher can always see which show they are admitting
   * to, and the picker exists so they can change it. An operator rostered on
   * one show has nothing to change it *to* — leaving it tappable only offers a
   * way to land on an empty picker mid-queue, and §12.1 auto-selects for
   * exactly this reason: choosing from a list of one is where the single most
   * damaging setup mistake happens.
   *
   * `ADMIN` always keeps the link. They are not rostered at all and legitimately
   * move between shows.
   */
  const assignments =
    user.role === 'ADMIN'
      ? null
      : await db
          .select({ total: count() })
          .from(operatorShowAssignments)
          .where(eq(operatorShowAssignments.userId, user.id));

  const canSwitchShows = user.role === 'ADMIN' || (assignments?.[0]?.total ?? 0) > 1;

  return (
    <ScannerShell
      show={{
        id: show.id,
        name: show.name,
        venueName: show.venueName,
        startsAt: show.startsAt?.toISOString() ?? null,
        doorsOpenAt: show.doorsOpenAt?.toISOString() ?? null,
        timezone: show.timezone,
      }}
      operatorId={user.id}
      operatorName={user.displayName ?? user.email}
      canSwitchShows={canSwitchShows}
      manifestExpiresAt={expiresAt}
      scanDebounceMs={debounceMs ?? 0}
      walkIns={walkInsEnabled === true ? { maxHeadcount: walkInMax ?? null } : null}
    />
  );
}
