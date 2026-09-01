import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

/**
 * Runtime connection. Supabase's transaction pooler (port 6543) does not
 * support prepared statements, so `prepare: false` is mandatory — without it
 * you get intermittent "prepared statement already exists" under concurrency.
 * See spec.md §16.2.
 *
 * `max: 1` because each serverless instance handles one request at a time;
 * the pooler does the multiplexing.
 */
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is not set');

const client = postgres(connectionString, { prepare: false, max: 1 });

export const db = drizzle(client);
export { client as sql };
