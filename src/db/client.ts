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

/**
 * How long a query may run before Postgres cancels it, in milliseconds.
 *
 * **This must stay below the function's `maxDuration`**, and that ordering is
 * the whole point. Supabase's own default is `2min`, which is *longer* than any
 * function here is allowed to live — so a slow query got the function killed
 * first, leaving the statement still running server-side on a connection the
 * next invocation would inherit. Failing at 25s instead means the error arrives
 * as a catchable `57014` inside the invocation that caused it, where
 * `/api/health` already turns it into a 503.
 *
 * Infrastructure, not an operational value: it is a property of the Vercel
 * plan's function limit, not of this concert, so it does not belong in the
 * settings cascade (`spec/domain.md` §6).
 */
const STATEMENT_TIMEOUT_MS = 25_000;

export function getSql(): Sql {
  if (client) return client;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  client = postgres(connectionString, {
    prepare: false,
    max: 1,

    // Fluid Compute reuses an instance across invocations and *freezes* it in
    // between, so a module-scope connection outlives the request that opened
    // it. Supavisor drops the other end of an idle socket; postgres.js cannot
    // see that happen, writes the next query into a dead socket, and waits —
    // with no timeout configured, for ever. That is the observed production
    // outage: every authenticated route hung while the database sat idle.
    //
    // Closing our own idle connections first means the next request opens a
    // fresh one rather than inheriting a corpse.
    idle_timeout: 20,
    max_lifetime: 60 * 5,
    connect_timeout: 10,
    connection: { statement_timeout: STATEMENT_TIMEOUT_MS },

    // A dying connection rejects whatever it had queued, and those rejections
    // belong to nobody once the request that queued them has been answered.
    // Node treats an unhandled rejection as fatal: the log line is
    // `unhandledRejection … exit status: 128`, and the instance takes every
    // other in-flight request down with it — which is why one slow query
    // presented as *every* route timing out at once.
    //
    // Dropping the cached client is what stops the damage spreading past the
    // one request: the next call to `getSql()` builds a new one instead of
    // handing out a connection that is already gone.
    onclose: () => {
      client = undefined;
      database = undefined;
    },
  });
  return client;
}

let database: ReturnType<typeof drizzle> | undefined;

export function getDb(): ReturnType<typeof drizzle> {
  database ??= drizzle(getSql());
  return database;
}
