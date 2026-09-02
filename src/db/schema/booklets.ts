import { boolean, index, pgTable, text } from 'drizzle-orm/pg-core';
import { concerts } from './concerts';
import { shows } from './shows';
import { createdAt, fk, pk } from './columns';

/**
 * `booklets` — the e-booklet PDF (spec/domain.md §5.1).
 *
 * Served from Supabase Storage with range requests; it is the only asset
 * downloaded at scale, so it is also the egress ceiling (decision 13,
 * spec/platform.md §17.2). `show_id` null means the booklet covers the whole
 * concert rather than one night.
 */
export const booklets = pgTable(
  'booklets',
  {
    id: pk(),
    concertId: fk('concert_id')
      .notNull()
      .references(() => concerts.id, { onDelete: 'cascade' }),
    showId: fk('show_id').references(() => shows.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    pdfPath: text('pdf_path').notNull(),
    published: boolean('published').notNull().default(false),
    ...createdAt,
  },
  (t) => [index('booklets_concert_idx').on(t.concertId)],
);
