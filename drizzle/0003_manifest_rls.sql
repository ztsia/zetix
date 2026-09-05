-- The second layer decision 20 requires: the show-scope check, in the database.
--
-- Decision 20 asks for the check "in the handler and again by RLS — the handler
-- is the contract, RLS is what survives a mistake in the handler." Module `F2`
-- built the handler half (`canAccessShow()`); this is the other half.
--
-- **It is a `security definer` function reached through PostgREST, not a policy
-- on `attendees`** — recorded as decision 20b, because a mechanism swap on a
-- settled decision should be visible in a diff. The short version: PostgREST
-- can only read a table the `authenticated` role has been *granted*, and the
-- moment that grant exists the roster is reachable at
-- `https://<ref>.supabase.co/rest/v1/attendees` by anyone holding the
-- publishable key, which ships in the browser bundle by design. That is one
-- layer on a newly opened door, not two independent ones. `execute` on one
-- function opens no such door.
--
-- Hand-written, like 0001: drizzle-kit models neither functions nor grants.
-- Re-applying it is safe — `create or replace` and idempotent grants
-- throughout.

--------------------------------------------------------------------------------
-- The `authenticated` role
--------------------------------------------------------------------------------

-- Supabase already has it; local Postgres 16 and CI do not, and the grant below
-- has to resolve in all three or the migration is untestable where it can
-- actually be tested (spec/platform.md §16.4). `nologin` because nothing ever
-- connects as it — PostgREST assumes it with `set role`.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
end;
$$;--> statement-breakpoint

--------------------------------------------------------------------------------
-- Who is calling
--------------------------------------------------------------------------------

-- The same claim `auth.uid()` reads, read without depending on the `auth`
-- schema. PostgREST sets `request.jwt.claims` on every request it serves, so
-- this returns exactly what `auth.uid()` returns on Supabase — and returns null
-- on the Drizzle path and in tests, where nothing sets it.
--
-- Not `auth.uid()` itself for two reasons: the `auth` schema is owned by the
-- platform and a migration has no business writing there, and local Postgres 16
-- has no such schema, which would leave the one function that matters testable
-- only in production.
--
-- A malformed or missing claim resolves to **nobody**, never to an error: a
-- caller who can make this throw gets a 500 out of the manifest endpoint, and a
-- 500 is a louder oracle than an empty list.
create or replace function public.jwt_sub() returns uuid
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  claims text := nullif(current_setting('request.jwt.claims', true), '');
  sub text;
begin
  if claims is null then
    return null;
  end if;
  sub := claims::jsonb ->> 'sub';
  if sub is null then
    return null;
  end if;
  return sub::uuid;
exception
  when others then
    return null;
end;
$$;--> statement-breakpoint

--------------------------------------------------------------------------------
-- The manifest
--------------------------------------------------------------------------------

-- `GET /api/checkin/manifest` returns the full attendee roster for a show, so
-- this is the boundary that matters (spec/checkin.md §12.3). Module `G` reaches
-- it as `.rpc('manifest_for_show', { p_show_id })` through `supabase-js`, which
-- is the first and — for now — only PostgREST call in the codebase.
--
-- The seven columns are §12.3's, exactly.
--
--   qr_token_sha256  the manifest lands in IndexedDB on an usher's phone, and a
--                    raw token there is a usable ticket for whoever picks the
--                    phone up. `sha256()` is core Postgres, not pgcrypto, so
--                    this resolves under a pinned search_path in every
--                    environment.
--   party_size       excludes cancelled seats: it drives "Admit remaining 3"
--                    (§12.1), and a cancelled seat is not one of the remaining.
--
-- Cancelled attendees are still returned. The door must be able to say
-- "cancelled — refer to desk" rather than "invalid ticket"
-- (spec/allocation.md §7.9); omitting them makes the door lie.
--
-- An unassigned operator, a deactivated one, a subject that is not an
-- `app_users` row, an absent claim, and a show that does not exist all return
-- **zero rows** — never an error. Probing ids must not tell "not yours" from
-- "not there" (modules.md §5.2.1), and that is a property of the query rather
-- than of a handler's choice of status code.
--
-- `security definer` is what lets a caller with no table grants read these
-- tables at all, and `set search_path` is what stops that being a way in: with
-- the path unpinned, anyone who can create objects could shadow a table name
-- and have the definer run their version as the owner.
create or replace function public.manifest_for_show(p_show_id bigint)
returns table (
  qr_token_sha256 text,
  ticket_code text,
  name text,
  player_name text,
  status booking_status,
  registration_id bigint,
  party_size integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with caller as (
    select u.id, u.role
    from app_users u
    where u.id = public.jwt_sub()
      and u.is_active
      and u.deleted_at is null
  ),
  permitted as (
    select 1
    from caller c
    where c.role = 'ADMIN'
       or exists (
         select 1
         from operator_show_assignments osa
         where osa.user_id = c.id
           and osa.show_id = p_show_id
       )
  )
  select
    encode(sha256(convert_to(a.qr_token, 'UTF8')), 'hex'),
    a.ticket_code,
    a.full_name,
    p.full_name,
    a.status,
    a.registration_id,
    (count(*) filter (where a.status <> 'CANCELLED')
       over (partition by a.registration_id))::int
  from attendees a
  join registrations r on r.id = a.registration_id
  left join players p on p.id = r.player_id
  where a.show_id = p_show_id
    and a.deleted_at is null
    and exists (select 1 from permitted)
$$;--> statement-breakpoint

--------------------------------------------------------------------------------
-- Grants: execute on one function, and nothing else
--------------------------------------------------------------------------------

-- Postgres grants `execute` on a new function to `PUBLIC` by default, so the
-- revoke is not tidiness — without it, `anon` can call the manifest, and `anon`
-- is the publishable key that ships in the browser bundle.
revoke all on function public.jwt_sub() from public;--> statement-breakpoint
revoke all on function public.manifest_for_show(bigint) from public;--> statement-breakpoint

-- The only grant this system gives the `authenticated` role. If a `grant select`
-- on `attendees`, `registrations` or `check_ins` ever appears in a diff, that is
-- the regression — `tests/auth/manifest-rpc.test.ts` fails on it, and
-- `local.md` §5a re-checks it against real Supabase, where the publishable key
-- makes it directly exploitable.
grant execute on function public.manifest_for_show(bigint) to authenticated;--> statement-breakpoint

--------------------------------------------------------------------------------
-- Deny by default on the roster tables
--------------------------------------------------------------------------------

-- Belt to the grants' braces, and the part that makes decision 20's wording
-- literally true rather than only its intent. Enabling RLS with **no policies**
-- denies every non-owner role outright.
--
-- It costs the application nothing: the app connects as the owner over Drizzle,
-- and an owner bypasses RLS on a table that is not `force`d. It is not `force`d
-- deliberately — `claim_seats()` and the allocation triggers run as the owner
-- and must keep working exactly as their tests describe.
--
-- What it buys is the failure mode. If a table grant ever leaks in, the door it
-- opens is already bolted; and if the non-owner-role option is taken after the
-- concert, every unconverted read fails loudly here instead of quietly
-- returning another show's roster.
do $$
declare t text;
begin
  foreach t in array array[
    'attendees', 'registrations', 'check_ins', 'app_users',
    'operator_show_assignments', 'players', 'email_outbox'
  ] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end;
$$;
