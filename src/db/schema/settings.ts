import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * `system_settings` — the root of the four-level cascade
 * (spec/README.md §2.2, spec/domain.md §6).
 *
 * Key/value rather than one wide row, because the set of tunables grows and a
 * new tunable must not be a migration. `value` is jsonb so a key can hold a
 * number, a string, a boolean, or — for `allocation.extras_policy` — an object
 * keyed by audience mode, which `resolve_setting()` picks from using the
 * segment's own mode.
 *
 * Two populations live here, and they behave differently on a missing value
 * (spec/domain.md §6):
 *
 * - **System values** (`email.max_per_dispatch`, `checkin.scan_debounce_ms`, …)
 *   describe the runtime and are seeded at install, so resolution always finds
 *   one.
 * - **Operational values** (capacities, quotas, deadlines) are NOT seeded. They
 *   are entered per concert through the admin UI, and a missing one is a
 *   validation error at save time, never a silent fallback. Nothing in code
 *   supplies a number for them.
 */
export const systemSettings = pgTable('system_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
});
