import { defineConfig } from 'drizzle-kit';
import 'dotenv/config';

/**
 * Migrations run against DIRECT_URL — the session pooler on port 5432.
 * DDL needs a session-mode connection; the transaction pooler on 6543 is for
 * the app runtime only. See spec/platform.md §16.2.
 */
export default defineConfig({
  schema: './src/db/schema/*.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL!,
  },
  strict: true,
  verbose: true,
});
