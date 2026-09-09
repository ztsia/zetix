import { notFound } from 'next/navigation';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { shows } from '@/db/schema/shows';
import { concerts } from '@/db/schema/concerts';
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
      operatorName={user.displayName ?? user.email}
      manifestExpiresAt={expiresAt}
      scanDebounceMs={debounceMs ?? 0}
    />
  );
}
