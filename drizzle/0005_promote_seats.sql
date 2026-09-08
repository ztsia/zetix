-- promote_seats() — the other half of the allocation engine
-- (spec/allocation.md §7.5 commit, §7.9 restore).
--
-- `claim_seats()` decides seats that do not exist yet: it inserts. Two flows in
-- module `B` decide seats that already do — the extras review commit, which
-- moves `PENDING_REVIEW` rows granted by an admin to `CONFIRMED`, and restoring
-- a cancelled registration, which returns rows the cancel cascade set to
-- `CANCELLED`. Neither can go through `claim_seats()`: inserting again would
-- mint a second `qr_token` for a seat that already has one, and a guest holding
-- a printed ticket must still get through the door (decision 28).
--
-- So it is a function here rather than a Server Action, for the same reason
-- `claim_seats()` is (decision 15): it holds the **show** row lock across a
-- read-then-write, and it is the only convenient way to write that transition,
-- so no route reaches it without the ceilings being checked.
-- `drizzle/0001_allocation_engine.sql` anticipates exactly this caller:
--
--   > §7.5's review commit legitimately moves granted rows to CONFIRMED: it
--   > opts out through the same transaction-local flag, deliberately and
--   > visibly, and owes the capacity check itself.
--
-- This is that capacity check, written once instead of at each call site.
--
-- Hand-written, like 0001 and 0003: drizzle-kit models no functions. It adds no
-- table and no column, so the schema stays frozen where `modules.md` §4 froze
-- it. Re-applying is safe.

--------------------------------------------------------------------------------
-- What it checks, and what it deliberately does not
--------------------------------------------------------------------------------

-- **The ceilings are segment capacity and hall capacity, not the extras pool.**
-- §7.5: "Ticking beyond the pool is allowed — the row is flagged, the header
-- shows the overage, and commit above the segment's capacity or the hall's
-- requires a typed confirmation." The pool sizes the *preselection*; before the
-- base claim deadline it sits below `open_seats` by the unclaimed base
-- remainder, and an admin who deliberately grants an extra into a seat a player
-- has not claimed is doing something §7.4 allows. Refusing that would make the
-- pool an authority it is not.
--
-- **It refuses rather than raising**, and confirms all of the named rows or
-- none of them. The review screen showed the admin a number; a commit that
-- silently confirmed some of it would leave the screen's arithmetic and the
-- database's disagreeing, and a raise would lose the figures the message needs
-- to explain itself. The caller renders `reason` and either reduces the
-- selection or takes the override.
--
-- `p_override` is the §7.6 escape hatch, exactly as in `claim_seats()`: the
-- caller owns the typed confirmation and the `audit_log` row, and this flag
-- only says the decision was made.
create or replace function promote_seats(
  p_segment_id   bigint,
  p_attendee_ids bigint[],
  p_override     boolean default false
) returns jsonb
language plpgsql as $$
declare
  v_segment        show_segments%rowtype;
  v_pool           jsonb;
  v_segment_room   int;
  v_hall_capacity  int;
  v_hall_confirmed int;
  v_hall_headroom  int;
  v_room           int;
  v_ids            bigint[];
  v_targets        bigint[];
  v_wanted         int;
  v_skipped        int;
  v_confirmed      int;
begin
  -- The same refusal `claim_seats()` makes, for the same reason: a caller
  -- inside REPEATABLE READ recomputes the ceilings from a snapshot taken
  -- *before* the lock was granted, so it reads stale counts and overfills with
  -- no error at all. Nothing on `shows` is ever updated, so there is no write
  -- conflict for Postgres to catch on our behalf.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'promote_seats must run at READ COMMITTED, not %',
      current_setting('transaction_isolation')
      using hint = 'The show row lock cannot protect a caller whose snapshot predates it.';
  end if;

  -- Serialise per hall, before reading a single count. Two admins committing
  -- two segments of the same show must not jointly exceed it.
  perform 1
     from shows s
     join show_segments g on g.show_id = s.id
    where g.id = p_segment_id
      for update of s;

  select * into v_segment from show_segments where id = p_segment_id;
  if not found or v_segment.deleted_at is not null then
    raise exception 'segment % does not exist', p_segment_id;
  end if;

  if p_attendee_ids is null or cardinality(p_attendee_ids) = 0 then
    return jsonb_build_object(
      'confirmed', 0, 'skipped', 0, 'refused', false, 'reason', null);
  end if;

  -- Deduplicated first, so the same id listed twice asks for one seat rather
  -- than reporting a phantom skip.
  v_ids := array(select distinct unnest(p_attendee_ids));

  -- **Every row is re-derived from the ids under the lock.** The ids arrive
  -- from a request body, so this is where they are tied to the segment the
  -- caller named — without it a list of attendee ids reaches straight past the
  -- segment and the concert boundary. Rows already CONFIRMED, soft-deleted, or
  -- hanging off a cancelled or deleted registration are not promotable and are
  -- counted as skipped rather than silently included in the ceiling arithmetic.
  --
  -- An array rather than a temporary table: two calls in one transaction is an
  -- ordinary thing for a caller to do — the review commit grants one segment
  -- while a restore returns another — and `create temporary table` would fail
  -- the second one with "relation already exists".
  v_targets := array(
    select a.id
      from attendees a
      join registrations r on r.id = a.registration_id
     where a.id = any(v_ids)
       and a.segment_id = p_segment_id
       and a.status <> 'CONFIRMED'
       and a.deleted_at is null
       and r.deleted_at is null
       and r.status <> 'CANCELLED');

  v_wanted  := cardinality(v_targets);
  v_skipped := cardinality(v_ids) - v_wanted;

  if v_wanted = 0 then
    return jsonb_build_object(
      'confirmed', 0, 'skipped', v_skipped, 'refused', false, 'reason', null);
  end if;

  -- Recomputed here, never trusted from the caller: the screen's figures were
  -- read before the lock, and another commit may have spent the room since.
  v_pool := segment_pool(p_segment_id);
  -- Floored at zero: an earlier override can leave `open_seats` negative
  -- (§7.2), and a negative must not read as room for more.
  v_segment_room := greatest(0, (v_pool ->> 'open_seats')::int);

  v_hall_capacity := (resolve_setting('capacity', p_segment_id)) #>> '{}';
  if v_hall_capacity is null then
    raise exception 'show % has no capacity set, and there is no default for one',
      v_segment.show_id
      using hint = 'Set the hall capacity in the admin UI (spec/domain.md §6).';
  end if;

  select count(*)::int into v_hall_confirmed
    from attendees a
    join registrations r on r.id = a.registration_id
   where a.show_id = v_segment.show_id
     and a.status = 'CONFIRMED'
     and a.deleted_at is null
     and r.deleted_at is null
     and r.status <> 'CANCELLED';

  v_hall_headroom := greatest(0, v_hall_capacity - v_hall_confirmed);
  v_room := least(v_segment_room, v_hall_headroom);

  if not p_override and v_wanted > v_room then
    return jsonb_build_object(
      'confirmed', 0,
      'skipped', v_skipped,
      'refused', true,
      -- The numbers and the ways out, in the shape 0001's guards use: this
      -- sentence is rendered verbatim to the admin.
      'reason', format(
        'Confirming %s seat%s would put segment "%s" over. It has %s seat%s free, and the hall has %s. Reduce the selection to %s, raise a capacity, or confirm the overfill deliberately.',
        v_wanted, case when v_wanted = 1 then '' else 's' end,
        v_segment.name,
        v_segment_room, case when v_segment_room = 1 then '' else 's' end,
        v_hall_headroom, v_room));
  end if;

  -- The deliberate, greppable opt-out of `attendees_promotion_guard`. It is
  -- transaction-local, so it cannot leak to another statement on this
  -- connection once this one commits or rolls back.
  perform set_config('zetix.granting', 'on', true);

  update attendees
     set status = 'CONFIRMED'
   where id = any(v_targets);
  get diagnostics v_confirmed = row_count;

  perform set_config('zetix.granting', 'off', true);

  return jsonb_build_object(
    'confirmed', v_confirmed,
    'skipped',   v_skipped,
    'refused',   false,
    'reason',    null);
end;
$$;
--> statement-breakpoint

--------------------------------------------------------------------------------
-- And take the default grant straight back off it
--------------------------------------------------------------------------------

-- Postgres grants `execute` on every new function to `PUBLIC`, and both `anon`
-- and `authenticated` inherit from `PUBLIC` — so a function created after
-- `0004_lock_down_public_grants.sql` ran quietly reopens the door that migration
-- closed. This one confirms seats, which is precisely the door: anyone holding
-- the browser bundle's publishable key could call it through PostgREST and
-- promote whatever attendee ids they liked. RLS does not cover functions; only
-- the revoke does.
--
-- `tests/schema/rls-lockdown.test.ts` is what caught this, and it stays the
-- guard: it asserts the callable-by-`authenticated` list is exactly
-- `manifest_for_show`, so any future function added without this line turns the
-- suite red rather than shipping.
revoke all on function promote_seats(bigint, bigint[], boolean)
  from public, anon, authenticated;
