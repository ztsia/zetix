import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { concerts } from '@/db/schema/concerts';
import { players } from '@/db/schema/people';
import { shows, showSegments } from '@/db/schema/shows';
import { ImportFlow, type SegmentOption } from './import-flow';

export const metadata: Metadata = { title: 'Spreadsheet import' };

/**
 * `/admin/concerts/[concertId]/import` — module `C` (spec/import.md §9).
 *
 * The page itself only answers "which segments can this import target"; every
 * step after that is the client flow, because the admin moves back and forth
 * between mapping and dry run without committing anything.
 *
 * **One import run targets exactly one segment** (§9.1). A hybrid show is loaded
 * by running the import twice, once per file, which is why this lists segments
 * rather than shows.
 */
export default async function ImportPage({
  params,
}: {
  params: Promise<{ concertId: string }>;
}) {
  const { concertId } = await params;
  const id = Number(concertId);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const db = getDb();

  // The concert's zone, for the dry-run export. Never the viewer's (`CLAUDE.md`).
  const [concert] = await db
    .select({ timezone: concerts.timezone })
    .from(concerts)
    .where(eq(concerts.id, id))
    .limit(1);

  const rows = await db
    .select({
      segmentId: showSegments.id,
      segmentName: showSegments.name,
      audienceMode: showSegments.audienceMode,
      showId: shows.id,
      showName: shows.name,
      startsAt: shows.startsAt,
    })
    .from(showSegments)
    .innerJoin(shows, eq(shows.id, showSegments.showId))
    .where(
      and(eq(shows.concertId, id), isNull(shows.deletedAt), isNull(showSegments.deletedAt)),
    )
    .orderBy(asc(shows.startsAt), asc(showSegments.displayOrder));

  /**
   * How many active players carry an email address.
   *
   * The import screen needs this to pick a sensible player-matching strategy
   * and, more importantly, to say why. Matching registrations to players by
   * email is the obvious choice and is silently useless when the player list
   * was loaded from a roster that never had addresses in it — every row blocks
   * with PLAYER_NOT_MATCHED and the reason is two screens away (§9.3).
   */
  const [playerCounts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      withEmail: sql<number>`count(email)::int`,
    })
    .from(players)
    .where(
      and(eq(players.concertId, id), eq(players.isActive, true), isNull(players.deletedAt)),
    );

  const segments: SegmentOption[] = rows.map((r) => ({
    segmentId: r.segmentId,
    showId: r.showId,
    segmentName: r.segmentName,
    audienceMode: r.audienceMode,
    showName: r.showName,
  }));

  return (
    <ImportFlow
      concertId={id}
      segments={segments}
      timeZone={concert?.timezone ?? 'UTC'}
      playerEmails={{
        total: Number(playerCounts?.total ?? 0),
        withEmail: Number(playerCounts?.withEmail ?? 0),
      }}
    />
  );
}
