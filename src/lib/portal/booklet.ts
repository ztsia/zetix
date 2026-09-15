import 'server-only';

import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';

/**
 * The programme booklet a given show's portal offers (§13.3 item 2).
 *
 * **`published` is the booklet's own lifecycle**, and it is why marking a show
 * `COMPLETED` never had to close the portal (decision 39). A booklet can be
 * uploaded weeks early and held back until the day; it ends when an admin
 * unpublishes it, not when a phase changes.
 *
 * `booklets.show_id` null means the booklet covers the whole concert rather than
 * one night — which is the common case for a concert whose two shows share a
 * programme.
 */
export type PortalBooklet = {
  id: number;
  title: string;
};

/**
 * The booklet this show should offer, or null.
 *
 * **A show-specific booklet wins over the concert-wide one.** Both can exist —
 * a concert programme plus a different one for the schools matinee — and the
 * more specific answer is the right one, which is the same precedence the
 * settings cascade uses for every other value (§2.2).
 *
 * Unpublished booklets are invisible here rather than filtered by the caller:
 * the one failure this section can have is a programme leaking before the
 * concert, so `published` belongs in the query that finds it, not in an `if`
 * somebody can forget.
 */
export async function publishedBookletForShow(input: {
  showId: number;
  concertId: number;
}): Promise<PortalBooklet | null> {
  const rows = await getDb().execute<{ id: string | number; title: string }>(sql`
    select b.id, b.title
      from booklets b
     where b.concert_id = ${input.concertId}
       and b.published
       and (b.show_id = ${input.showId} or b.show_id is null)
     order by (b.show_id is null), b.id desc
     limit 1
  `);

  const row = rows[0];
  return row ? { id: Number(row.id), title: row.title } : null;
}

/**
 * The stored path of one booklet, for the route that streams it.
 *
 * Re-checks `published` and re-derives the concert from the booklet row rather
 * than trusting an id off the URL: this is what stops `/booklet?id=…` being a
 * way to read another concert's unpublished programme.
 */
export async function publishedBookletFile(input: {
  bookletId: number;
  showId: number;
  concertId: number;
}): Promise<{ pdfPath: string; title: string } | null> {
  const rows = await getDb().execute<{ pdf_path: string; title: string }>(sql`
    select b.pdf_path, b.title
      from booklets b
     where b.id = ${input.bookletId}
       and b.concert_id = ${input.concertId}
       and b.published
       and (b.show_id = ${input.showId} or b.show_id is null)
     limit 1
  `);

  const row = rows[0];
  return row ? { pdfPath: row.pdf_path, title: row.title } : null;
}
