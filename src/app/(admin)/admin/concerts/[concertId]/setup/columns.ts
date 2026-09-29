/**
 * The concert-level keys `resolve_setting()` reads from a typed column of
 * `concerts` before it looks in `defaults` (`drizzle/0200`, level 3). A value
 * for one of these written to the bag is shadowed by whatever the column
 * holds, so Setup › Concert writes the column instead.
 *
 * `concert.timezone` is the sixth, and is edited in the concert's own form.
 *
 * A plain module, not the actions file: a `'use server'` file may export only
 * async functions.
 */
export const CONCERT_COLUMNS = {
  'portal.enabled': 'portal_enabled',
  'portal.notes_enabled': 'notes_enabled',
  'portal.notes_close_at': 'notes_close_at',
  'portal.public_wall_enabled': 'public_wall_enabled',
  'portal.public_wall_visibility': 'public_wall_visibility',
} as const;

export type ConcertColumnKey = keyof typeof CONCERT_COLUMNS;
