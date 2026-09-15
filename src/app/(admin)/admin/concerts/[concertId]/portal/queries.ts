import 'server-only';

import { and, asc, eq, isNull } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { booklets } from '@/db/schema/booklets';
import { concerts } from '@/db/schema/concerts';
import { shows } from '@/db/schema/shows';

/**
 * What the Portal screen shows (spec/admin.md §14.1, spec/v2.md §13.3).
 *
 * The admin half of a surface whose audience half is `/t/{token}`: booklet
 * upload and publishing, and the concert's practical info. **Unlock mode is
 * deliberately not here** — it is a per-show value and lives on the Shows
 * screen, where `SHOW_KEYS` already resolves it through the cascade. Editing it
 * in two places would make the cascade hint on one of them a lie.
 */

export type BookletRow = {
  id: number;
  title: string;
  published: boolean;
  /** Null means the booklet covers the whole concert rather than one night. */
  showId: number | null;
  showName: string | null;
  createdAt: Date;
};

export type PortalScreen = {
  concertName: string;
  practicalInfoMd: string | null;
  booklets: BookletRow[];
  shows: { id: number; name: string }[];
};

export async function loadPortalScreen(concertId: number): Promise<PortalScreen | null> {
  const db = getDb();

  const [concert] = await db
    .select({ name: concerts.name, practicalInfoMd: concerts.practicalInfoMd })
    .from(concerts)
    .where(and(eq(concerts.id, concertId), isNull(concerts.deletedAt)));
  if (!concert) return null;

  const showRows = await db
    .select({ id: shows.id, name: shows.name })
    .from(shows)
    .where(and(eq(shows.concertId, concertId), isNull(shows.deletedAt)))
    .orderBy(asc(shows.startsAt), asc(shows.name));

  const bookletRows = await db
    .select({
      id: booklets.id,
      title: booklets.title,
      published: booklets.published,
      showId: booklets.showId,
      createdAt: booklets.createdAt,
    })
    .from(booklets)
    .where(eq(booklets.concertId, concertId))
    .orderBy(asc(booklets.id));

  const showName = new Map(showRows.map((s) => [s.id, s.name]));

  return {
    concertName: concert.name,
    practicalInfoMd: concert.practicalInfoMd,
    shows: showRows,
    booklets: bookletRows.map((b) => ({
      ...b,
      showName: b.showId === null ? null : (showName.get(b.showId) ?? null),
    })),
  };
}
