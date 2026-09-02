-- The allocation engine: the settings cascade, the segment pool, the
-- base-entitlement guard, and claim_seats().
--
-- These are Postgres functions rather than TypeScript for one reason each:
--
--   claim_seats()          holds a row lock across a read-then-write, so
--                          oversell is impossible (spec/allocation.md §7.8,
--                          decision 15).
--   resolve_setting()      is needed *inside* claim_seats(), and two
--                          implementations of one cascade drift apart
--                          (spec/README.md §2.2).
--   segment_pool()         is the §7.2 arithmetic, read by claim_seats() and by
--                          the extras review header (§7.5).
--   the entitlement guard  must hold on all three mutation routes, including a
--                          direct SQL edit or an import path (§7.4).
--
-- Changing any of them means a new migration with `create or replace`.

--------------------------------------------------------------------------------
-- updated_at
--------------------------------------------------------------------------------

-- A trigger rather than application code: claim_seats() and the raw SQL of
-- spec/email.md §11.4 write rows too, and a column only some writers maintain
-- is worse than no column.
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;--> statement-breakpoint

do $$
declare t text;
begin
  foreach t in array array[
    'concerts', 'shows', 'show_segments', 'ticket_templates', 'players',
    'player_allocations', 'registration_forms', 'registrations', 'attendees',
    'email_outbox', 'portal_notes', 'mapping_profiles', 'system_settings'
  ] loop
    -- `or replace` so the migration can be re-applied to a database that
    -- already has it — a local reset, or a hand-applied run being redone.
    execute format(
      'create or replace trigger %I before update on %I
         for each row execute function set_updated_at()',
      t || '_set_updated_at', t
    );
  end loop;
end;
$$;--> statement-breakpoint

--------------------------------------------------------------------------------
-- resolve_setting() — the four-level cascade (spec/README.md §2.2)
--------------------------------------------------------------------------------

-- segment → show → concert → system, returning the first value that is not
-- null. Returns jsonb so one function serves every key regardless of type.
--
-- A null at a level means "not set here" and the walk continues; it never means
-- zero. Reaching the end without a value returns NULL, which for an operational
-- value is a validation error the caller must report — never a number this
-- function invents (spec/domain.md §6).
create or replace function resolve_setting(
  p_key         text,
  p_segment_id  bigint default null,
  p_show_id     bigint default null,
  p_concert_id  bigint default null
) returns jsonb
language plpgsql stable as $$
declare
  v_segment      show_segments%rowtype;
  v_show         shows%rowtype;
  v_concert      concerts%rowtype;
  v_value        jsonb;
  v_show_id      bigint := p_show_id;
  v_concert_id   bigint := p_concert_id;
begin
  -- Callers should not have to walk the hierarchy by hand just to read a value.
  if p_segment_id is not null then
    select * into v_segment from show_segments where id = p_segment_id;
    v_show_id := coalesce(v_show_id, v_segment.show_id);
  end if;

  if v_show_id is not null then
    select * into v_show from shows where id = v_show_id;
    v_concert_id := coalesce(v_concert_id, v_show.concert_id);
  end if;

  if v_concert_id is not null then
    select * into v_concert from concerts where id = v_concert_id;
  end if;

  -- Level 1: the segment, which is authoritative for every allocation value.
  if v_segment.id is not null then
    v_value := case p_key
      when 'segment.capacity'                then to_jsonb(v_segment.capacity)
      when 'allocation.base_quota'           then to_jsonb(v_segment.base_quota)
      when 'allocation.base_claim_deadline'  then to_jsonb(v_segment.base_claim_deadline)
      when 'allocation.extras_policy'        then to_jsonb(v_segment.extras_policy)
      when 'allocation.allow_partial_grant'  then to_jsonb(v_segment.allow_partial_grant)
      when 'form.max_tickets_per_response'   then to_jsonb(v_segment.max_tickets_per_response)
      else null
    end;
    if v_value is not null then return v_value; end if;
  end if;

  -- Level 2: the show, which owns the hall and the door.
  if v_show.id is not null then
    v_value := case p_key
      when 'capacity'                  then to_jsonb(v_show.capacity)
      when 'portal.unlock_mode'        then to_jsonb(v_show.portal_unlock_mode)
      when 'ticket.default_template_id' then to_jsonb(v_show.ticket_template_id)
      else null
    end;
    if v_value is not null then return v_value; end if;
  end if;

  -- Level 3: the concert — its typed columns first, then its `defaults` bag,
  -- which can carry any key at all.
  if v_concert.id is not null then
    v_value := case p_key
      when 'concert.timezone'              then to_jsonb(v_concert.timezone)
      when 'portal.enabled'                then to_jsonb(v_concert.portal_enabled)
      when 'portal.notes_enabled'          then to_jsonb(v_concert.notes_enabled)
      when 'portal.notes_close_at'         then to_jsonb(v_concert.notes_close_at)
      when 'portal.public_wall_enabled'    then to_jsonb(v_concert.public_wall_enabled)
      when 'portal.public_wall_visibility' then to_jsonb(v_concert.public_wall_visibility)
      else null
    end;
    if v_value is not null then return v_value; end if;

    v_value := v_concert.defaults -> p_key;
    if v_value is not null and jsonb_typeof(v_value) <> 'null' then return v_value; end if;
  end if;

  -- Level 4: the system, the root. Seeded for system values; deliberately empty
  -- for operational ones.
  select value into v_value from system_settings where key = p_key;
  if v_value is null then return null; end if;

  -- One key is stored as an object keyed by audience mode, because decision 4
  -- gives player segments REVIEW and public segments AUTO_FCFS. Keeping that as
  -- data rather than a literal in code is the whole point of §2.1.
  if jsonb_typeof(v_value) = 'object' and v_segment.id is not null
     and v_value ? v_segment.audience_mode::text then
    return v_value -> v_segment.audience_mode::text;
  end if;

  return v_value;
end;
$$;--> statement-breakpoint

--------------------------------------------------------------------------------
-- segment_pool() — the §7.2 arithmetic
--------------------------------------------------------------------------------

--   sellable        = segment.capacity
--   confirmed       = count(attendees in G with status CONFIRMED)
--   unclaimed_base  = Σ over active players of max(0, base_quota(p,G) − base_claimed(p,G))
--   open_seats      = sellable − confirmed
--   extras_pool     = max(0, open_seats − unclaimed_base)   before the deadline
--   extras_pool     = max(0, open_seats)                    after it
--
-- The max(0, …) is not decoration: an admin override (§7.6) can push confirmed
-- past sellable, and the pool must read zero while the screen says "full, N
-- over" — never a negative number that later arithmetic treats as capacity.
create or replace function segment_pool(p_segment_id bigint) returns jsonb
language plpgsql stable as $$
declare
  v_segment        show_segments%rowtype;
  v_sellable       int;
  v_confirmed      int;
  v_unclaimed_base int := 0;
  v_open_seats     int;
  v_extras_pool    int;
  v_quota          int;
  v_deadline       timestamptz;
  v_released       boolean;
begin
  select * into v_segment from show_segments where id = p_segment_id;
  if not found then
    raise exception 'segment % does not exist', p_segment_id;
  end if;

  -- An operational value nobody set is a configuration error, not a zero.
  v_sellable := (resolve_setting('segment.capacity', p_segment_id)) #>> '{}';
  if v_sellable is null then
    raise exception 'segment % has no capacity set, and there is no default for one', p_segment_id
      using hint = 'Set the segment capacity in the admin UI (spec/domain.md §6).';
  end if;

  select count(*)::int into v_confirmed
    from attendees
   where segment_id = p_segment_id
     and status = 'CONFIRMED'
     and deleted_at is null;

  v_quota := (resolve_setting('allocation.base_quota', p_segment_id)) #>> '{}';
  v_deadline := (resolve_setting('allocation.base_claim_deadline', p_segment_id)) #>> '{}';

  -- A null deadline means one was never set, so nothing has been released yet.
  -- Treating "unset" as "passed" would hand players' seats to the extras queue
  -- purely because a field was left blank.
  v_released := v_deadline is not null and now() > v_deadline;

  -- A PUBLIC segment has no players, so it owes no base at all (§7.2).
  if v_segment.audience_mode = 'PLAYER_INVITED' and v_quota is not null then
    select coalesce(sum(greatest(0, per_player.quota - per_player.claimed)), 0)::int
      into v_unclaimed_base
      from (
        select
          coalesce(pa.base_quota_override, v_quota) as quota,
          (select count(*)
             from attendees a
             join registrations r on r.id = a.registration_id
            where a.segment_id = p_segment_id
              and r.player_id = p.id
              and a.allocation_type = 'BASE'
              and a.status = 'CONFIRMED'
              and a.deleted_at is null) as claimed
        from players p
        left join player_allocations pa
               on pa.player_id = p.id and pa.segment_id = p_segment_id
       where p.concert_id = (select concert_id from shows where id = v_segment.show_id)
         and p.is_active
         and p.deleted_at is null
      ) per_player;
  end if;

  v_open_seats := v_sellable - v_confirmed;

  if v_released then
    v_extras_pool := greatest(0, v_open_seats);
  else
    v_extras_pool := greatest(0, v_open_seats - v_unclaimed_base);
  end if;

  return jsonb_build_object(
    'sellable',       v_sellable,
    'confirmed',      v_confirmed,
    -- Still reported after the deadline — the review header shows what was
    -- released (§7.5) — but no longer subtracted from the pool.
    'unclaimed_base', v_unclaimed_base,
    -- The honest signed figure. Only the pool is floored.
    'open_seats',     v_open_seats,
    'extras_pool',    v_extras_pool,
    'over',           greatest(0, v_confirmed - v_sellable),
    'base_released',  v_released
  );
end;
$$;--> statement-breakpoint

--------------------------------------------------------------------------------
-- The base-entitlement guard (spec/allocation.md §7.4, decision 17)
--------------------------------------------------------------------------------

-- "Base entitlement may not exceed segment capacity." Blocked on all three
-- mutations that can breach it — editing segment capacity down, editing base
-- quota up, and adding or reactivating a player — because blocking only one
-- leaves the other two as silent routes to an oversubscribed segment.
--
-- It lives in the database rather than only in the Server Actions so that no
-- route can bypass it: an import, a fix-up script and a hand-written UPDATE are
-- all covered by construction. This is not the case decision 27 rules out —
-- that is about relationships between rows, which composite foreign keys
-- handle. This is an aggregate invariant no foreign key can express.
create or replace function assert_base_entitlement_fits(p_segment_id bigint)
returns void language plpgsql as $$
declare
  v_segment  show_segments%rowtype;
  v_players  int;
  v_quota    int;
  v_capacity int;
  v_needed   int;
begin
  select * into v_segment from show_segments where id = p_segment_id;
  if not found or v_segment.deleted_at is not null then return; end if;

  -- Only a player-invited segment promises anybody a base allocation.
  if v_segment.audience_mode <> 'PLAYER_INVITED' then return; end if;

  v_quota    := (resolve_setting('allocation.base_quota', p_segment_id)) #>> '{}';
  v_capacity := (resolve_setting('segment.capacity', p_segment_id)) #>> '{}';

  -- Nothing promised, or no capacity entered yet: nothing to contradict.
  if v_quota is null or v_capacity is null or v_quota = 0 then return; end if;

  select count(*)::int into v_players
    from players p
    join shows s on s.id = v_segment.show_id
   where p.concert_id = s.concert_id
     and p.is_active
     and p.deleted_at is null;

  if v_players = 0 then return; end if;

  v_needed := v_players * v_quota;
  if v_needed <= v_capacity then return; end if;

  -- The error names the numbers and the shortfall, and the three ways out.
  raise exception
    '% active players × % base = % seats, but the segment holds %. Reduce the quota to %, raise capacity to %, or deactivate % players.',
    v_players, v_quota, v_needed, v_capacity,
    v_capacity / v_players,
    v_needed,
    v_players - (v_capacity / v_quota);
end;
$$;--> statement-breakpoint

-- Route 1 and 2: the segment's own capacity or quota changed.
create or replace function tg_segment_entitlement() returns trigger
language plpgsql as $$
begin
  perform assert_base_entitlement_fits(new.id);
  return null;
end;
$$;--> statement-breakpoint

create or replace trigger show_segments_entitlement_guard
  after insert or update of capacity, base_quota, audience_mode, deleted_at
  on show_segments
  for each row execute function tg_segment_entitlement();--> statement-breakpoint

-- Route 3: a player was added or reactivated. Every player-invited segment in
-- that player's concert gains an entitlement, so each is rechecked.
create or replace function tg_player_entitlement() returns trigger
language plpgsql as $$
declare
  v_segment_id bigint;
begin
  if not new.is_active or new.deleted_at is not null then return null; end if;

  for v_segment_id in
    select g.id
      from show_segments g
      join shows s on s.id = g.show_id
     where s.concert_id = new.concert_id
       and g.audience_mode = 'PLAYER_INVITED'
       and g.deleted_at is null
  loop
    perform assert_base_entitlement_fits(v_segment_id);
  end loop;
  return null;
end;
$$;--> statement-breakpoint

create or replace trigger players_entitlement_guard
  after insert or update of is_active, concert_id, deleted_at
  on players
  for each row execute function tg_player_entitlement();--> statement-breakpoint

--------------------------------------------------------------------------------
-- claim_seats() — spec/allocation.md §7.8
--------------------------------------------------------------------------------

-- **Every grant in the system routes through here**, including manual and
-- admin-created registrations (§7.6), so the counters cannot disagree with
-- reality.
--
-- It locks the **show**, not the segment. Two segments claiming concurrently
-- must not jointly exceed the hall, and a per-segment lock would let exactly
-- that happen while each stayed inside its own slice.
--
-- p_requests is the party: one object per seat wanted, e.g.
--   [{"full_name": "Ada", "email": null, "allocation_type": "BASE"}, …]
--
-- p_override is the deliberate admin escape hatch of §7.6 — "only the hall
-- ceiling is overridable, and only deliberately". The caller is responsible for
-- the typed confirmation and the audit_log row.
create or replace function claim_seats(
  p_segment_id      bigint,
  p_registration_id bigint,
  p_requests        jsonb,
  p_override        boolean default false
) returns jsonb
language plpgsql as $$
declare
  v_segment        show_segments%rowtype;
  v_registration   registrations%rowtype;
  v_pool           jsonb;
  v_hall_capacity  int;
  v_hall_confirmed int;
  v_hall_headroom  int;
  v_extras_room    int;
  v_quota          int;
  v_base_claimed   int;
  v_base_room      int;
  v_policy         text;
  v_partial        boolean;
  v_request        jsonb;
  v_type           text;
  v_status         booking_status;
  v_extra_wanted   int;
  v_extra_grantable int;
  v_granted_base   int := 0;
  v_granted_extra  int := 0;
  v_pending        int := 0;
  v_waitlisted     int := 0;
begin
  -- Serialise per hall. Everything below reads counts and then writes rows;
  -- without this lock two callers read the same figures and both write.
  perform 1
     from shows s
     join show_segments g on g.show_id = s.id
    where g.id = p_segment_id
      for update of s;

  select * into v_segment from show_segments where id = p_segment_id;
  if not found then
    raise exception 'segment % does not exist', p_segment_id;
  end if;

  select * into v_registration from registrations where id = p_registration_id;
  if not found then
    raise exception 'registration % does not exist', p_registration_id;
  end if;
  if v_registration.segment_id <> p_segment_id then
    raise exception 'registration % belongs to segment %, not %',
      p_registration_id, v_registration.segment_id, p_segment_id;
  end if;

  -- Recompute from the database under the lock. Never trust a figure the caller
  -- read before it was taken.
  v_pool := segment_pool(p_segment_id);
  v_extras_room := (v_pool ->> 'extras_pool')::int;

  v_hall_capacity := (resolve_setting('capacity', p_segment_id)) #>> '{}';
  if v_hall_capacity is null then
    raise exception 'show % has no capacity set, and there is no default for one',
      v_segment.show_id
      using hint = 'Set the hall capacity in the admin UI (spec/domain.md §6).';
  end if;

  select count(*)::int into v_hall_confirmed
    from attendees
   where show_id = v_segment.show_id
     and status = 'CONFIRMED'
     and deleted_at is null;

  v_hall_headroom := greatest(0, v_hall_capacity - v_hall_confirmed);

  v_quota   := (resolve_setting('allocation.base_quota', p_segment_id)) #>> '{}';
  v_policy  := (resolve_setting('allocation.extras_policy', p_segment_id)) #>> '{}';
  v_partial := (resolve_setting('allocation.allow_partial_grant', p_segment_id)) #>> '{}';

  -- Base entitlement is counted per *player*, across every registration they
  -- hold — a player registering twice still holds one quota (§7.6).
  v_base_room := 0;
  if v_segment.audience_mode = 'PLAYER_INVITED' and v_registration.player_id is not null then
    select coalesce(pa.base_quota_override, v_quota) into v_quota
      from players p
      left join player_allocations pa
             on pa.player_id = p.id and pa.segment_id = p_segment_id
     where p.id = v_registration.player_id;

    if v_quota is not null then
      select count(*)::int into v_base_claimed
        from attendees a
        join registrations r on r.id = a.registration_id
       where a.segment_id = p_segment_id
         and r.player_id = v_registration.player_id
         and a.allocation_type = 'BASE'
         and a.status = 'CONFIRMED'
         and a.deleted_at is null;

      v_base_room := greatest(0, v_quota - v_base_claimed);
    end if;
  end if;

  -- How many EXTRA seats can be granted at all. Under REVIEW nothing is granted
  -- now: requests hold as PENDING_REVIEW consuming no seats, and the admin
  -- grants in batch after the deadline (§7.4).
  v_extra_wanted := (
    select count(*)::int from jsonb_array_elements(p_requests) e
     where coalesce(e ->> 'allocation_type', 'EXTRA') = 'EXTRA'
  );

  if p_override then
    v_extra_grantable := v_extra_wanted;
  elsif v_policy = 'REVIEW' then
    v_extra_grantable := 0;
  else
    v_extra_grantable := least(v_extras_room, v_hall_headroom, v_extra_wanted);
    -- Strict order, never best-fit: a party that does not fit waits whole
    -- unless partial grants are allowed (§7.5).
    if v_extra_grantable < v_extra_wanted and coalesce(v_partial, false) is not true then
      v_extra_grantable := 0;
    end if;
  end if;

  for v_request in select * from jsonb_array_elements(p_requests)
  loop
    v_type := coalesce(v_request ->> 'allocation_type', 'EXTRA');

    if v_type = 'BASE' then
      if p_override or (v_base_room > 0 and v_hall_headroom > 0) then
        v_status := 'CONFIRMED';
        v_base_room := greatest(0, v_base_room - 1);
        v_hall_headroom := greatest(0, v_hall_headroom - 1);
        v_granted_base := v_granted_base + 1;
      else
        -- A player is never refused their base allocation before the deadline
        -- (§7.4); reaching here means the quota is spent or the hall is full,
        -- and the seat waits rather than being invented.
        v_status := 'WAITLIST';
        v_waitlisted := v_waitlisted + 1;
      end if;

    elsif v_type = 'EXTRA' then
      if v_extra_grantable > 0 then
        v_status := 'CONFIRMED';
        v_extra_grantable := v_extra_grantable - 1;
        v_hall_headroom := greatest(0, v_hall_headroom - 1);
        v_granted_extra := v_granted_extra + 1;
      elsif v_policy = 'REVIEW' and not p_override then
        v_status := 'PENDING_REVIEW';
        v_pending := v_pending + 1;
      else
        v_status := 'WAITLIST';
        v_waitlisted := v_waitlisted + 1;
      end if;

    else
      -- HELD and COMP are placed by an admin outside the pool, but still
      -- inside the hall unless overridden.
      if p_override or v_hall_headroom > 0 then
        v_status := 'CONFIRMED';
        v_hall_headroom := greatest(0, v_hall_headroom - 1);
      else
        v_status := 'WAITLIST';
        v_waitlisted := v_waitlisted + 1;
      end if;
    end if;

    insert into attendees (
      registration_id, show_id, segment_id, full_name, name_source, email,
      allocation_type, status
    ) values (
      p_registration_id,
      v_registration.show_id,
      p_segment_id,
      v_request ->> 'full_name',
      -- An attendee with no name is not an error: it tickets as a placeholder
      -- (decision 32, spec/v2.md §8.2.1).
      case when nullif(trim(coalesce(v_request ->> 'full_name', '')), '') is null
           then 'PLACEHOLDER'::name_source else 'PROVIDED'::name_source end,
      v_request ->> 'email',
      v_type::allocation_type,
      v_status
    );
  end loop;

  return jsonb_build_object(
    'granted_base',  v_granted_base,
    'granted_extra', v_granted_extra,
    'pending',       v_pending,
    'waitlisted',    v_waitlisted
  );
end;
$$;
