import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/**
 * The test database is a **real local Postgres 16**, never a mock
 * (spec/platform.md §16.4). `claim_seats()` holds a row lock across a
 * read-then-write, and a mock that cannot take a lock cannot prove the one
 * property the function exists for.
 *
 * `prepare: false` mirrors the runtime client: the Supabase transaction pooler
 * does not support prepared statements (spec/platform.md §16.2), so the tests
 * exercise the same connection shape production does.
 */
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set — run `pnpm db:local`');

export const sql = postgres(url, { prepare: false, max: 4 });
export const db = drizzle(sql);

let migrated = false;

/** Applies every migration once per process, then empties the tables. */
export async function resetDb(): Promise<void> {
  if (!migrated) {
    await migrate(db, { migrationsFolder: './drizzle' });
    migrated = true;
  }
  // `restart identity` so ids are stable per test and a failure message names
  // the same row number every run.
  await sql`
    truncate table
      audit_log, check_ins, portal_notes, email_outbox, attendees, registrations,
      form_responses, registration_forms, import_batches, mapping_profiles,
      player_allocations, players, operator_show_assignments, app_users,
      booklets, show_segments, shows, ticket_templates, concerts, system_settings
    restart identity cascade
  `;
}

export async function closeDb(): Promise<void> {
  await sql.end();
}
