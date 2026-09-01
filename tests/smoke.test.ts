import { describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * Proves the local development database is reachable and carries the three
 * extensions the schema needs (spec/platform.md §16.4). If this fails, run
 * `pnpm db:local` — everything else in the suite depends on it.
 */
describe('local database', () => {
  it('answers and has citext, pg_trgm, pgcrypto', async () => {
    const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
    try {
      const rows = await sql<{ extname: string }[]>`
        select extname from pg_extension
         where extname in ('citext', 'pg_trgm', 'pgcrypto')
         order by extname
      `;
      expect(rows.map((r) => r.extname)).toEqual(['citext', 'pg_trgm', 'pgcrypto']);
    } finally {
      await sql.end();
    }
  });
});
