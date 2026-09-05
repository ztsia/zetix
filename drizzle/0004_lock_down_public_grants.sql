-- Close the door Supabase opens by default.
--
-- Found on 5 Sep, applying 0000-0003 to the real project for the first time.
-- **Supabase pre-grants `anon` and `authenticated` every privilege on every
-- table in `public`** — select, insert, update, delete, truncate, references,
-- trigger — 294 grant rows the moment the schema landed. That is its documented
-- posture: the grants are wide and RLS is the only thing holding them back.
--
-- Decision 20b was written expecting the opposite. Its argument is that a policy
-- on a base table is worse than a function because "the moment that grant exists
-- the roster is reachable at `/rest/v1/attendees` by anyone holding the
-- publishable key". The grant did not need to be added by anyone. It was already
-- there, and `anon` is the publishable key, which ships in the browser bundle by
-- design.
--
-- 0003 enabled RLS on the seven roster tables, so the roster itself was never
-- exposed. The other fourteen were: `system_settings` — the whole four-level
-- cascade, capacities and quotas and rate limits — was world-writable, as were
-- `concerts`, `shows`, `show_segments`, `ticket_templates` and `audit_log`.
-- Writable, not merely readable.
--
-- Two independent fixes, because either alone would have been enough and
-- neither is enough to rely on:
--
--   1. take the grants away, so PostgREST cannot see the tables at all;
--   2. enable RLS with no policies on **every** table, so a grant that returns
--      — a new table in a later migration, a Supabase default that reasserts
--      itself — still denies.
--
-- And a second hole, worse than the first and closed here too: **`execute` on a
-- new function is granted to `PUBLIC` by default**, so every function in the
-- schema was callable at `/rest/v1/rpc/<name>` by the publishable key —
-- `claim_seats()` among them. Anyone with the browser bundle could have granted
-- themselves seats. RLS does not cover functions; only the revoke does.
--
-- `service_role` is deliberately left alone. It is the break-glass server-side
-- identity behind `SUPABASE_SERVICE_ROLE_KEY`, it never reaches the browser, and
-- module `H` needs it for `auth.admin.createUser`. The threat model here is the
-- publishable key.
--
-- `tests/schema/rls-lockdown.test.ts` is what keeps this true: a table added by
-- a later module without RLS turns CI red.

--------------------------------------------------------------------------------
-- The roles, where they do not exist
--------------------------------------------------------------------------------

-- Supabase has all three. Local Postgres 16 and CI have none, and a `revoke …
-- from anon` naming a role that does not exist aborts the migration.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin noinherit', r);
    end if;
  end loop;
end;
$$;--> statement-breakpoint

--------------------------------------------------------------------------------
-- 1. Take the grants away
--------------------------------------------------------------------------------

revoke all on all tables in schema public from anon, authenticated;--> statement-breakpoint
revoke all on all sequences in schema public from anon, authenticated;--> statement-breakpoint

-- Functions are the worse half, and revoking from `anon, authenticated` does
-- **not** fix them. Postgres grants `execute` on every new function to `PUBLIC`,
-- and both roles inherit from `PUBLIC`, so the grant has to come off `PUBLIC`
-- itself. Until it does, PostgREST exposes every function in the schema at
-- `/rest/v1/rpc/<name>` to the publishable key — `claim_seats()` included, which
-- would let anyone with the browser bundle grant themselves seats and oversell
-- the hall. That is the one property the whole allocation engine exists to make
-- impossible (`allocation.md` §7.8, decision 15).
--
-- Extension functions are stepped over rather than revoked: `pg_trgm` installs
-- into `public` on a local Postgres, where its grants are its own business, and
-- into `extensions` on Supabase, where this loop never sees it. Touching them
-- would make the two environments differ.
do $$
declare sig text;
begin
  for sig in
    select p.oid::regprocedure::text
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and not exists (
        select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e'
      )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', sig);
  end loop;
end;
$$;--> statement-breakpoint

-- Future tables must not inherit the default either. Only the defaults this
-- role owns can be altered; on Supabase some belong to `supabase_admin` and the
-- statement raises rather than silently doing nothing, which is why it is
-- wrapped. The RLS bolt below is what makes that acceptable rather than a gap.
do $$
begin
  execute 'alter default privileges in schema public revoke all on tables from anon, authenticated';
  execute 'alter default privileges in schema public revoke all on sequences from anon, authenticated';
  execute 'alter default privileges in schema public revoke all on functions from anon, authenticated';
  -- And from PUBLIC, or the next migration that adds a function reopens
  -- /rest/v1/rpc for it. This is the default that exposed claim_seats().
  execute 'alter default privileges in schema public revoke execute on functions from public';
exception
  when insufficient_privilege then
    raise notice 'default privileges left as they are: %', sqlerrm;
end;
$$;--> statement-breakpoint

-- The one grant this system gives (decision 20b). It has to be restored because
-- the blanket function revoke above took it away with everything else.
grant usage on schema public to authenticated;--> statement-breakpoint
grant execute on function public.manifest_for_show(bigint) to authenticated;--> statement-breakpoint

--------------------------------------------------------------------------------
-- 2. Deny by default on every table, not only the roster
--------------------------------------------------------------------------------

-- 0003 listed seven tables by name. Naming them was the mistake: the set that
-- needs protecting is "all of them", and a list is a thing later modules forget
-- to add to. This loops, so it covers every table that exists when it runs, and
-- the test covers every table added after.
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end;
$$;
