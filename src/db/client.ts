import { drizzle } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';

/**
 * Runtime connection. Supabase's transaction pooler (port 6543) does not
 * support prepared statements, so `prepare: false` is mandatory — without it
 * you get intermittent "prepared statement already exists" under concurrency.
 * See spec/platform.md §16.2.
 *
 * `max: 1` because each serverless instance handles one request at a time;
 * the pooler does the multiplexing.
 *
 * Connecting is deferred to first use, and that is load-bearing rather than a
 * style choice. `next build` imports every route module to read its segment
 * config, so anything that touched `DATABASE_URL` at module scope failed the
 * build wherever the variable is absent — which is every Preview deployment,
 * since Preview is deliberately left without credentials so it cannot reach
 * the production database.
 *
 * This reads `process.env.DATABASE_URL` directly rather than going through
 * `src/lib/env.ts`, so it stays importable from scripts and tests that set only
 * that one variable — the local development database needs nothing else (§16.4).
 */
let client: Sql | undefined;

export function getSql(): Sql {
  if (client) return client;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  client = postgres(connectionString, { prepare: false, max: 1 });
  return client;
}

let database: ReturnType<typeof drizzle> | undefined;

export function getDb(): ReturnType<typeof drizzle> {
  database ??= drizzle(getSql());
  return database;
}
