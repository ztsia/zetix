import { bigint, timestamp } from 'drizzle-orm/pg-core';

/**
 * Column shapes repeated across the schema.
 *
 * **Key type is `bigint` identity.** spec/allocation.md §7.8 writes the
 * `claim_seats()` signature as `(p_segment_id bigint, p_registration_id bigint,
 * …)`, so the spec has already chosen. `app_users` is the one exception — its
 * id *is* the Supabase Auth user id and so is a uuid — and every column
 * pointing at a person follows it.
 *
 * `mode: 'number'` keeps ids as JS numbers rather than bigints. A concert
 * ticketing system will not reach 2^53 rows, and `bigint` in JS would make
 * every id awkward to serialise across the Server Action boundary.
 */
export const pk = () => bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey();

/** A foreign key to another `pk()`. Nullability and references are set by the caller. */
export const fk = (name: string) => bigint(name, { mode: 'number' });

/**
 * `created_at` / `updated_at` / `deleted_at`, all `timestamptz` in UTC
 * (spec/domain.md §6.1).
 *
 * Deletes are soft and data is retained indefinitely — there is no purge job
 * (decision 7). `updated_at` is maintained by a database trigger rather than by
 * the application, because `claim_seats()` and the raw SQL in
 * spec/email.md §11.4 write rows too, and a value only some writers maintain is
 * worse than none.
 */
export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
};

/** For append-only or write-once tables that carry no update or delete. */
export const createdAt = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
};
