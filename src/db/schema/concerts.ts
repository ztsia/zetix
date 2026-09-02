import { boolean, date, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { concertStatus, publicWallVisibility } from './enums';
import { pk, timestamps } from './columns';

/**
 * `concerts` — the event as a whole (spec/domain.md §5.1).
 *
 * `defaults` is the concert level of the cascade: a jsonb bag of the same keys
 * `system_settings` holds, overriding them for this concert only. Shows and
 * segments override it with typed columns of their own. Nothing reads any of
 * these three directly — everything goes through `resolveSetting`
 * (spec/README.md §2.2).
 *
 * Every cascading column here is nullable on purpose. A null means "not set at
 * this level", which is the only way the cascade can work; it never means zero.
 */
export const concerts = pgTable(
  'concerts',
  {
    id: pk(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    season: text('season'),
    startsOn: date('starts_on'),
    endsOn: date('ends_on'),
    status: concertStatus('status').notNull(),

    /** Concert level of the cascade (spec/README.md §2.2). */
    defaults: jsonb('defaults'),

    /**
     * IANA zone. Every show time is stored UTC and rendered in this, never in
     * the viewer's zone — an audience member travelling must see the time at
     * the venue (spec/domain.md §6.1).
     *
     * §5.1 omits this column while §6 and §6.1 both require the value; it is
     * added here because rendering a show time is impossible without it.
     */
    timezone: text('timezone'),

    portalEnabled: boolean('portal_enabled'),
    notesEnabled: boolean('notes_enabled'),
    notesCloseAt: timestamp('notes_close_at', { withTimezone: true }),
    publicWallEnabled: boolean('public_wall_enabled'),
    publicWallVisibility: publicWallVisibility('public_wall_visibility'),
    practicalInfoMd: text('practical_info_md'),

    ...timestamps,
  },
  (t) => [uniqueIndex('concerts_slug_key').on(t.slug)],
);
