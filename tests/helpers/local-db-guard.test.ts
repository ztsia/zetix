import { describe, expect, it } from 'vitest';
import { assertLocalDatabase } from './db';

/**
 * The guard that stands between `pnpm test` and the production database.
 *
 * `resetDb()` truncates all 21 tables, and on a developer machine `.env.local`
 * points `DATABASE_URL` at real Supabase (local.md §6.1). The guard is the only
 * thing that makes running the suite there a loud failure rather than an empty
 * production database — including the shared `ADMIN` account, which needs the
 * service-role key to recreate.
 *
 * A guard is only worth the line it occupies if it is exact. The hostile cases
 * below are all hostnames that *contain* a local name, and a substring check
 * would wave every one of them through.
 */
describe('assertLocalDatabase', () => {
  const allowed = [
    'postgresql://postgres@localhost:55432/zetix',
    'postgresql://postgres:postgres@localhost:5432/zetix',
    'postgresql://postgres@127.0.0.1:5432/zetix',
    'postgresql://postgres@[::1]:5432/zetix',
    // The docker-compose service name CI could use.
    'postgresql://postgres:postgres@postgres:5432/zetix',
  ];

  for (const url of allowed) {
    it(`allows ${new URL(url).hostname}`, () => {
      expect(() => assertLocalDatabase(url)).not.toThrow();
    });
  }

  const refused = [
    // The one that actually matters: what `.env.local` holds on this machine.
    'postgresql://postgres.ref:pw@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres',
    'postgresql://postgres:pw@db.abcdefghijklmnopqrst.supabase.co:5432/postgres',
    // Hostnames that merely contain a local name.
    'postgresql://postgres@localhost.attacker.example:5432/zetix',
    'postgresql://postgres@notlocalhost:5432/zetix',
    'postgresql://postgres@mylocalhost:5432/zetix',
    'postgresql://postgres@127.0.0.1.attacker.example:5432/zetix',
    'postgresql://postgres@postgres.example.com:5432/zetix',
  ];

  for (const url of refused) {
    it(`refuses ${new URL(url).hostname}`, () => {
      expect(() => assertLocalDatabase(url)).toThrow(/non-local database/);
    });
  }

  it('refuses something that is not a URL at all', () => {
    expect(() => assertLocalDatabase('zetix')).toThrow(/not a URL/);
  });
});
