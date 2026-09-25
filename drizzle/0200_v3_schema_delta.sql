-- 0200 — the V3 schema delta (module `P`, `docs/modules-v3.md`, spec/v3.md §30).
--
-- **Every column, table, view, enum value and function V3 needs is in this one
-- migration**, as V2's were in `0100`: it is applied to Supabase by hand
-- (`docs/local.md` §4, §16), and `main` must keep building, passing and running
-- the moment it merges (`modules-v3.md` §3.3). So it is **additive**: nothing an
-- existing screen reads is removed or renamed.
--
-- What it adds, and what each is for (spec/v3.md):
--
--   enums          message_purpose, mail_direction, duplicate_status,
--                  command_run_status, command_item_status, import_row_status,
--                  import_match_action; outbox_status + BOUNCED,
--                  user_role + VIEWER, import_status + STAGED, UNDONE
--   email_outbox   purpose (backfilled from template_key), message_id,
--                  superseded_by_id, bounced_at, bounce_code, bounce_detail,
--                  in_reply_to_message_id; template_key nullable for REPLY;
--                  the two pending indexes rebuilt on purpose        (§24, §26)
--   registrations  approved_at/by (backfilled), merged_into_id, update_token,
--                  email_issue/checked_at/issue_accepted_at          (§25, §24.6)
--   attendees      requested_at (backfilled), over_capacity_at,
--                  import_row_id                                     (§21.3, §23.5)
--   show_segments  auto_approve_clean, default_ticket_template_id    (§25.4, §24.2)
--   registration_forms theme                                         (§25.6)
--   import_batches queue_receipts, updated_at                        (§25.3, §25.7)
--   email_templates deleted_at                                       (§23.6)
--   new tables     segment_message_defaults, email_threads, email_messages,
--                  mail_sync_state, import_rows, duplicate_candidates,
--                  command_runs, command_run_items, scheduler_heartbeat
--   functions      resolve_setting (two segment keys), claim_seats and
--                  promote_seats (the V3 override), schedule_scheduler_jobs
--   view           party_pipeline                                    (§21)
--   dropped        registrations_no_duplicate_import                 (§30.1)
--
-- **Enum values added here are not used here.** Postgres 16 allows
-- `alter type … add value` inside a transaction but refuses to *use* the new
-- value before that transaction commits, and `pnpm db:migrate` applies every
-- pending migration in a single transaction — so splitting this file in two
-- would not help. Nothing below names BOUNCED, VIEWER, STAGED or UNDONE: the
-- view reads `bounced_at` instead of `status = 'BOUNCED'`, and plpgsql bodies
-- are not resolved until they run. `message_purpose` is a new *type*, not a new
-- value, and a type created in a transaction is usable in it.

--------------------------------------------------------------------------------
-- Preconditions
--------------------------------------------------------------------------------

-- **Every existing message must map to a purpose, or nothing is changed.**
-- `purpose` becomes NOT NULL with no default (a defaulted purpose would make
-- unrelated messages collide under the pending index), so a `template_key`
-- the mapping below does not know must stop the migration here — not become a
-- null that the NOT NULL then rejects halfway through, and never a guess.
--
-- The mapping is spec/v3.md §24.2's table, plus `feedback_form_link`, which is
-- written by `scripts/feedback-form-blast.ts` (`local.md` §13) and is not in
-- `TEMPLATE_KEYS`. It is the 19 Sep Google Forms feedback blast: FEEDBACK.
do $$
declare
  v_unmapped text;
begin
  select string_agg(distinct coalesce(template_key, '(null)'), ', ')
    into v_unmapped
    from email_outbox
   where template_key is null
      or template_key not in (
        'player_confirmation', 'public_ticket', 'public_verify',
        'registration_receipt', 'extras_granted', 'extras_declined',
        'registration_cancelled', 'reminder', 'feedback_request',
        'feedback_form_link', 'player_notes_digest', 'player_invite');

  if v_unmapped is not null then
    raise exception
      'email_outbox holds template keys with no purpose: %. Add each to the '
      'mapping in 0200 (spec/v3.md §24.2) before re-running; nothing has been changed.',
      v_unmapped;
  end if;
end
$$;--> statement-breakpoint

--------------------------------------------------------------------------------
-- Types
--------------------------------------------------------------------------------

CREATE TYPE "public"."command_item_status" AS ENUM('PENDING', 'DONE', 'SKIPPED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."command_run_status" AS ENUM('RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."duplicate_status" AS ENUM('OPEN', 'MERGED', 'DISMISSED');--> statement-breakpoint
CREATE TYPE "public"."import_match_action" AS ENUM('ADD_SEATS', 'SKIP', 'SEPARATE');--> statement-breakpoint
CREATE TYPE "public"."import_row_status" AS ENUM('STAGED', 'COMMITTED', 'SKIPPED');--> statement-breakpoint
CREATE TYPE "public"."mail_direction" AS ENUM('INBOUND', 'OUTBOUND');--> statement-breakpoint
CREATE TYPE "public"."message_purpose" AS ENUM('RECEIPT', 'VERIFICATION', 'TICKETS', 'EXTRAS_DECISION', 'CANCELLATION', 'REMINDER', 'FEEDBACK', 'NOTES_DIGEST', 'PLAYER_INVITE', 'REPLY');--> statement-breakpoint
ALTER TYPE "public"."import_status" ADD VALUE 'STAGED';--> statement-breakpoint
ALTER TYPE "public"."import_status" ADD VALUE 'UNDONE';--> statement-breakpoint
ALTER TYPE "public"."outbox_status" ADD VALUE 'BOUNCED';--> statement-breakpoint
ALTER TYPE "public"."user_role" ADD VALUE 'VIEWER';--> statement-breakpoint

--------------------------------------------------------------------------------
-- New tables
--------------------------------------------------------------------------------

CREATE TABLE "segment_message_defaults" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "segment_message_defaults_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"segment_id" bigint NOT NULL,
	"purpose" "message_purpose" NOT NULL,
	"template_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);--> statement-breakpoint
CREATE TABLE "email_messages" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "email_messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"thread_id" bigint NOT NULL,
	"direction" "mail_direction" NOT NULL,
	"outbox_id" bigint,
	"message_id" text,
	"in_reply_to" text,
	"reference_ids" text[],
	"from_email" "citext",
	"from_name" text,
	"to_email" "citext",
	"subject" text,
	"text" text,
	"html" text,
	"is_bounce" boolean DEFAULT false NOT NULL,
	"message_at" timestamp with time zone NOT NULL,
	"folder" text,
	"uid" bigint,
	"handled_at" timestamp with time zone,
	"handled_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);--> statement-breakpoint
CREATE TABLE "email_threads" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "email_threads_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"registration_id" bigint,
	"player_id" bigint,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "email_threads_one_addressee" CHECK (num_nonnulls(registration_id, player_id) = 1)
);--> statement-breakpoint
CREATE TABLE "mail_sync_state" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "mail_sync_state_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"folder" text NOT NULL,
	"uid_validity" bigint,
	"last_uid" bigint,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);--> statement-breakpoint
CREATE TABLE "duplicate_candidates" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "duplicate_candidates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"show_id" bigint NOT NULL,
	"registration_a_id" bigint NOT NULL,
	"registration_b_id" bigint NOT NULL,
	"reasons" text[] NOT NULL,
	"name_similarity" real,
	"status" "duplicate_status" NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "duplicate_candidates_ordered_pair" CHECK (registration_a_id < registration_b_id)
);--> statement-breakpoint
CREATE TABLE "import_rows" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "import_rows_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"batch_id" bigint NOT NULL,
	"row_number" integer NOT NULL,
	"seat_index" integer NOT NULL,
	"raw" jsonb NOT NULL,
	"normalized" jsonb NOT NULL,
	"party_key" text,
	"issues" jsonb NOT NULL,
	"existing_registration_id" bigint,
	"existing_action" "import_match_action",
	"status" "import_row_status" NOT NULL,
	"registration_id" bigint,
	"committed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);--> statement-breakpoint
CREATE TABLE "command_run_items" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "command_run_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_id" bigint NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" bigint NOT NULL,
	"status" "command_item_status" NOT NULL,
	"outcome" jsonb,
	"error" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "command_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "command_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"concert_id" bigint,
	"command" text NOT NULL,
	"actor_id" uuid,
	"selection" jsonb NOT NULL,
	"params" jsonb,
	"reason" text,
	"status" "command_run_status" NOT NULL,
	"total" integer NOT NULL,
	"done" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "scheduler_heartbeat" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "scheduler_heartbeat_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"report" jsonb,
	"error" text
);--> statement-breakpoint

--------------------------------------------------------------------------------
-- email_outbox: purpose, and the pending-message key moves to it
--------------------------------------------------------------------------------

-- Added nullable, backfilled, then made NOT NULL — the only order that works on
-- a table with rows in it. The backfill runs with the `updated_at` trigger off:
-- the dispatcher's stale-SENDING recovery reads `updated_at`, and a migration
-- that touched every row would make every in-flight message look fresh.
ALTER TABLE "email_outbox" ADD COLUMN "purpose" "message_purpose";--> statement-breakpoint
alter table email_outbox disable trigger email_outbox_set_updated_at;--> statement-breakpoint
update email_outbox
   set purpose = case template_key
     when 'player_confirmation'    then 'TICKETS'
     when 'public_ticket'          then 'TICKETS'
     when 'public_verify'          then 'VERIFICATION'
     when 'registration_receipt'   then 'RECEIPT'
     when 'extras_granted'         then 'EXTRAS_DECISION'
     when 'extras_declined'        then 'EXTRAS_DECISION'
     when 'registration_cancelled' then 'CANCELLATION'
     when 'reminder'               then 'REMINDER'
     when 'feedback_request'       then 'FEEDBACK'
     when 'feedback_form_link'     then 'FEEDBACK'
     when 'player_notes_digest'    then 'NOTES_DIGEST'
     when 'player_invite'          then 'PLAYER_INVITE'
   end::message_purpose;--> statement-breakpoint
alter table email_outbox enable trigger email_outbox_set_updated_at;--> statement-breakpoint
-- Belt to the precondition's braces: an unmapped key left a null, and this
-- refuses it rather than letting anything past.
ALTER TABLE "email_outbox" ALTER COLUMN "purpose" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "email_outbox" ALTER COLUMN "template_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_template_unless_reply" CHECK (template_key is not null or purpose = 'REPLY');--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "message_id" text;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "superseded_by_id" bigint;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "bounced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "bounce_code" text;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "bounce_detail" text;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "in_reply_to_message_id" bigint;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_superseded_by_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."email_outbox"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- **Production can already hold what the new index forbids.** The bug this
-- index fixes is exactly that: one registration with two pending drafts under
-- two templates of the same purpose (spec/v3.md §20 finding 3), and the owner
-- hit it. `create unique index` would fail on such rows mid-migration, so they
-- are resolved first, the way V3 resolves them at run time (§24.2): the newest
-- pending row per addressee and purpose survives, every other is CANCELLED
-- with `superseded_by_id` pointing at it, and each is written to `audit_log`
-- so the change is visible rather than silent.
--
-- "Newest" with one exception: a row already SENDING is kept over a newer
-- draft. It is in the dispatcher's hands, and cancelling it underneath would
-- not stop the send — it would only lose the record that it went.
--
-- `partition by registration_id, player_id` is safe because exactly one of the
-- two is ever set (`email_outbox_one_addressee`). REPLY is excluded, as it is
-- from the index.
with ranked as (
  select id, status, purpose, template_key,
         first_value(id) over w as keep_id,
         row_number() over w as rn
    from email_outbox
   where status in ('DRAFT', 'QUEUED', 'SENDING')
     and purpose <> 'REPLY'
  window w as (
    partition by registration_id, player_id, purpose
    order by (status = 'SENDING') desc, created_at desc, id desc)
),
superseded as (
  update email_outbox o
     set status = 'CANCELLED',
         superseded_by_id = r.keep_id
    from ranked r
   where o.id = r.id
     and r.rn > 1
  returning o.id, r.status as was, r.purpose, r.template_key, r.keep_id
)
insert into audit_log (actor_id, action, entity_type, entity_id, before, after, reason)
select null,
       'outbox.superseded',
       'email_outbox',
       s.id::text,
       jsonb_build_object('status', s.was, 'template_key', s.template_key, 'purpose', s.purpose),
       jsonb_build_object('status', 'CANCELLED', 'superseded_by_id', s.keep_id),
       'Migration 0200: a second pending message for the same party and purpose. '
       || 'The newest was kept (spec/v3.md §24.2, decision 52).'
  from superseded s;--> statement-breakpoint

-- Built under new names and swapped in, so an index is in force at every
-- moment — including for a copy of this file run statement by statement in the
-- SQL editor, which does not stop on error.
--
-- REPLY is left out of both: two replies a person wrote are two messages, and
-- superseding the first would silently discard something a human composed.
CREATE UNIQUE INDEX "outbox_no_duplicate_pending_v3" ON "email_outbox" USING btree ("registration_id","purpose") WHERE status in ('DRAFT', 'QUEUED', 'SENDING') and purpose <> 'REPLY';--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_no_duplicate_pending_player_v3" ON "email_outbox" USING btree ("player_id","purpose") WHERE status in ('DRAFT', 'QUEUED', 'SENDING') and purpose <> 'REPLY';--> statement-breakpoint
DROP INDEX "outbox_no_duplicate_pending";--> statement-breakpoint
DROP INDEX "outbox_no_duplicate_pending_player";--> statement-breakpoint
alter index "outbox_no_duplicate_pending_v3" rename to "outbox_no_duplicate_pending";--> statement-breakpoint
alter index "outbox_no_duplicate_pending_player_v3" rename to "outbox_no_duplicate_pending_player";--> statement-breakpoint
CREATE UNIQUE INDEX "email_outbox_message_id_key" ON "email_outbox" USING btree ("message_id");--> statement-breakpoint

--------------------------------------------------------------------------------
-- registrations: the review gate, merging, the address check
--------------------------------------------------------------------------------

ALTER TABLE "registrations" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "merged_into_id" bigint;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "update_token" text;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "email_issue" text;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "email_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "email_issue_accepted_at" timestamp with time zone;--> statement-breakpoint
-- **Everything that existed before V3 counts as approved** (spec/v3.md §30.1),
-- so nothing already ticketed drops back into NEEDS_REVIEW. `updated_at` is
-- left alone for the same reason as the outbox backfill above.
alter table registrations disable trigger registrations_set_updated_at;--> statement-breakpoint
update registrations set approved_at = created_at where approved_at is null;--> statement-breakpoint
alter table registrations enable trigger registrations_set_updated_at;--> statement-breakpoint
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_approved_by_app_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_merged_into_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."registrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "registrations_update_token_key" ON "registrations" USING btree ("update_token");--> statement-breakpoint

-- `registrations_no_duplicate_import` is dropped (spec/v3.md §30.1). Grouping by
-- email within the segment (§25.7) and merging (§25.5) replace what it guarded,
-- and it would reject a legitimate second submission merged by email.
DROP INDEX "registrations_no_duplicate_import";--> statement-breakpoint

--------------------------------------------------------------------------------
-- attendees: each seat's own request time, the override mark, provenance
--------------------------------------------------------------------------------

ALTER TABLE "attendees" ADD COLUMN "requested_at" timestamp with time zone;--> statement-breakpoint
alter table attendees disable trigger attendees_set_updated_at;--> statement-breakpoint
update attendees a
   set requested_at = r.requested_at
  from registrations r
 where r.id = a.registration_id
   and a.requested_at is null;--> statement-breakpoint
alter table attendees enable trigger attendees_set_updated_at;--> statement-breakpoint

-- NOT NULL, but no caller has to supply it: a seat created with its party asked
-- when the party asked, so that is the default — filled from the registration
-- rather than a column default, which cannot read another row. `claim_seats()`
-- passes an explicit time for a seat that did not (a merge, a later submission
-- added to an existing party, spec/v3.md §21.3).
create or replace function tg_attendee_requested_at() returns trigger
language plpgsql as $$
begin
  if new.requested_at is null then
    select requested_at into new.requested_at
      from registrations where id = new.registration_id;
  end if;
  return new;
end;
$$;--> statement-breakpoint
drop trigger if exists attendees_requested_at_default on attendees;--> statement-breakpoint
create trigger attendees_requested_at_default
  before insert on attendees
  for each row execute function tg_attendee_requested_at();--> statement-breakpoint
ALTER TABLE "attendees" ALTER COLUMN "requested_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "attendees" ADD COLUMN "over_capacity_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attendees" ADD COLUMN "import_row_id" bigint;--> statement-breakpoint
ALTER TABLE "attendees" ADD CONSTRAINT "attendees_import_row_fk" FOREIGN KEY ("import_row_id") REFERENCES "public"."import_rows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendees_import_row_idx" ON "attendees" USING btree ("import_row_id");--> statement-breakpoint
-- The extras walk orders seats by their own time within a segment (§21.3).
create index "attendees_segment_requested_idx" on "attendees" using btree ("segment_id", "requested_at");--> statement-breakpoint

--------------------------------------------------------------------------------
-- Segments, forms, imports, templates
--------------------------------------------------------------------------------

ALTER TABLE "show_segments" ADD COLUMN "auto_approve_clean" boolean;--> statement-breakpoint
ALTER TABLE "show_segments" ADD COLUMN "default_ticket_template_id" bigint;--> statement-breakpoint
ALTER TABLE "show_segments" ADD CONSTRAINT "show_segments_default_ticket_template_id_ticket_templates_id_fk" FOREIGN KEY ("default_ticket_template_id") REFERENCES "public"."ticket_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_forms" ADD COLUMN "theme" jsonb;--> statement-breakpoint
ALTER TABLE "import_batches" ADD COLUMN "queue_receipts" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "import_batches" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "email_templates" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint

--------------------------------------------------------------------------------
-- Foreign keys and indexes for the new tables
--------------------------------------------------------------------------------

ALTER TABLE "segment_message_defaults" ADD CONSTRAINT "segment_message_defaults_segment_id_show_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."show_segments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_message_defaults" ADD CONSTRAINT "segment_message_defaults_template_key_email_templates_key_fk" FOREIGN KEY ("template_key") REFERENCES "public"."email_templates"("key") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_thread_id_email_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."email_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_outbox_id_email_outbox_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."email_outbox"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_handled_by_app_users_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_registration_id_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duplicate_candidates" ADD CONSTRAINT "duplicate_candidates_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duplicate_candidates" ADD CONSTRAINT "duplicate_candidates_registration_a_id_registrations_id_fk" FOREIGN KEY ("registration_a_id") REFERENCES "public"."registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duplicate_candidates" ADD CONSTRAINT "duplicate_candidates_registration_b_id_registrations_id_fk" FOREIGN KEY ("registration_b_id") REFERENCES "public"."registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duplicate_candidates" ADD CONSTRAINT "duplicate_candidates_decided_by_app_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_existing_registration_id_registrations_id_fk" FOREIGN KEY ("existing_registration_id") REFERENCES "public"."registrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_registration_id_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_run_items" ADD CONSTRAINT "command_run_items_run_id_command_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."command_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_runs" ADD CONSTRAINT "command_runs_concert_id_concerts_id_fk" FOREIGN KEY ("concert_id") REFERENCES "public"."concerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_runs" ADD CONSTRAINT "command_runs_actor_id_app_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_in_reply_to_message_id_email_messages_id_fk" FOREIGN KEY ("in_reply_to_message_id") REFERENCES "public"."email_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "segment_message_defaults_segment_purpose_key" ON "segment_message_defaults" USING btree ("segment_id","purpose");--> statement-breakpoint
CREATE INDEX "segment_message_defaults_template_idx" ON "segment_message_defaults" USING btree ("template_key");--> statement-breakpoint
CREATE UNIQUE INDEX "email_messages_message_id_key" ON "email_messages" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "email_messages_thread_idx" ON "email_messages" USING btree ("thread_id","message_at");--> statement-breakpoint
CREATE INDEX "email_messages_outbox_idx" ON "email_messages" USING btree ("outbox_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_threads_registration_key" ON "email_threads" USING btree ("registration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_threads_player_key" ON "email_threads" USING btree ("player_id");--> statement-breakpoint
CREATE INDEX "email_threads_last_message_idx" ON "email_threads" USING btree ("last_message_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_sync_state_folder_key" ON "mail_sync_state" USING btree ("folder");--> statement-breakpoint
CREATE UNIQUE INDEX "duplicate_candidates_pair_key" ON "duplicate_candidates" USING btree ("registration_a_id","registration_b_id");--> statement-breakpoint
CREATE INDEX "duplicate_candidates_b_idx" ON "duplicate_candidates" USING btree ("registration_b_id");--> statement-breakpoint
CREATE INDEX "duplicate_candidates_show_status_idx" ON "duplicate_candidates" USING btree ("show_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "import_rows_batch_row_seat_key" ON "import_rows" USING btree ("batch_id","row_number","seat_index");--> statement-breakpoint
CREATE INDEX "import_rows_batch_status_idx" ON "import_rows" USING btree ("batch_id","status");--> statement-breakpoint
CREATE INDEX "import_rows_registration_idx" ON "import_rows" USING btree ("registration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "command_run_items_target_key" ON "command_run_items" USING btree ("run_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "command_run_items_run_status_idx" ON "command_run_items" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX "command_runs_concert_started_idx" ON "command_runs" USING btree ("concert_id","started_at");--> statement-breakpoint
CREATE INDEX "command_runs_status_idx" ON "command_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "scheduler_heartbeat_started_idx" ON "scheduler_heartbeat" USING btree ("started_at");--> statement-breakpoint

--------------------------------------------------------------------------------
-- resolve_setting() — two segment-level keys (spec/v3.md §24.2, §25.4)
--------------------------------------------------------------------------------

-- Unchanged but for the two new segment columns. The segment level of the
-- cascade reads typed columns only, so a key a segment may set needs one:
-- `ticket.default_template_id` now starts at the segment's default design, then
-- the show's, as before; `review.auto_approve_clean` is new. Both columns are
-- null on every existing segment, so every existing call resolves exactly as it
-- did.
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
      -- V3 (spec/v3.md §24.2, §30.2). Both columns are null unless set, so
      -- every existing segment resolves exactly as it did before 0200.
      when 'ticket.default_template_id'      then to_jsonb(v_segment.default_ticket_template_id)
      when 'review.auto_approve_clean'       then to_jsonb(v_segment.auto_approve_clean)
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

    -- The show's own `defaults` bag, so a show can carry one deadline or quota
    -- for all of its segments. Without this the walk jumps straight from the
    -- segment to the concert, and §2.2's "nullable at the concert, show and
    -- segment levels" is only true for the three keys that have typed columns.
    v_value := v_show.defaults -> p_key;
    if v_value is not null and jsonb_typeof(v_value) <> 'null' then return v_value; end if;
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
-- claim_seats() and promote_seats() — the V3 override (spec/v3.md §23.5)
--------------------------------------------------------------------------------

-- **Same signatures, so no new overload.** Both functions have taken
-- `p_override boolean default false` since V1 (`0001`, `0005`), where it
-- relaxed the segment and hall ceilings and nothing else. `create or replace`
-- with the identical argument list replaces the body in place; adding a
-- parameter instead would leave the V1 overload callable beside it.
--
-- What changes, and only with the override on (decision 47, reversing 17):
--
--   1. `claim_seats()` grants BASE seats past a player's quota.
--   2. Both mark every seat the override was actually *needed* for —
--      past the quota, the segment or the hall — with `over_capacity_at`, the
--      fact `party_pipeline` reads as OVER_CAPACITY. Both return the count as
--      `over_capacity`.
--
-- With it off, nothing moves: the §7.3 worked example and every V1/V2
-- allocation test pass unchanged. `claim_seats()` also accepts an optional
-- `requested_at` per seat (§21.3).
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
  v_index          int;
  v_decisions      text[];
  v_type           text;
  v_status         booking_status;
  v_extra_wanted   int;
  v_extra_grantable int;
  v_granted_base   int := 0;
  v_granted_extra  int := 0;
  v_granted_other  int := 0;
  v_pending        int := 0;
  v_waitlisted     int := 0;
  -- V3 (spec/v3.md §23.5): the seats the override was actually needed for.
  v_has_quota      boolean := false;
  v_over           boolean[];
  v_is_over        boolean;
  v_over_capacity  int := 0;
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
  if not found or v_segment.deleted_at is not null then
    raise exception 'segment % does not exist', p_segment_id;
  end if;

  -- `assert_segments_fit_hall()` ignores deleted segments when it adds up the
  -- hall, so granting into one would put people in seats the hall arithmetic
  -- says are not there.
  if exists (select 1 from shows where id = v_segment.show_id and deleted_at is not null) then
    raise exception 'show % has been deleted, so its segments cannot be given seats',
      v_segment.show_id;
  end if;

  -- `for update` on the registration as well as the show. The show lock alone
  -- does not serialise against cancellation, which touches `registrations` and
  -- takes no lock on `shows` — so a cancel could commit while a claim was in
  -- flight, and the claim would write CONFIRMED seats under a registration that
  -- no longer exists. The pool excludes them, so the same seats are sold again;
  -- the door reads `attendees.status` and sees valid ticket holders. Three
  -- different answers to "who is coming".
  select * into v_registration from registrations where id = p_registration_id for update;
  if not found then
    raise exception 'registration % does not exist', p_registration_id;
  end if;

  -- The same end state is reachable with no race at all, by claiming against an
  -- already-cancelled registration. Seats belong to a live booking or to
  -- nobody.
  if v_registration.status = 'CANCELLED' or v_registration.deleted_at is not null then
    raise exception 'registration % is %, so it cannot be given seats',
      p_registration_id,
      case when v_registration.deleted_at is not null then 'deleted' else 'cancelled' end
      using hint = 'Restore it, or create a new registration (spec/allocation.md §7.9).';
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
    -- `is_active`, `deleted_at` and the concert must all match what
    -- `segment_pool()` and `assert_base_entitlement_fits()` count. They both
    -- consider only active, undeleted players of this concert; without the same
    -- predicates here the grant path spends a seat the pool reserved for
    -- somebody else, and an active player is refused the base allocation §7.4
    -- promises they can never be refused before the deadline.
    --
    -- The concert check also closes a gap the foreign key cannot: `players` is
    -- concert-scoped but `registrations.player_id` references it directly, so a
    -- player of another concert could otherwise draw on this segment's quota
    -- while `unclaimed_base` never counted them.
    select coalesce(pa.base_quota_override, v_quota) into v_quota
      from players p
      join shows s on s.id = v_segment.show_id
      left join player_allocations pa
             on pa.player_id = p.id and pa.segment_id = p_segment_id
     where p.id = v_registration.player_id
       and p.concert_id = s.concert_id
       and p.is_active
       and p.deleted_at is null;

    -- Not found means the linked player is inactive, deleted, or belongs to
    -- another concert: they are owed nothing here, so BASE requests waitlist.
    if not found then
      v_quota := null;
    end if;

    if v_quota is not null then
      v_has_quota := true;
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

  -- **Two passes over the party, not one.**
  --
  -- BASE, HELD and COMP seats spend the same `v_segment_room` the extras draw
  -- on, so an extras budget computed before they are decided is a budget for
  -- seats that are already gone. With one pass, a party of 1 BASE + 3 EXTRA into
  -- three free seats had its extras granted two-at-a-time until the room ran
  -- out — cutting the party in half with `allow_partial_grant` off, which §7.5
  -- says must be "skipped whole". That is the ordinary shape of a player's
  -- post-deadline registration: their own seat plus guests.
  --
  -- So: decide the entitlement seats first, then size the extras budget against
  -- what is genuinely left, then apply the whole-party rule to that.
  v_decisions := array_fill(null::text, array[coalesce(jsonb_array_length(p_requests), 0)]);
  v_over := array_fill(false, array[coalesce(jsonb_array_length(p_requests), 0)]);

  for v_index, v_request in
    select ordinality, value from jsonb_array_elements(p_requests) with ordinality
  loop
    v_type := v_request ->> 'allocation_type';

    if v_type = 'BASE' then
      -- V3 lets the override past the player's quota as well as the ceilings
      -- (decision 47, reversing 17). Only a quota that exists: a party linked
      -- to no player, or to an inactive one, is owed no BASE seat to exceed,
      -- and granting one would record an entitlement nobody holds.
      if (v_base_room > 0 or (p_override and v_has_quota))
         and (p_override or (v_segment_room > 0 and v_hall_headroom > 0)) then
        v_decisions[v_index] := 'CONFIRMED';
        -- Marked only when the override was needed — past the quota, the
        -- segment or the hall — never merely because it was passed.
        v_over[v_index] := v_base_room = 0 or v_segment_room = 0 or v_hall_headroom = 0;
        v_base_room := greatest(0, v_base_room - 1);
        v_segment_room := greatest(0, v_segment_room - 1);
        v_hall_headroom := greatest(0, v_hall_headroom - 1);
        v_granted_base := v_granted_base + 1;
      else
        v_decisions[v_index] := 'WAITLIST';
        v_waitlisted := v_waitlisted + 1;
      end if;

    elsif v_type in ('HELD', 'COMP') then
      if p_override or (v_extras_room > 0 and v_segment_room > 0 and v_hall_headroom > 0) then
        v_decisions[v_index] := 'CONFIRMED';
        -- The extras pool is a recommendation, not capacity (0005's header),
        -- so a seat that only went past the pool is not marked.
        v_over[v_index] := v_segment_room = 0 or v_hall_headroom = 0;
        v_extras_room := greatest(0, v_extras_room - 1);
        v_segment_room := greatest(0, v_segment_room - 1);
        v_hall_headroom := greatest(0, v_hall_headroom - 1);
        v_granted_other := v_granted_other + 1;
      else
        v_decisions[v_index] := 'WAITLIST';
        v_waitlisted := v_waitlisted + 1;
      end if;
    end if;
  end loop;

  if v_policy = 'REVIEW' then
    -- The override relaxes capacity ceilings, not the review itself: an extras
    -- request in a REVIEW segment is held for the §7.5 batch grant however it
    -- arrives. Confirming it at intake would empty the screen it exists for.
    v_extra_grantable := 0;
  elsif p_override then
    v_extra_grantable := v_extra_wanted;
  else
    v_extra_grantable := least(v_extras_room, v_segment_room, v_hall_headroom, v_extra_wanted);
    -- Strict order, never best-fit: a party that does not fit waits whole
    -- unless partial grants are allowed (§7.5).
    if v_extra_grantable < v_extra_wanted and coalesce(v_partial, false) is not true then
      v_extra_grantable := 0;
    end if;
  end if;

  -- Transaction-local, so it cannot leak to another statement on this
  -- connection once this one commits or rolls back.
  perform set_config('zetix.granting', 'on', true);

  for v_index, v_request in
    select ordinality, value from jsonb_array_elements(p_requests) with ordinality
  loop
    v_type := v_request ->> 'allocation_type';

    v_is_over := false;

    if v_type <> 'EXTRA' then
      -- Decided in the first pass, above.
      v_status := v_decisions[v_index]::booking_status;
      v_is_over := v_over[v_index];

    else
      -- Both the budget and the live room are required. The budget was sized
      -- against the room left *after* the entitlement seats were decided, and
      -- this second check is what stops a party spending the same seat twice.
      if v_extra_grantable > 0
         and (p_override or (v_segment_room > 0 and v_hall_headroom > 0)) then
        v_status := 'CONFIRMED';
        v_is_over := v_segment_room = 0 or v_hall_headroom = 0;
        v_extra_grantable := v_extra_grantable - 1;
        v_segment_room := greatest(0, v_segment_room - 1);
        v_hall_headroom := greatest(0, v_hall_headroom - 1);
        v_granted_extra := v_granted_extra + 1;
      elsif v_policy = 'REVIEW' then
        v_status := 'PENDING_REVIEW';
        v_pending := v_pending + 1;
      else
        v_status := 'WAITLIST';
        v_waitlisted := v_waitlisted + 1;
      end if;

    end if;

    if v_is_over then
      v_over_capacity := v_over_capacity + 1;
    end if;

    insert into attendees (
      registration_id, show_id, segment_id, full_name, name_source, email,
      allocation_type, status, requested_at, over_capacity_at
    ) values (
      p_registration_id,
      v_registration.show_id,
      p_segment_id,
      -- An attendee with no name is not an error, and the placeholder is a
      -- **generated name**, not a null: "Guest of {contact_name}" (decision 32,
      -- spec/v2.md §8.2.1). The door searches on this string, and a party that
      -- registered together arrives together — "Guest of Alice Tan" finding all
      -- four of them is the useful behaviour, and a null finds nobody. The
      -- renderer prints it too, so a null would print a blank ticket.
      coalesce(
        nullif(trim(coalesce(v_request ->> 'full_name', '')), ''),
        'Guest of ' || v_registration.contact_name
      ),
      case when nullif(trim(coalesce(v_request ->> 'full_name', '')), '') is null
           then 'PLACEHOLDER'::name_source else 'PROVIDED'::name_source end,
      v_request ->> 'email',
      v_type::allocation_type,
      v_status,
      -- The seat's own first-come time (spec/v3.md §21.3). Absent means "when
      -- the party asked", and `attendees_requested_at_default` fills that in;
      -- a merge or a later submission passes the time of the request that
      -- actually created this seat. A value that is not a timestamp fails the
      -- cast here, before any seat is written.
      (v_request ->> 'requested_at')::timestamptz,
      case when v_is_over then now() end
    );
  end loop;

  perform set_config('zetix.granting', 'off', true);

  return jsonb_build_object(
    'granted_base',  v_granted_base,
    'granted_extra', v_granted_extra,
    -- Beyond §7.8's four keys, because HELD and COMP seats are granted by this
    -- function and the four named keys cannot describe them.
    'granted_other', v_granted_other,
    'pending',       v_pending,
    'waitlisted',    v_waitlisted,
    -- V3: how many of the granted seats the override put past a limit, each
    -- marked `over_capacity_at` (spec/v3.md §21.2 OVER_CAPACITY).
    'over_capacity', v_over_capacity
  );
end;
$$;--> statement-breakpoint

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
  v_over_capacity  int := 0;
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
      'confirmed', 0, 'skipped', 0, 'refused', false, 'reason', null,
      'over_capacity', 0);
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
      'confirmed', 0, 'skipped', v_skipped, 'refused', false, 'reason', null,
      'over_capacity', 0);
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
        v_hall_headroom, v_room),
      'over_capacity', 0);
  end if;

  -- The deliberate, greppable opt-out of `attendees_promotion_guard`. It is
  -- transaction-local, so it cannot leak to another statement on this
  -- connection once this one commits or rolls back.
  perform set_config('zetix.granting', 'on', true);

  update attendees
     set status = 'CONFIRMED'
   where id = any(v_targets);
  get diagnostics v_confirmed = row_count;

  -- V3 (spec/v3.md §23.5): the seats past the room are the overage, and they
  -- are the **last** in first-come order — the earlier requests are the ones
  -- that fitted. Marked so `party_pipeline` can raise OVER_CAPACITY; nothing is
  -- marked when the override was passed but not needed.
  if p_override and v_confirmed > v_room then
    update attendees
       set over_capacity_at = now()
     where id in (
       select id from attendees
        where id = any(v_targets)
        order by requested_at desc, id desc
        limit v_confirmed - v_room);
    get diagnostics v_over_capacity = row_count;
  end if;

  perform set_config('zetix.granting', 'off', true);

  return jsonb_build_object(
    'confirmed', v_confirmed,
    'skipped',   v_skipped,
    'refused',   false,
    'reason',    null,
    'over_capacity', v_over_capacity);
end;
$$;--> statement-breakpoint

-- `create or replace` keeps a function's existing grants, which 0004 and 0005
-- already took off PUBLIC. Stated again rather than trusted: this is the door
-- that let the publishable key grant itself seats (decision 20b), and a later
-- edit that dropped and recreated either function would reopen it silently.
revoke all on function claim_seats(bigint, bigint, jsonb, boolean) from public, anon, authenticated;--> statement-breakpoint
revoke all on function promote_seats(bigint, bigint[], boolean) from public, anon, authenticated;--> statement-breakpoint

--------------------------------------------------------------------------------
-- party_pipeline — spec/v3.md §21, decision 51
--------------------------------------------------------------------------------

-- **Status is derived, never stored** (§20.1). One row per live party, its
-- stage, its flags, and the rollup counters every screen reads — so "2 of 3
-- sent" is read here and never recomputed in TypeScript.
--
-- Seats that are CANCELLED or soft-deleted are not "live" and are ignored by
-- the stage and by every flag. A soft-deleted party is not on the line at all:
-- it is in the Trash (§23.6), and a merged party is soft-deleted with a pointer
-- to its survivor (§25.5).
--
-- **Stage, first match wins:**
--
--   CANCELLED      no live seats, and the party or a seat is cancelled
--   (null)         no seats at all — off the line
--   ADMITTED       a live seat has a check-in that was not reverted
--   NEEDS_REVIEW   not approved, or a seat is PENDING_REVIEW
--   WAITLISTED     no confirmed seat, at least one WAITLIST
--   UNVERIFIED     a public party sent a link it has not clicked, and no admin
--                  released it — exactly the gate the blast applies
--                  (`queue.ts` IS_VERIFIED: token set, verified_at null)
--   NEEDS_TICKETS  a confirmed seat has no issued ticket
--   READY_TO_SEND  every confirmed seat issued, at least one undelivered
--   SENT           every confirmed seat delivered, by email or by hand
--
-- ADMITTED is checked before review: a party at the door is past every step
-- whatever the record says, and the door is the one truth nobody argues with.
-- NEEDS_REVIEW is checked before WAITLISTED because approval is the earlier
-- step; a waitlisted party still has to be approved before it can be ticketed.
--
-- "Issued" is the §11.4 rule, not `ticket_issued_at`: a seat without both a
-- `qr_token` and a pinned template cannot be sent, and the send path holds
-- the whole party back until it has them.
--
-- **Flags** follow §21.2. Two are read from facts other than the obvious
-- enum, deliberately:
--
--   BOUNCED is read from `bounced_at`, not `status = 'BOUNCED'`. The enum value
--   is added in this migration, and Postgres refuses to use a new enum value in
--   the transaction that added it — `pnpm db:migrate` applies every pending
--   migration in one. `bounced_at` is set with the status, so it is the same
--   fact.
--
--   SEND_FAILED is a FAILED message (the dispatcher sets FAILED only once
--   `email.max_attempts` is spent — `dispatch.ts`) with nothing of the same
--   purpose sent after it. A failure that a later send repaired is history,
--   not a problem a person has to look at.
--
-- `security_invoker` so the view runs with the caller's privileges, never its
-- owner's: on Supabase a view owned by `postgres` would otherwise read through
-- RLS on behalf of whoever can select from it. Nobody but the server can, and
-- the revoke at the end of this file keeps it that way.
create or replace view party_pipeline with (security_invoker = true) as
with seats as (
  select
    a.registration_id,
    count(*) filter (where a.status <> 'CANCELLED')::int as live_seats,
    count(*) filter (where a.status = 'CANCELLED')::int as cancelled_seats,
    count(*) filter (where a.status = 'CONFIRMED')::int as confirmed_seats,
    count(*) filter (where a.status = 'PENDING_REVIEW')::int as pending_seats,
    count(*) filter (where a.status = 'WAITLIST')::int as waitlisted_seats,
    count(*) filter (where a.status = 'CONFIRMED'
                       and a.qr_token is not null
                       and a.ticket_template_id is not null)::int as issued_seats,
    count(*) filter (where a.status = 'CONFIRMED'
                       and a.ticket_sent_at is not null)::int as delivered_seats,
    count(*) filter (where a.status <> 'CANCELLED'
                       and exists (select 1 from check_ins c
                                    where c.attendee_id = a.id
                                      and c.reverted_at is null))::int as admitted_seats,
    bool_or(a.status <> 'CANCELLED' and a.needs_reissue) as any_needs_reissue,
    bool_or(a.status <> 'CANCELLED' and a.name_source = 'PLACEHOLDER') as any_placeholder,
    bool_or(a.status = 'CONFIRMED' and a.over_capacity_at is not null) as any_over_capacity
  from attendees a
  where a.deleted_at is null
  group by a.registration_id
),
base as (
  select
    r.id as registration_id,
    s.concert_id,
    r.show_id,
    r.segment_id,
    g.audience_mode,
    r.player_id,
    r.source,
    r.round_label,
    r.status as registration_status,
    r.contact_name,
    r.contact_email,
    r.contact_phone,
    r.requested_at,
    r.approved_at,
    r.email_verified_at,
    r.created_at,
    r.updated_at,
    coalesce(x.live_seats, 0) as live_seats,
    coalesce(x.cancelled_seats, 0) as cancelled_seats,
    coalesce(x.confirmed_seats, 0) as confirmed_seats,
    coalesce(x.pending_seats, 0) as pending_seats,
    coalesce(x.waitlisted_seats, 0) as waitlisted_seats,
    coalesce(x.issued_seats, 0) as issued_seats,
    coalesce(x.delivered_seats, 0) as delivered_seats,
    coalesce(x.admitted_seats, 0) as admitted_seats,

    -- BOUNCED: the newest ticket-bearing message that went out to the address
    -- the party has *now* bounced. Fixing the address, or a later send to it
    -- that did not bounce, clears the flag by construction.
    coalesce((
      select o.bounced_at is not null
        from email_outbox o
       where o.registration_id = r.id
         and o.deleted_at is null
         and o.purpose in ('TICKETS', 'EXTRAS_DECISION')
         and o.sent_at is not null
         and o.to_email = r.contact_email
       order by o.sent_at desc, o.id desc
       limit 1), false) as flag_bounced,

    exists (
      select 1 from email_outbox f
       where f.registration_id = r.id
         and f.deleted_at is null
         and f.status = 'FAILED'
         and not exists (
           select 1 from email_outbox later
            where later.registration_id = r.id
              and later.deleted_at is null
              and later.purpose = f.purpose
              and later.status = 'SENT'
              and later.id > f.id)) as flag_send_failed,

    (r.email_issue is not null and r.email_issue_accepted_at is null) as flag_suspicious_address,
    coalesce(x.any_needs_reissue, false) as flag_changed_after_send,

    exists (
      select 1 from duplicate_candidates d
       where d.status = 'OPEN'
         and r.id in (d.registration_a_id, d.registration_b_id)) as flag_possible_duplicate,

    coalesce(x.any_placeholder, false) as flag_unnamed_guests,

    -- REPLY_WAITING: the newest message in the party's thread is a reply from
    -- them — not a bounce, and not yet handled (§26.5).
    coalesce((
      select m.direction = 'INBOUND' and not m.is_bounce and m.handled_at is null
        from email_threads t
        join email_messages m on m.thread_id = t.id and m.deleted_at is null
       where t.registration_id = r.id
         and t.deleted_at is null
       order by m.message_at desc, m.id desc
       limit 1), false) as flag_reply_waiting,

    coalesce(x.any_over_capacity, false) as flag_over_capacity,

    (r.verification_token is not null and r.email_verified_at is null) as unverified
  from registrations r
  join shows s on s.id = r.show_id
  join show_segments g on g.id = r.segment_id
  left join seats x on x.registration_id = r.id
  where r.deleted_at is null
)
select
  b.registration_id,
  b.concert_id,
  b.show_id,
  b.segment_id,
  b.audience_mode,
  b.player_id,
  b.source,
  b.round_label,
  b.registration_status,
  b.contact_name,
  b.contact_email,
  b.contact_phone,
  b.requested_at,
  b.approved_at,
  b.email_verified_at,
  b.created_at,
  b.updated_at,
  case
    when b.live_seats = 0 and (b.cancelled_seats > 0 or b.registration_status = 'CANCELLED')
      then 'CANCELLED'
    when b.live_seats = 0 then null
    when b.admitted_seats > 0 then 'ADMITTED'
    when b.approved_at is null or b.pending_seats > 0 then 'NEEDS_REVIEW'
    when b.confirmed_seats = 0 and b.waitlisted_seats > 0 then 'WAITLISTED'
    when b.unverified then 'UNVERIFIED'
    when b.issued_seats < b.confirmed_seats then 'NEEDS_TICKETS'
    when b.delivered_seats < b.confirmed_seats then 'READY_TO_SEND'
    else 'SENT'
  end as stage,
  array_remove(array[
    case when b.flag_bounced then 'BOUNCED' end,
    case when b.flag_send_failed then 'SEND_FAILED' end,
    case when b.flag_suspicious_address then 'SUSPICIOUS_ADDRESS' end,
    case when b.flag_changed_after_send then 'CHANGED_AFTER_SEND' end,
    case when b.flag_possible_duplicate then 'POSSIBLE_DUPLICATE' end,
    case when b.flag_unnamed_guests then 'UNNAMED_GUESTS' end,
    case when b.flag_reply_waiting then 'REPLY_WAITING' end,
    case when b.flag_over_capacity then 'OVER_CAPACITY' end
  ], null) as flags,
  b.flag_bounced,
  b.flag_send_failed,
  b.flag_suspicious_address,
  b.flag_changed_after_send,
  b.flag_possible_duplicate,
  b.flag_unnamed_guests,
  b.flag_reply_waiting,
  b.flag_over_capacity,
  b.live_seats,
  b.confirmed_seats,
  b.pending_seats,
  b.waitlisted_seats,
  b.cancelled_seats,
  b.issued_seats,
  b.delivered_seats,
  b.admitted_seats
from base b;--> statement-breakpoint

--------------------------------------------------------------------------------
-- The scheduler's pg_cron jobs — spec/v3.md §27.2, decision 57
--------------------------------------------------------------------------------

-- `pg_cron` + `pg_net` call `/api/scheduler/tick` every
-- `scheduler.tick_minutes`, and a second job trims their history to
-- `scheduler.history_days`. **Neither extension exists on the local Postgres 16
-- or in CI**, so this migration only *creates* the function: nothing here calls
-- `cron.*` or `net.*` at migration time, and every reference to either schema
-- is dynamic SQL, parsed only when the function runs. Enabling the extensions,
-- storing the secrets and running this once are manual (`local.md` §16).
--
-- **No secret is in this file or in `cron.job`.** The job's command reads the
-- tick URL and the bearer secret from Supabase Vault *each time it runs*, by
-- name. A migration is public history; `cron.job.command` is readable by
-- anyone who can read that table. Both are the wrong place for a credential.
--
-- Re-running it is safe and is how a changed setting takes effect: an existing
-- job is re-pointed with `cron.alter_job`, never duplicated. The trigger below
-- does that automatically when either setting changes, but only once the jobs
-- exist — before the manual setup step it has nothing to re-schedule.
create or replace function schedule_scheduler_jobs() returns jsonb
language plpgsql as $$
declare
  v_minutes  int;
  v_days     int;
  v_tick     text;
  v_trim     text;
  v_tick_id  bigint;
  v_trim_id  bigint;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise exception 'pg_cron and pg_net must both be enabled before the scheduler can be scheduled'
      using hint = 'Supabase → Database → Extensions, then run this again (docs/local.md §16).';
  end if;

  v_minutes := (resolve_setting('scheduler.tick_minutes')) #>> '{}';
  v_days    := (resolve_setting('scheduler.history_days')) #>> '{}';

  -- A missing value is an error, never a number invented here (spec/domain.md
  -- §6). The catalogue bounds the minutes to 1–59 because `*/N` in the minute
  -- field means nothing past 59.
  if v_minutes is null or v_minutes < 1 or v_minutes > 59 then
    raise exception 'scheduler.tick_minutes must be set to a whole number from 1 to 59, not %',
      coalesce(v_minutes::text, 'nothing')
      using hint = 'Seed it with pnpm db:seed, or set it under Settings.';
  end if;
  if v_days is null or v_days < 1 then
    raise exception 'scheduler.history_days must be set to at least 1, not %',
      coalesce(v_days::text, 'nothing')
      using hint = 'Seed it with pnpm db:seed, or set it under Settings.';
  end if;

  -- Read from Vault at run time. The names are the contract with `local.md`
  -- §16; the values never appear here.
  v_tick := $cmd$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets
               where name = 'zetix_scheduler_tick_url'),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                        where name = 'zetix_scheduler_secret')),
      body := '{"source":"pg_cron"}'::jsonb,
      timeout_milliseconds := 60000
    )
  $cmd$;

  v_trim := format($cmd$
    delete from cron.job_run_details where end_time < now() - interval '%1$s days';
    delete from net._http_response where created < now() - interval '%1$s days'
  $cmd$, v_days);

  execute 'select jobid from cron.job where jobname = $1'
     into v_tick_id using 'zetix-scheduler-tick';
  if v_tick_id is null then
    execute 'select cron.schedule($1, $2, $3)'
       into v_tick_id using 'zetix-scheduler-tick', format('*/%s * * * *', v_minutes), v_tick;
  else
    execute 'select cron.alter_job(job_id := $1, schedule := $2, command := $3)'
      using v_tick_id, format('*/%s * * * *', v_minutes), v_tick;
  end if;

  -- Daily, off the hour: history is bounded in days, so once a day is enough,
  -- and minute 0 is when everything else on the platform runs.
  execute 'select jobid from cron.job where jobname = $1'
     into v_trim_id using 'zetix-scheduler-history-trim';
  if v_trim_id is null then
    execute 'select cron.schedule($1, $2, $3)'
       into v_trim_id using 'zetix-scheduler-history-trim', '17 3 * * *', v_trim;
  else
    execute 'select cron.alter_job(job_id := $1, command := $2)'
      using v_trim_id, v_trim;
  end if;

  return jsonb_build_object(
    'tick_job_id', v_tick_id, 'tick_every_minutes', v_minutes,
    'trim_job_id', v_trim_id, 'history_days', v_days);
end;
$$;--> statement-breakpoint

-- "Changing the setting re-schedules it" (§27.2). Only where the extension is
-- present **and** the tick job already exists: before the manual setup step,
-- and always locally and in CI, a settings save must not fail or create jobs.
create or replace function tg_scheduler_settings() returns trigger
language plpgsql as $$
declare
  v_exists boolean;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_extension where extname = 'pg_net') then
    return null;
  end if;
  execute 'select exists (select 1 from cron.job where jobname = $1)'
     into v_exists using 'zetix-scheduler-tick';
  if v_exists then
    perform schedule_scheduler_jobs();
  end if;
  return null;
end;
$$;--> statement-breakpoint

drop trigger if exists system_settings_reschedule on system_settings;--> statement-breakpoint
create trigger system_settings_reschedule
  after insert or update of value on system_settings
  for each row
  when (new.key in ('scheduler.tick_minutes', 'scheduler.history_days'))
  execute function tg_scheduler_settings();--> statement-breakpoint

--------------------------------------------------------------------------------
-- `updated_at` on the new tables, as on every other mutable table
--------------------------------------------------------------------------------

create or replace trigger segment_message_defaults_set_updated_at
  before update on segment_message_defaults
  for each row execute function set_updated_at();--> statement-breakpoint
create or replace trigger email_threads_set_updated_at
  before update on email_threads
  for each row execute function set_updated_at();--> statement-breakpoint
create or replace trigger email_messages_set_updated_at
  before update on email_messages
  for each row execute function set_updated_at();--> statement-breakpoint
create or replace trigger mail_sync_state_set_updated_at
  before update on mail_sync_state
  for each row execute function set_updated_at();--> statement-breakpoint
create or replace trigger import_rows_set_updated_at
  before update on import_rows
  for each row execute function set_updated_at();--> statement-breakpoint
create or replace trigger duplicate_candidates_set_updated_at
  before update on duplicate_candidates
  for each row execute function set_updated_at();--> statement-breakpoint
create or replace trigger command_runs_set_updated_at
  before update on command_runs
  for each row execute function set_updated_at();--> statement-breakpoint
create or replace trigger import_batches_set_updated_at
  before update on import_batches
  for each row execute function set_updated_at();--> statement-breakpoint

--------------------------------------------------------------------------------
-- Close the door Supabase opens for every new relation (decision 20b)
--------------------------------------------------------------------------------

-- A new table arrives with `relrowsecurity = false` and, on Supabase, whatever
-- the platform pre-grants. `tests/schema/rls-lockdown.test.ts` derives its list
-- from the catalog, so a table left out here turns the suite red. Several of
-- these hold personal data — `email_messages` is guests' own words — and none
-- is read except by the server.
alter table "segment_message_defaults" enable row level security;--> statement-breakpoint
revoke all on table "segment_message_defaults" from anon, authenticated;--> statement-breakpoint
alter table "email_threads" enable row level security;--> statement-breakpoint
revoke all on table "email_threads" from anon, authenticated;--> statement-breakpoint
alter table "email_messages" enable row level security;--> statement-breakpoint
revoke all on table "email_messages" from anon, authenticated;--> statement-breakpoint
alter table "mail_sync_state" enable row level security;--> statement-breakpoint
revoke all on table "mail_sync_state" from anon, authenticated;--> statement-breakpoint
alter table "import_rows" enable row level security;--> statement-breakpoint
revoke all on table "import_rows" from anon, authenticated;--> statement-breakpoint
alter table "duplicate_candidates" enable row level security;--> statement-breakpoint
revoke all on table "duplicate_candidates" from anon, authenticated;--> statement-breakpoint
alter table "command_runs" enable row level security;--> statement-breakpoint
revoke all on table "command_runs" from anon, authenticated;--> statement-breakpoint
alter table "command_run_items" enable row level security;--> statement-breakpoint
revoke all on table "command_run_items" from anon, authenticated;--> statement-breakpoint
alter table "scheduler_heartbeat" enable row level security;--> statement-breakpoint
revoke all on table "scheduler_heartbeat" from anon, authenticated;--> statement-breakpoint

-- The view is a relation too, and `pg_tables` — what the RLS test reads — does
-- not list views, so this is checked in `tests/schema/v3-pipeline.test.ts`
-- instead. It is the whole audience roster with addresses; `security_invoker`
-- makes it run with the caller's rights, and the revoke makes sure no public
-- caller has any.
revoke all on table party_pipeline from public, anon, authenticated;--> statement-breakpoint

-- Every function this migration creates, off PUBLIC for the reason 0004 gives:
-- execute defaults to PUBLIC, and PostgREST serves every function at
-- `/rest/v1/rpc/<name>`. `schedule_scheduler_jobs()` in particular must never
-- be callable by the publishable key.
revoke all on function tg_attendee_requested_at() from public, anon, authenticated;--> statement-breakpoint
revoke all on function schedule_scheduler_jobs() from public, anon, authenticated;--> statement-breakpoint
revoke all on function tg_scheduler_settings() from public, anon, authenticated;--> statement-breakpoint
revoke all on function resolve_setting(text, bigint, bigint, bigint) from public, anon, authenticated;
