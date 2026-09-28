-- 0204 — intake (module `V`, spec/v3.md §25).
--
--   form_responses      registration_id: every response knows its party. A
--                       submission merged into an existing party by email
--                       (§25.5) is a second response of that party but not an
--                       edit of the first, so `registrations.form_response_id`
--                       (the newest in the edit chain) cannot find it.
--   registration_forms  waitlist_when_full: waitlist mode (§25.6).
--   normalise_phone(), phones_match(), refresh_duplicate_candidates():
--                       duplicate detection (§25.5), in Postgres because the
--                       name half is `pg_trgm` and runs over the whole show.
--
-- Additive (`modules-v3.md` §3.3).

ALTER TABLE "form_responses" ADD COLUMN "registration_id" bigint;--> statement-breakpoint
ALTER TABLE "registration_forms" ADD COLUMN "waitlist_when_full" boolean;--> statement-breakpoint
ALTER TABLE "form_responses" ADD CONSTRAINT "form_responses_registration_id_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "form_responses_registration_idx" ON "form_responses" USING btree ("registration_id");--> statement-breakpoint

-- Backfill: every response in a party's edit chain belongs to that party. The
-- registration points at the newest; `supersedes_id` walks back to the first.
with recursive chain as (
  select r.form_response_id as response_id, r.id as registration_id
    from registrations r
   where r.form_response_id is not null
  union all
  select fr.supersedes_id, c.registration_id
    from chain c
    join form_responses fr on fr.id = c.response_id
   where fr.supersedes_id is not null
)
update form_responses fr
   set registration_id = c.registration_id
  from chain c
 where fr.id = c.response_id
   and fr.registration_id is null;--> statement-breakpoint

-- A phone number as digits only; null when there are none.
create or replace function normalise_phone(p_phone text) returns text
language sql immutable
set search_path = public, pg_temp
as $$
  select nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), '')
$$;--> statement-breakpoint

-- Two phone numbers are the same number when their digits are equal, or when
-- one is the other written with a country or trunk prefix (the longer ends with
-- the shorter). Seven digits is the shortest subscriber number this treats as
-- specific enough to match on a suffix: it is a property of phone numbers, not
-- an operational value, so it is not in the settings cascade.
create or replace function phones_match(p_a text, p_b text) returns boolean
language sql immutable
set search_path = public, pg_temp
as $$
  select case
    when normalise_phone(p_a) is null or normalise_phone(p_b) is null then false
    when normalise_phone(p_a) = normalise_phone(p_b) then true
    when length(normalise_phone(p_a)) >= 7
         and right(normalise_phone(p_b), length(normalise_phone(p_a))) = normalise_phone(p_a) then true
    when length(normalise_phone(p_b)) >= 7
         and right(normalise_phone(p_a), length(normalise_phone(p_b))) = normalise_phone(p_b) then true
    else false
  end
$$;--> statement-breakpoint

-- Find and store the duplicate candidates of one party (spec/v3.md §25.5).
--
-- A candidate is another live party in the same show — across players and
-- across segments — that shares the contact email (citext folds case), the
-- phone after normalisation, or a contact or seat name at or above
-- `review.duplicate_name_similarity`. The pair is stored ordered, so the same
-- two parties are only ever one row.
--
-- **A decided pair stays decided.** The upsert refreshes the reasons of an
-- `OPEN` pair and leaves a `DISMISSED` or `MERGED` one alone: "Not a duplicate"
-- has to stick however often detection runs.
--
-- An unset similarity threshold matches no names rather than guessing one
-- (`domain.md` §6). Placeholder seat names ("Guest 2") are not names.
--
-- `search_path` includes `extensions` because Supabase installs `pg_trgm`
-- there; locally it is in `public`, and a schema that does not exist in the
-- path is ignored.
create or replace function refresh_duplicate_candidates(p_registration_id bigint)
returns integer
language plpgsql
set search_path = public, extensions, pg_temp
as $$
declare
  v_reg registrations%rowtype;
  v_threshold real;
  v_count integer;
begin
  select * into v_reg from registrations where id = p_registration_id;
  if not found or v_reg.deleted_at is not null then
    return 0;
  end if;

  v_threshold := (resolve_setting('review.duplicate_name_similarity', v_reg.segment_id) #>> '{}')::real;

  with mine as (
    select lower(btrim(v_reg.contact_name)) as name
     where nullif(btrim(v_reg.contact_name), '') is not null
    union
    select lower(btrim(a.full_name))
      from attendees a
     where a.registration_id = v_reg.id
       and a.deleted_at is null
       and a.status <> 'CANCELLED'
       and a.name_source <> 'PLACEHOLDER'
       and nullif(btrim(a.full_name), '') is not null
  ),
  others as (
    select o.id, o.contact_email, o.contact_phone, o.contact_name
      from registrations o
     where o.show_id = v_reg.show_id
       and o.id <> v_reg.id
       and o.deleted_at is null
  ),
  theirs as (
    select o.id as registration_id, lower(btrim(o.contact_name)) as name
      from others o
     where nullif(btrim(o.contact_name), '') is not null
    union
    select a.registration_id, lower(btrim(a.full_name))
      from attendees a
      join others o on o.id = a.registration_id
     where a.deleted_at is null
       and a.status <> 'CANCELLED'
       and a.name_source <> 'PLACEHOLDER'
       and nullif(btrim(a.full_name), '') is not null
  ),
  name_hits as (
    select t.registration_id, max(similarity(m.name, t.name)) as best
      from mine m
      join theirs t on v_threshold is not null and similarity(m.name, t.name) >= v_threshold
     group by t.registration_id
  ),
  hits as (
    select o.id,
           array_remove(array[
             case when v_reg.contact_email is not null
                   and o.contact_email = v_reg.contact_email then 'EMAIL' end,
             case when phones_match(o.contact_phone, v_reg.contact_phone) then 'PHONE' end,
             case when n.best is not null then 'NAME' end
           ], null) as reasons,
           n.best
      from others o
      left join name_hits n on n.registration_id = o.id
  )
  insert into duplicate_candidates (
    show_id, registration_a_id, registration_b_id, reasons, name_similarity, status
  )
  select v_reg.show_id, least(v_reg.id, h.id), greatest(v_reg.id, h.id), h.reasons, h.best, 'OPEN'
    from hits h
   where cardinality(h.reasons) > 0
  on conflict (registration_a_id, registration_b_id) do update
     set reasons = excluded.reasons,
         name_similarity = excluded.name_similarity
   where duplicate_candidates.status = 'OPEN';

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;--> statement-breakpoint

revoke all on function normalise_phone(text) from public, anon, authenticated;--> statement-breakpoint
revoke all on function phones_match(text, text) from public, anon, authenticated;--> statement-breakpoint
revoke all on function refresh_duplicate_candidates(bigint) from public, anon, authenticated;
