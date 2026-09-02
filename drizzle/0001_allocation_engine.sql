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
-- Make the attendee composite FK deferrable
--------------------------------------------------------------------------------

-- spec/domain.md §5.2: "Moving a registration between segments (§7.6) updates
-- parent and children in one transaction; the constraint is what stops it being
-- done by half."
--
-- With an immediate constraint that move is not merely awkward, it is
-- impossible: updating `attendees` first points them at a registration that is
-- still in the old segment, and updating `registrations` first strands the
-- attendees. There is no ordering that works, and re-creating the attendees is
-- not an option because `qr_token` is immutable for life (decision 28) — a guest
-- holding a printed ticket must still get through the door.
--
-- Deferring to commit is what §5.2 actually describes: the constraint judges the
-- transaction's result rather than its intermediate states, so a half-finished
-- move still fails and a complete one succeeds.
--
-- `registrations_segment_fk` stays immediate: a registration moving to another
-- show changes `show_id` and `segment_id` in the same row, in one statement, so
-- it never passes through an inconsistent state.
alter table attendees drop constraint attendees_registration_fk;--> statement-breakpoint
alter table attendees add constraint attendees_registration_fk
  foreign key (registration_id, segment_id, show_id)
  references registrations (id, segment_id, show_id)
  on delete cascade
  deferrable initially deferred;--> statement-breakpoint

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

  -- Joined to `registrations` on purpose. §7.2 counts attendees by attendee
  -- status, but a seat belonging to a cancelled or soft-deleted registration is
  -- not a booking: §7.9 says cancelling "returns seats to that segment
  -- immediately", and a party whose registration is gone is not sitting in the
  -- hall. Counting them would overstate `confirmed` and understate the pool,
  -- which is the figure §7.5 sizes the FCFS preselection from.
  select count(*)::int into v_confirmed
    from attendees a
    join registrations r on r.id = a.registration_id
   where a.segment_id = p_segment_id
     and a.status = 'CONFIRMED'
     and a.deleted_at is null
     and r.deleted_at is null
     and r.status <> 'CANCELLED';

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
              and a.deleted_at is null
              and r.deleted_at is null
              and r.status <> 'CANCELLED') as claimed
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
  v_segment    show_segments%rowtype;
  v_players    int;
  v_quota      int;
  v_capacity   int;
  v_needed     int;
  v_overridden int;
begin
  select * into v_segment from show_segments where id = p_segment_id;
  if not found or v_segment.deleted_at is not null then return; end if;

  -- Only a player-invited segment promises anybody a base allocation.
  if v_segment.audience_mode <> 'PLAYER_INVITED' then return; end if;

  v_quota    := (resolve_setting('allocation.base_quota', p_segment_id)) #>> '{}';
  v_capacity := (resolve_setting('segment.capacity', p_segment_id)) #>> '{}';

  -- Nothing promised, or no capacity entered yet: nothing to contradict.
  if v_capacity is null then return; end if;

  -- §7.4 writes the check as `base_quota × count(active players)`, which is
  -- exact only while every player is on the segment quota. `player_allocations`
  -- can raise an individual player above it (decision 2), and `segment_pool()`
  -- resolves the quota **per player** — so the literal formula and the pool
  -- disagree the moment an override exists, and the disagreement is an
  -- oversubscription nobody is warned about.
  --
  -- Summing the resolved per-player entitlement is the same number as the spec
  -- formula whenever no override exists, and the true entitlement when one does.
  select
      count(*)::int,
      coalesce(sum(coalesce(pa.base_quota_override, v_quota)), 0)::int,
      count(pa.base_quota_override)::int
    into v_players, v_needed, v_overridden
    from players p
    join shows s on s.id = v_segment.show_id
    left join player_allocations pa
           on pa.player_id = p.id and pa.segment_id = p_segment_id
   where p.concert_id = s.concert_id
     and p.is_active
     and p.deleted_at is null;

  if v_players = 0 or v_needed = 0 or v_needed <= v_capacity then return; end if;

  -- With overrides in play the "N players × Q base" phrasing would be a lie, so
  -- the message says what is actually promised instead.
  if v_overridden > 0 then
    raise exception
      'Those % active players are promised % seats between them (% with a per-player override), but the segment holds %. Raise capacity to %, or lower an override.',
      v_players, v_needed, v_overridden, v_capacity, v_needed;
  end if;

  -- The error names the numbers and the shortfall, and the ways out. A quota of
  -- zero is not one of them — it entitles nobody to anything — so that lever is
  -- offered only when it leaves at least one seat per player.
  raise exception '% active player% × % base = % seats, but the segment holds %. %',
    v_players,
    case when v_players = 1 then '' else 's' end,
    v_quota, v_needed, v_capacity,
    case when v_capacity / v_players >= 1
      then format('Reduce the quota to %s, raise capacity to %s, or deactivate %s player%s.',
                  v_capacity / v_players, v_needed,
                  v_players - (v_capacity / v_quota),
                  case when v_players - (v_capacity / v_quota) = 1 then '' else 's' end)
      else format('Raise capacity to %s, or deactivate %s player%s.',
                  v_needed, v_players - (v_capacity / v_quota),
                  case when v_players - (v_capacity / v_quota) = 1 then '' else 's' end)
    end;
end;
$$;--> statement-breakpoint

-- All of these are DEFERRABLE INITIALLY DEFERRED constraint triggers, checked
-- once at commit rather than after each statement. That is not a performance
-- choice, it is a correctness one: §7.7's worked example moves capacity between
-- two segments ("player 80, public 320"), and an immediate trigger would reject
-- the intermediate state after the first of the two UPDATEs even though the
-- edit as a whole is valid. The same applies to lowering a quota and a capacity
-- together. Callers make such an edit in one transaction; the guard judges the
-- result, not the keystrokes.

-- Routes 1 and 2: the segment's own capacity or quota changed.
create or replace function tg_segment_entitlement() returns trigger
language plpgsql as $$
begin
  perform assert_base_entitlement_fits(new.id);
  return null;
end;
$$;--> statement-breakpoint

drop trigger if exists show_segments_entitlement_guard on show_segments;--> statement-breakpoint
create constraint trigger show_segments_entitlement_guard
  after insert or update on show_segments
  deferrable initially deferred
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

drop trigger if exists players_entitlement_guard on players;--> statement-breakpoint
create constraint trigger players_entitlement_guard
  after insert or update on players
  deferrable initially deferred
  for each row execute function tg_player_entitlement();--> statement-breakpoint

-- Route 4: the quota was raised through the **cascade** rather than on the
-- segment. `concerts.defaults` can supply `allocation.base_quota` for every
-- segment that does not override it, so editing it is editing the quota up —
-- just at a different level. Without this the cascade is a silent fourth route
-- to an oversubscribed segment, which is exactly what §7.4 forbids.
create or replace function tg_concert_entitlement() returns trigger
language plpgsql as $$
declare
  v_segment_id bigint;
begin
  for v_segment_id in
    select g.id
      from show_segments g
      join shows s on s.id = g.show_id
     where s.concert_id = new.id
       and g.audience_mode = 'PLAYER_INVITED'
       and g.deleted_at is null
  loop
    perform assert_base_entitlement_fits(v_segment_id);
  end loop;
  return null;
end;
$$;--> statement-breakpoint

drop trigger if exists concerts_entitlement_guard on concerts;--> statement-breakpoint
create constraint trigger concerts_entitlement_guard
  after update of defaults on concerts
  deferrable initially deferred
  for each row execute function tg_concert_entitlement();--> statement-breakpoint

-- Route 5: a per-player quota override. `player_allocations` is the one place a
-- single player can be promised more than the segment quota, and it was the
-- last unguarded way to oversubscribe: the pool honours the override, so
-- without this the guard and the pool disagree and nothing objects.
create or replace function tg_player_allocation_entitlement() returns trigger
language plpgsql as $$
begin
  perform assert_base_entitlement_fits(new.segment_id);
  return null;
end;
$$;--> statement-breakpoint

drop trigger if exists player_allocations_entitlement_guard on player_allocations;--> statement-breakpoint
create constraint trigger player_allocations_entitlement_guard
  after insert or update on player_allocations
  deferrable initially deferred
  for each row execute function tg_player_allocation_entitlement();--> statement-breakpoint

--------------------------------------------------------------------------------
-- Segments must fit the hall, and must not shed seats people already hold
--------------------------------------------------------------------------------

-- Two invariants from spec/domain.md §5.1 and spec/allocation.md §7.7:
--
--   Σ segment.capacity <= show.capacity
--   segment.capacity   >= that segment's confirmed count
--
-- Both are about *configuration*, not about granting, and neither is the
-- override in §7.6 — that one lets an admin seat more people than the hall
-- holds, deliberately and with a typed confirmation, and `claim_seats()` still
-- enforces it at grant time. This is the different question of whether the
-- numbers an admin typed describe a possible evening.
--
-- It matters beyond tidiness: `segment_pool()` sizes the extras pool from
-- `segment.capacity`, and §7.5 draws the FCFS preselection line from that pool.
-- A segment claiming 999 seats of a 400-seat hall does not oversell — the hall
-- ceiling still holds — but it does invite an admin to grant 989 extras that
-- can never be seated.
create or replace function assert_segments_fit_hall(p_show_id bigint) returns void
language plpgsql as $$
declare
  v_hall      int;
  v_allocated int;
  v_show      shows%rowtype;
begin
  select * into v_show from shows where id = p_show_id;
  if not found or v_show.deleted_at is not null then return; end if;

  v_hall := (resolve_setting('capacity', null, p_show_id)) #>> '{}';
  -- No capacity entered yet is not a contradiction, it is an unfinished form.
  if v_hall is null then return; end if;

  select coalesce(sum(((resolve_setting('segment.capacity', g.id)) #>> '{}')::int), 0)::int
    into v_allocated
    from show_segments g
   where g.show_id = p_show_id
     and g.deleted_at is null;

  if v_allocated > v_hall then
    raise exception
      'The segments of this show total % seats, but the hall holds %. Reduce a segment by % seats, or raise the hall capacity to %.',
      v_allocated, v_hall, v_allocated - v_hall, v_allocated;
  end if;
end;
$$;--> statement-breakpoint

-- "refuses to drop a segment below its confirmed count" (§7.7). Seats already
-- given out cannot be taken back by editing a number: those people hold tickets.
create or replace function assert_capacity_covers_confirmed(p_segment_id bigint) returns void
language plpgsql as $$
declare
  v_capacity  int;
  v_confirmed int;
  v_segment   show_segments%rowtype;
begin
  select * into v_segment from show_segments where id = p_segment_id;
  if not found or v_segment.deleted_at is not null then return; end if;

  v_capacity := (resolve_setting('segment.capacity', p_segment_id)) #>> '{}';
  if v_capacity is null then return; end if;

  v_confirmed := (segment_pool(p_segment_id) ->> 'confirmed')::int;

  if v_capacity < v_confirmed then
    raise exception
      'Segment "%" already has % confirmed seats, so its capacity cannot drop to %. Cancel % registrations first, or move capacity from another segment.',
      v_segment.name, v_confirmed, v_capacity, v_confirmed - v_capacity;
  end if;
end;
$$;--> statement-breakpoint

create or replace function tg_segment_capacity() returns trigger
language plpgsql as $$
begin
  perform assert_capacity_covers_confirmed(new.id);
  perform assert_segments_fit_hall(new.show_id);
  return null;
end;
$$;--> statement-breakpoint

drop trigger if exists show_segments_capacity_guard on show_segments;--> statement-breakpoint
create constraint trigger show_segments_capacity_guard
  after insert or update on show_segments
  deferrable initially deferred
  for each row execute function tg_segment_capacity();--> statement-breakpoint

-- Lowering the hall itself is the same contradiction approached from the other
-- side.
create or replace function tg_show_capacity() returns trigger
language plpgsql as $$
begin
  perform assert_segments_fit_hall(new.id);
  return null;
end;
$$;--> statement-breakpoint

drop trigger if exists shows_capacity_guard on shows;--> statement-breakpoint
create constraint trigger shows_capacity_guard
  after insert or update of capacity on shows
  deferrable initially deferred
  for each row execute function tg_show_capacity();--> statement-breakpoint

--------------------------------------------------------------------------------
-- qr_token is immutable for the life of the attendee
--------------------------------------------------------------------------------

-- Decision 28 and CLAUDE.md: "`qr_token` is immutable for the life of an
-- attendee — reissuing re-renders the PDF, never the token." A guest who kept
-- the printed first copy must still get through the door.
--
-- Nothing on this branch mutates it, but `modules.md` §4 freezes the schema when
-- F1 merges, and module D — which mints tokens and implements reissue — would
-- need a separate schema PR to add this afterwards. It costs three lines here.
--
-- Setting it once (null → value, at issue time) is allowed; changing or
-- clearing it afterwards is not.
create or replace function tg_qr_token_immutable() returns trigger
language plpgsql as $$
begin
  if old.qr_token is not null and new.qr_token is distinct from old.qr_token then
    raise exception 'qr_token is immutable for the life of an attendee (attendee %)', old.id
      using hint = 'Reissuing re-renders the PDF and may repin the template version; it never mints a new token.';
  end if;
  return new;
end;
$$;--> statement-breakpoint

drop trigger if exists attendees_qr_token_immutable on attendees;--> statement-breakpoint
create trigger attendees_qr_token_immutable
  before update of qr_token on attendees
  for each row execute function tg_qr_token_immutable();--> statement-breakpoint

--------------------------------------------------------------------------------
-- Cancelling a registration cancels its seats
--------------------------------------------------------------------------------

-- §7.9: "Cancelling sets status = CANCELLED and returns seats to that segment
-- immediately." `segment_pool()` already treats a cancelled registration's seats
-- as returned — but the attendee rows stayed CONFIRMED, and the door builds its
-- manifest from `attendees.status`. That disagreement shows a cancelled party a
-- green scan instead of "cancelled — refer to desk" (`checkin.md` §12.1).
--
-- Module B owns the cancellation *action*; this keeps the two tables from
-- contradicting each other however B implements it. It never clears
-- `ticket_sent_at`: a ticket that was delivered was delivered, and the door
-- needs to know the code exists so it can say "cancelled" rather than "not
-- found" (§7.9).
create or replace function tg_registration_cancel_cascade() returns trigger
language plpgsql as $$
begin
  if new.status = 'CANCELLED' and old.status is distinct from 'CANCELLED' then
    update attendees
       set status = 'CANCELLED'
     where registration_id = new.id
       and status <> 'CANCELLED';
  end if;
  return null;
end;
$$;--> statement-breakpoint

drop trigger if exists registrations_cancel_cascade on registrations;--> statement-breakpoint
create trigger registrations_cancel_cascade
  after update of status on registrations
  for each row execute function tg_registration_cancel_cascade();--> statement-breakpoint

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
  v_segment_room   int;
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
  v_granted_other  int := 0;
  v_pending        int := 0;
  v_waitlisted     int := 0;
begin
  -- `for update of s` serialises callers, but a caller inside a REPEATABLE READ
  -- or SERIALIZABLE transaction recomputes the pool from the snapshot it took
  -- *before* the lock was granted, so it re-reads stale counts and oversells
  -- with no error at all. Nothing on `shows` is ever updated, so there is no
  -- write conflict for Postgres to detect on our behalf.
  --
  -- "Read current state, then act" inside a repeatable-read transaction is a
  -- natural Server Action shape, so this refuses rather than trusting every
  -- future caller to know.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'claim_seats must run at READ COMMITTED, not %',
      current_setting('transaction_isolation')
      using hint = 'The show row lock cannot protect a caller whose snapshot predates it.';
  end if;

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

  -- The party must be an array of seat objects. Postgres would otherwise fail
  -- inside `jsonb_array_elements` with "cannot extract elements from an object",
  -- which tells the caller nothing about which argument was wrong.
  if p_requests is null or jsonb_typeof(p_requests) <> 'array' then
    raise exception 'claim_seats expects an array of seat requests, got %',
      coalesce(jsonb_typeof(p_requests), 'null')
      using hint = 'One object per seat, e.g. [{"full_name": "Ada", "allocation_type": "BASE"}].';
  end if;

  if exists (select 1 from jsonb_array_elements(p_requests) e
              where jsonb_typeof(e) <> 'object') then
    raise exception 'every seat request must be an object'
      using hint = 'A null or bare value in the array would silently mint a seat nobody asked for.';
  end if;

  -- A JSON null `allocation_type` would otherwise reach `coalesce(…, 'EXTRA')`
  -- and be granted a confirmed seat under a type nobody asked for; an unknown
  -- one would fail deep inside the INSERT and print the whole function body.
  if exists (
    select 1 from jsonb_array_elements(p_requests) e
     where e ->> 'allocation_type' is null
        or e ->> 'allocation_type' not in ('BASE', 'EXTRA', 'HELD', 'COMP')
  ) then
    raise exception 'every seat request needs an allocation_type of BASE, EXTRA, HELD or COMP'
      using hint = 'A missing one is not EXTRA by default — say which kind of seat this is.';
  end if;

  -- Recompute from the database under the lock. Never trust a figure the caller
  -- read before it was taken.
  v_pool := segment_pool(p_segment_id);
  v_extras_room := (v_pool ->> 'extras_pool')::int;

  -- §7.4 grants a BASE seat when the player is still owed one **and**
  -- `open_seats > 0` *in that segment*. The hall having room is a separate,
  -- weaker condition: a segment can be full inside a hall that is not.
  -- `extras_pool` already sits below this figure, so EXTRA was bounded; BASE,
  -- HELD and COMP were not, and could push a full segment past its capacity
  -- with no override and no error.
  -- Floored at zero: an earlier override can leave `open_seats` negative
  -- (§7.2), and a negative must not read as "room for more".
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

  v_quota   := (resolve_setting('allocation.base_quota', p_segment_id)) #>> '{}';
  v_policy  := (resolve_setting('allocation.extras_policy', p_segment_id)) #>> '{}';
  -- An unresolved policy must not mean AUTO_FCFS. §6: "a missing value is a
  -- validation error at save time, not a silent fallback" — and this is the
  -- value that decides whether seats are handed out on submission or held for
  -- the §7.5 review. Falling back to the permissive branch would auto-grant
  -- every extras request in a player segment and leave the review screen with
  -- nothing to review, which is discovered only after the seats are gone.
  --
  -- `allow_partial_grant` below is deliberately not treated this way: its
  -- absence withholds seats rather than giving them away, and §7.5 describes
  -- partial granting as something a segment opts into.
  if v_policy is null then
    raise exception 'segment % has no extras policy set, and there is no default for one',
      p_segment_id
      using hint = 'Set it on the segment, or seed allocation.extras_policy (pnpm db:seed).';
  end if;
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
         and a.deleted_at is null
         and r.deleted_at is null
         and r.status <> 'CANCELLED';

      v_base_room := greatest(0, v_quota - v_base_claimed);
    end if;
  end if;

  -- How many EXTRA seats can be granted at all. Under REVIEW nothing is granted
  -- now: requests hold as PENDING_REVIEW consuming no seats, and the admin
  -- grants in batch after the deadline (§7.4).
  v_extra_wanted := (
    select count(*)::int from jsonb_array_elements(p_requests) e
     where e ->> 'allocation_type' = 'EXTRA'
  );

  if p_override then
    v_extra_grantable := v_extra_wanted;
  elsif v_policy = 'REVIEW' then
    v_extra_grantable := 0;
  else
    v_extra_grantable := least(v_extras_room, v_segment_room, v_hall_headroom, v_extra_wanted);
    -- Strict order, never best-fit: a party that does not fit waits whole
    -- unless partial grants are allowed (§7.5).
    if v_extra_grantable < v_extra_wanted and coalesce(v_partial, false) is not true then
      v_extra_grantable := 0;
    end if;
  end if;

  for v_request in select * from jsonb_array_elements(p_requests)
  loop
    v_type := v_request ->> 'allocation_type';

    if v_type = 'BASE' then
      -- `p_override` relaxes the **capacity ceilings** and nothing else. §7.6
      -- authorises overriding the hall; §7.5 lets an admin grant past the pool.
      -- Neither authorises inventing base entitlement: decision 17 is explicit
      -- that there is no opt-out from the promise made to players, and the two
      -- honest levers are raising the quota or raising capacity.
      if v_base_room > 0 and (p_override or (v_segment_room > 0 and v_hall_headroom > 0)) then
        v_status := 'CONFIRMED';
        v_base_room := greatest(0, v_base_room - 1);
        v_segment_room := greatest(0, v_segment_room - 1);
        v_hall_headroom := greatest(0, v_hall_headroom - 1);
        v_granted_base := v_granted_base + 1;
      else
        -- A player is never refused their base allocation before the deadline
        -- (§7.4); reaching here means the quota is spent, or the segment or hall
        -- is full, and the seat waits rather than being invented. The §7.4 guard
        -- is what makes the full-segment case rare — it is not a licence to skip
        -- the check.
        v_status := 'WAITLIST';
        v_waitlisted := v_waitlisted + 1;
      end if;

    elsif v_type = 'EXTRA' then
      -- Both the policy budget **and** the live room are required. The budget
      -- is computed once before the loop, from the pool as it stood then; the
      -- BASE and HELD/COMP branches below spend `v_segment_room` and
      -- `v_hall_headroom` as they go. Checking only the budget lets one party
      -- spend the same seat twice — a party of 1 BASE + 1 EXTRA into a single
      -- open seat took both, with no override and no error, and it scaled with
      -- the party. That is the ordinary shape of a player's registration after
      -- the base deadline: one base seat plus guests.
      if v_extra_grantable > 0
         and (p_override or (v_segment_room > 0 and v_hall_headroom > 0)) then
        v_status := 'CONFIRMED';
        v_extra_grantable := v_extra_grantable - 1;
        v_segment_room := greatest(0, v_segment_room - 1);
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
      -- HELD and COMP are placed by an admin outside the extras pool, but still
      -- inside the segment and the hall unless overridden.
      if p_override or (v_segment_room > 0 and v_hall_headroom > 0) then
        v_status := 'CONFIRMED';
        v_segment_room := greatest(0, v_segment_room - 1);
        v_hall_headroom := greatest(0, v_hall_headroom - 1);
        -- Counted, and counted separately. Reporting a granted HELD seat as
        -- nothing at all tells the caller the request vanished while the row
        -- exists; folding it into `granted_extra` would tell them a seat came
        -- out of the extras pool, which it did not.
        v_granted_other := v_granted_other + 1;
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
    -- Beyond §7.8's four keys, because HELD and COMP seats are granted by this
    -- function and the four named keys cannot describe them.
    'granted_other', v_granted_other,
    'pending',       v_pending,
    'waitlisted',    v_waitlisted
  );
end;
$$;
