-- 0205 — walk-ins and the door's per-attendee state (module `Y`, spec/v3.md §32.2, §32.5).
--
--   walk_ins            one row per walk-in tap (decision 58): a headcount and an
--                       optional label, minted on the phone with a `client_id`
--                       that makes a re-sent sync harmless.
--   manifest_for_show() widened. Every roster row is now addressable whether or
--                       not it has a ticket: the attendee id is the door's key,
--                       never the token's hash, which is null for a seat not yet
--                       ticketed. It also carries the check-in state §12.3 always
--                       promised and never delivered, the segment and the name
--                       source.
--
-- Additive (`modules-v3.md` §3.3). The two settings keys, `checkin.walk_ins_enabled`
-- and `checkin.walk_in_max_headcount`, are seeded by `scripts/seed-settings.ts`
-- like every other runtime value.

CREATE TABLE "walk_ins" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "walk_ins_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"client_id" uuid NOT NULL,
	"show_id" bigint NOT NULL,
	"segment_id" bigint,
	"headcount" integer NOT NULL,
	"label" text,
	"operator_id" uuid,
	"device_id" text,
	"admitted_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reverted_at" timestamp with time zone,
	"reverted_by" uuid,
	CONSTRAINT "walk_ins_headcount_positive" CHECK ("walk_ins"."headcount" > 0)
);
--> statement-breakpoint
ALTER TABLE "walk_ins" ADD CONSTRAINT "walk_ins_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "walk_ins" ADD CONSTRAINT "walk_ins_operator_id_app_users_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "walk_ins" ADD CONSTRAINT "walk_ins_reverted_by_app_users_id_fk" FOREIGN KEY ("reverted_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "walk_ins" ADD CONSTRAINT "walk_ins_segment_show_fk" FOREIGN KEY ("segment_id","show_id") REFERENCES "public"."show_segments"("id","show_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "walk_ins_client_id_key" ON "walk_ins" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "walk_ins_show_admitted_idx" ON "walk_ins" USING btree ("show_id","admitted_at");--> statement-breakpoint

-- Deny by default, as 0004 does for every table that existed then. The app reads
-- and writes this table over Drizzle as the owner; nothing reaches it through
-- PostgREST.
-- The explicit revoke is for Supabase, where 0004 may not have been allowed to
-- change the default privileges a new table inherits.
ALTER TABLE "walk_ins" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
revoke all on table "walk_ins" from anon, authenticated;--> statement-breakpoint

-- The return type changes, so the function is dropped and recreated rather than
-- replaced. Everything 0003 and 0004 established is restated below: security
-- definer, a pinned search_path, zero rows for anyone not rostered, and execute
-- for `authenticated` alone.
--
--   attendee_id      the door's key for a seat. Not a secret: the roster is
--                    already on the phone, and it cannot admit anybody without
--                    an assigned operator's session.
--   qr_token_sha256  null when the seat has no ticket yet.
--   has_ticket       spelled out, so the phone never infers it from a null.
--   checked_in_at,   the first live (unreverted) check-in and who made it, so a
--   checked_in_by    phone can say "In at 19:42 · Bob" for another phone's scan.
--   segment_name,    for search and the party sheet; neither is personal data.
--   name_source
drop function if exists public.manifest_for_show(bigint);--> statement-breakpoint

create function public.manifest_for_show(p_show_id bigint)
returns table (
  attendee_id bigint,
  qr_token_sha256 text,
  has_ticket boolean,
  ticket_code text,
  name text,
  name_source name_source,
  player_name text,
  status booking_status,
  registration_id bigint,
  party_size integer,
  segment_name text,
  checked_in_at timestamptz,
  checked_in_by text
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
  ),
  first_in as (
    select distinct on (ci.attendee_id)
      ci.attendee_id, ci.scanned_at, u.display_name
    from check_ins ci
    left join app_users u on u.id = ci.operator_id
    where ci.show_id = p_show_id
      and ci.reverted_at is null
    order by ci.attendee_id, ci.scanned_at
  )
  select
    a.id,
    case when a.qr_token is null then null
         else encode(sha256(convert_to(a.qr_token, 'UTF8')), 'hex') end,
    a.qr_token is not null,
    a.ticket_code,
    a.full_name,
    a.name_source,
    p.full_name,
    a.status,
    a.registration_id,
    (count(*) filter (where a.status <> 'CANCELLED')
       over (partition by a.registration_id))::int,
    sg.name,
    fi.scanned_at,
    fi.display_name
  from attendees a
  join registrations r on r.id = a.registration_id
  join show_segments sg on sg.id = a.segment_id
  left join players p on p.id = r.player_id
  left join first_in fi on fi.attendee_id = a.id
  where a.show_id = p_show_id
    and a.deleted_at is null
    and exists (select 1 from permitted)
$$;--> statement-breakpoint

revoke all on function public.manifest_for_show(bigint) from public, anon;--> statement-breakpoint
grant execute on function public.manifest_for_show(bigint) to authenticated;
