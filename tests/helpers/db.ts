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

/**
 * The suite refuses to run against anything but a local host.
 *
 * `resetDb()` truncates all 21 tables. On a developer machine `.env.local`
 * points DATABASE_URL at the real Supabase project, because that is where every
 * service is real (local.md §6) — so without this guard `pnpm test` there is
 * indistinguishable from wiping production, including the shared ADMIN account
 * that can only be recreated with the service-role key.
 *
 * Every environment that is *meant* to run the suite is already local: CI uses
 * a `postgres:16` service on localhost, the cloud container uses
 * localhost:55432, and a developer machine should use `.env.test.local`. So
 * this rejects nothing legitimate. Set DATABASE_URL, do not weaken the check.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'postgres']);

/**
 * Exported so it can be tested against hostile hostnames directly.
 *
 * The match is on the parsed hostname and is **exact**, never a substring: a
 * `url.includes('localhost')` check would wave through
 * `localhost.attacker.example`, and the difference between that and this is the
 * difference between a guard and a comment.
 */
export function assertLocalDatabase(candidate: string): void {
  let host: string;
  try {
    host = new URL(candidate).hostname;
  } catch {
    throw new Error(`DATABASE_URL is not a URL: ${candidate}`);
  }
  if (LOCAL_HOSTS.has(host)) return;
  throw new Error(
    `Refusing to run tests against a non-local database: ${host}. ` +
      'resetDb() truncates every table. Point DATABASE_URL at a local ' +
      'Postgres 16 — put it in `.env.test.local`, which vitest.config.ts loads ' +
      'ahead of `.env.local` for exactly this reason (local.md §6.1).',
  );
}

assertLocalDatabase(url);

export const sql = postgres(url, { prepare: false, max: 4 });
export const db = drizzle(sql);

/**
 * An independent connection, for tests that need two transactions open at once.
 *
 * `claim_seats()` takes a row lock, and a lock is only observable from a
 * *different* session — a second query on the same connection would simply join
 * the same transaction and see nothing. The caller must close it.
 */
export function newConnection(options: Record<string, string> = {}) {
  // Connection-level settings rather than a `set` statement: a separate `set`
  // is a second round trip that can land on a different backend if the pool
  // ever grows, and a lock-wait test whose timeout silently failed to apply
  // hangs instead of failing.
  return postgres(url!, { prepare: false, max: 1, connection: options });
}

let migrated = false;

/** Applies every migration once per process, then empties the tables. */
export async function resetDb(): Promise<void> {
  if (!migrated) {
    await migrate(db, { migrationsFolder: './drizzle' });
    migrated = true;
  }
  /**
   * **The table list is derived from the catalog, never written out.**
   *
   * It used to name twenty-one tables. `email_templates` arrived as the
   * twenty-second and was not added to it, so rows survived `resetDb()` and
   * leaked between test files — a seed test counting eight inserts saw seven,
   * because another file had already written one of them. Nothing failed at the
   * point of the mistake; it failed somewhere else, later, in a way that read
   * like a bug in the code under test.
   *
   * This is `F2`'s own lesson in a second costume. `drizzle/0003` enabled RLS on
   * a named seven and that was the bug `0004` had to fix, which is why
   * `tests/schema/rls-lockdown.test.ts` derives its list from the database
   * instead of restating it. A list of tables is a thing the next module
   * forgets to add to, so there should not be one.
   *
   * `restart identity` so ids are stable per test and a failure message names
   * the same row number every run; `cascade` because the order no longer has to
   * be worked out by hand.
   */
  await sql.unsafe(`
    do $$
    declare stmt text;
    begin
      select 'truncate table '
             || string_agg(format('%I.%I', schemaname, tablename), ', ')
             || ' restart identity cascade'
        into stmt
        from pg_tables
       where schemaname = 'public'
         and tablename <> '__drizzle_migrations';
      if stmt is not null then execute stmt; end if;
    end $$;
  `);
}

export async function closeDb(): Promise<void> {
  await sql.end();
}
