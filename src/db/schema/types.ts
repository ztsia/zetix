import { customType } from 'drizzle-orm/pg-core';

/**
 * `citext` — case-insensitive text, used for every email column
 * (spec/domain.md §5.1, spec/platform.md §16.4).
 *
 * Drizzle has no built-in for it, and the alternative — storing `text` and
 * declaring `unique (concert_id, lower(email))` — puts the case-folding in
 * every index and every query instead of in the type. With `citext`, a plain
 * unique on `(concert_id, email)` already means what §5.1 asks for, and a
 * lookup cannot miss a row by getting the case wrong.
 */
export const citext = customType<{ data: string; driverData: string }>({
  dataType: () => 'citext',
});
