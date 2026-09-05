import { beforeAll, describe, expect, it } from 'vitest';
import { resetDb, sql } from '../helpers/db';

/**
 * Every table in `public` denies by default, and `anon` / `authenticated` hold
 * nothing.
 *
 * This exists because of what applying the schema to the real Supabase project
 * on 5 Sep turned up: **Supabase pre-grants `anon` and `authenticated` every
 * privilege on every table in `public`.** Not select — every privilege, 294 rows
 * of it, the moment the tables were created. `anon` is the publishable key, and
 * the publishable key ships in the browser bundle by design.
 *
 * Decision 20b's whole argument was that a base-table grant would publish the
 * roster at `/rest/v1/attendees`. That grant was never something a careless
 * future diff might add. It was already there. `0003` had enabled RLS on the
 * seven roster tables, so the roster held; `system_settings` — the settings
 * cascade, every capacity and quota and rate limit — was world-writable, and so
 * were `concerts`, `shows`, `show_segments`, `ticket_templates` and `audit_log`.
 *
 * `0004` revokes the grants and enables RLS on *every* table rather than a named
 * seven. Naming seven was the original mistake: the set that needs protecting is
 * all of them, and a list is a thing the next module forgets to add to. So this
 * test derives the list from the database instead of restating it — **a table
 * added by a later module with no RLS turns this red**, which is the only reason
 * the property will still hold on 19 Sep.
 *
 * The grant half is close to vacuous against a local Postgres, where nothing is
 * pre-granted; it is not vacuous where it matters, and `local.md` §5a re-checks
 * both halves against real Supabase. The RLS half is meaningful everywhere, and
 * `tests/auth/manifest-rpc.test.ts` proves RLS actually refuses a read once a
 * grant exists.
 */
describe('the public schema denies by default', () => {
  beforeAll(async () => {
    // Applies every migration; the tables have to exist to be inspected.
    await resetDb();
  });

  it('has row level security on every table, with no exceptions', async () => {
    const rows = await sql<{ tablename: string }[]>`
      select t.tablename
      from pg_tables t
      join pg_class c
        on c.relname = t.tablename
       and c.relnamespace = 'public'::regnamespace
      where t.schemaname = 'public'
        and not c.relrowsecurity
        and t.tablename <> '__drizzle_migrations'
      order by t.tablename
    `;

    expect(
      rows.map((r) => r.tablename),
      'every table in public must enable RLS — see drizzle/0004_lock_down_public_grants.sql. ' +
        'A new table needs `alter table … enable row level security` in its own migration.',
    ).toEqual([]);
  });

  it('covers every table the schema actually has', async () => {
    // Guards the test above against passing because it found nothing to check.
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_tables where schemaname = 'public'
    `;
    expect(n).toBeGreaterThan(20);
  });

  it('grants anon and authenticated nothing on any table', async () => {
    const rows = await sql<{ table_name: string; grantee: string; privilege_type: string }[]>`
      select table_name, grantee, privilege_type
      from information_schema.role_table_grants
      where table_schema = 'public'
        and grantee in ('anon', 'authenticated', 'PUBLIC')
      order by table_name, grantee, privilege_type
    `;
    expect(rows).toEqual([]);
  });

  it('grants them nothing on any sequence either', async () => {
    // A sequence grant is not a data leak, but `usage` on one is how a role that
    // should hold nothing ends up holding something, and it costs a line.
    const rows = await sql<{ object_name: string; grantee: string }[]>`
      select object_name, grantee
      from information_schema.role_usage_grants
      where object_schema = 'public'
        and grantee in ('anon', 'authenticated', 'PUBLIC')
      order by object_name, grantee
    `;
    expect(rows).toEqual([]);
  });

  it('leaves exactly one function callable by authenticated', async () => {
    // The whole surface `anon` and `authenticated` are given: one function
    // (decision 20b). `anon` gets nothing at all — the manifest is for a
    // signed-in operator.
    // Read from `pg_proc` rather than `information_schema`, so that functions
    // belonging to an extension can be excluded. `pg_trgm` installs into
    // `public` on a local Postgres and grants execute to PUBLIC, which is its
    // business and not ours; on Supabase it lands in `extensions` and never
    // shows up here at all. Without the exclusion this test says something
    // different in the two places.
    const rows = await sql<{ routine_name: string; grantee: string }[]>`
      select p.proname as routine_name,
             case when a.grantee = 0 then 'PUBLIC'
                  else a.grantee::regrole::text end as grantee
      from pg_proc p
      cross join lateral aclexplode(
        coalesce(p.proacl, acldefault('f', p.proowner))
      ) a
      where p.pronamespace = 'public'::regnamespace
        and a.privilege_type = 'EXECUTE'
        and not exists (
          select 1 from pg_depend d
          where d.objid = p.oid and d.deptype = 'e'
        )
        and (
          a.grantee = 0
          or a.grantee::regrole::text in ('anon', 'authenticated')
        )
      order by 1, 2
    `;
    expect(rows).toEqual([
      { routine_name: 'manifest_for_show', grantee: 'authenticated' },
    ]);
  });
});
