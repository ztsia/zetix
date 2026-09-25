-- 0201 — the concert scope of the audit log (module `Q`, spec/v3.md §23.1, §23.6).
--
-- The Activity log is read per concert, and a command run's rows are read per
-- run. `audit_log` could answer neither: it names an entity by type and id, and
-- the entity may since have been deleted permanently (§23.6), taking any join
-- with it. So both are stored on the row.
--
-- Additive, like `0200` (`modules-v3.md` §3.3): two nullable columns, two
-- indexes, one function, one trigger, one backfill. Nothing that reads the log
-- today changes.
--
-- **Why a trigger fills `concert_id`.** About sixty call sites and several SQL
-- functions write here, across modules that are finished. The runner passes the
-- concert explicitly; everything else is left alone and the row is scoped on
-- insert from `entity_type` / `entity_id`. This derives a value, it enforces
-- nothing, so it is not the integrity trigger the database skill rules out.
-- A writer that passes `concert_id` itself is never overridden.

ALTER TABLE "audit_log" ADD COLUMN "concert_id" bigint;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "command_run_id" bigint;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_command_run_id_command_runs_id_fk" FOREIGN KEY ("command_run_id") REFERENCES "public"."command_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_concert_created_idx" ON "audit_log" USING btree ("concert_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_command_run_idx" ON "audit_log" USING btree ("command_run_id");--> statement-breakpoint

-- Which concert an audited entity belongs to, or null when it has none
-- (`system_setting`, `email_template`, `app_users`) or no longer exists.
--
-- The entity types are the ones the code writes today, both spellings where two
-- modules chose differently (`show` / `shows`, `player` / `players`, `concert` /
-- `concerts`). An id that is not an integer — a settings key, a template key —
-- is simply not looked up.
create or replace function audit_log_concert_of(p_type text, p_id text)
returns bigint
language plpgsql
stable
set search_path = public
as $$
declare
  v_id bigint;
begin
  if p_id is null or p_id !~ '^[0-9]{1,18}$' then
    return null;
  end if;
  v_id := p_id::bigint;

  return case p_type
    when 'concert'  then (select id from concerts where id = v_id)
    when 'concerts' then (select id from concerts where id = v_id)
    when 'show'     then (select concert_id from shows where id = v_id)
    when 'shows'    then (select concert_id from shows where id = v_id)
    when 'show_segment' then (
      select s.concert_id from show_segments g join shows s on s.id = g.show_id
       where g.id = v_id)
    when 'registration' then (
      select s.concert_id from registrations r join shows s on s.id = r.show_id
       where r.id = v_id)
    when 'attendee' then (
      select s.concert_id from attendees a join shows s on s.id = a.show_id
       where a.id = v_id)
    when 'player'  then (select concert_id from players where id = v_id)
    when 'players' then (select concert_id from players where id = v_id)
    when 'ticket_template' then (select concert_id from ticket_templates where id = v_id)
    when 'booklets' then (select concert_id from booklets where id = v_id)
    when 'mapping_profile' then (
      select s.concert_id from mapping_profiles m join shows s on s.id = m.show_id
       where m.id = v_id)
    when 'portal_notes' then (select concert_id from portal_notes where id = v_id)
    when 'check_ins' then (
      select s.concert_id from check_ins c join shows s on s.id = c.show_id
       where c.id = v_id)
    when 'import_batch' then (
      select s.concert_id
        from import_batches b
        left join show_segments g on g.id = b.segment_id
        join shows s on s.id = coalesce(b.show_id, g.show_id)
       where b.id = v_id)
    when 'email_outbox' then (
      select coalesce(
               (select s.concert_id from registrations r join shows s on s.id = r.show_id
                 where r.id = o.registration_id),
               (select p.concert_id from players p where p.id = o.player_id))
        from email_outbox o where o.id = v_id)
    when 'registration_form' then (
      select s.concert_id
        from registration_forms f
        left join show_segments g on g.id = f.segment_id
        join shows s on s.id = coalesce(f.show_id, g.show_id)
       where f.id = v_id)
    else null
  end;
end;
$$;--> statement-breakpoint

create or replace function tg_audit_log_fill_concert()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.concert_id is null then
    new.concert_id := audit_log_concert_of(new.entity_type, new.entity_id);
  end if;
  return new;
end;
$$;--> statement-breakpoint

create trigger audit_log_fill_concert
  before insert on audit_log
  for each row execute function tg_audit_log_fill_concert();--> statement-breakpoint

-- Neither is callable over PostgREST (`0004`): the default privileges there
-- cannot always be altered, so each new function is revoked by name.
revoke all on function audit_log_concert_of(text, text) from public;--> statement-breakpoint
revoke all on function tg_audit_log_fill_concert() from public;--> statement-breakpoint

-- Every existing row, for the entities that still exist. A row whose entity is
-- already gone stays unscoped and simply does not appear in any concert's
-- Activity log — there is nothing left to say which concert it was.
update audit_log
   set concert_id = audit_log_concert_of(entity_type, entity_id)
 where concert_id is null;
