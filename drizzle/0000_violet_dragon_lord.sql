CREATE TYPE "public"."allocation_type" AS ENUM('BASE', 'EXTRA', 'HELD', 'COMP');--> statement-breakpoint
CREATE TYPE "public"."audience_mode" AS ENUM('PLAYER_INVITED', 'PUBLIC');--> statement-breakpoint
CREATE TYPE "public"."background_kind" AS ENUM('IMAGE', 'PDF', 'NONE');--> statement-breakpoint
CREATE TYPE "public"."booking_status" AS ENUM('CONFIRMED', 'PENDING_REVIEW', 'WAITLIST', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."check_in_source" AS ENUM('ONLINE', 'OFFLINE_SYNC', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."concert_status" AS ENUM('DRAFT', 'ACTIVE', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."extras_policy" AS ENUM('REVIEW', 'AUTO_FCFS');--> statement-breakpoint
CREATE TYPE "public"."form_status" AS ENUM('DRAFT', 'OPEN', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('DRY_RUN', 'COMMITTED');--> statement-breakpoint
CREATE TYPE "public"."moderation_status" AS ENUM('PENDING', 'APPROVED', 'HIDDEN');--> statement-breakpoint
CREATE TYPE "public"."name_source" AS ENUM('PROVIDED', 'PLACEHOLDER');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('DRAFT', 'QUEUED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."portal_unlock_mode" AS ENUM('ON_ADMISSION', 'OPEN_TO_ALL', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."public_wall_visibility" AS ENUM('ADMIN_ONLY', 'AUDIENCE');--> statement-breakpoint
CREATE TYPE "public"."registration_source" AS ENUM('FORM', 'IMPORT', 'ADMIN');--> statement-breakpoint
CREATE TYPE "public"."show_status" AS ENUM('DRAFT', 'OPEN', 'CLOSED', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "public"."ticket_sent_source" AS ENUM('EMAIL', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('ADMIN', 'OPERATOR');--> statement-breakpoint
CREATE TYPE "public"."wall_status" AS ENUM('NOT_PUBLISHED', 'PUBLISHED');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "booklets" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "booklets_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"concert_id" bigint NOT NULL,
	"show_id" bigint,
	"title" text NOT NULL,
	"pdf_path" text NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "check_ins" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "check_ins_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"attendee_id" bigint NOT NULL,
	"show_id" bigint NOT NULL,
	"operator_id" uuid,
	"device_id" text,
	"scanned_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone,
	"source" "check_in_source" NOT NULL,
	"override_reason" text,
	"reverted_at" timestamp with time zone,
	"reverted_by" uuid
);
--> statement-breakpoint
CREATE TABLE "concerts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "concerts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"season" text,
	"starts_on" date,
	"ends_on" date,
	"status" "concert_status" NOT NULL,
	"defaults" jsonb,
	"timezone" text,
	"portal_enabled" boolean,
	"notes_enabled" boolean,
	"notes_close_at" timestamp with time zone,
	"public_wall_enabled" boolean,
	"public_wall_visibility" "public_wall_visibility",
	"practical_info_md" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "email_outbox" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "email_outbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"registration_id" bigint NOT NULL,
	"template_key" text NOT NULL,
	"to_email" "citext" NOT NULL,
	"to_name" text,
	"subject" text NOT NULL,
	"body_md" text NOT NULL,
	"context" jsonb,
	"attachment_paths" jsonb,
	"status" "outbox_status" NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"scheduled_for" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "import_batches_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"show_id" bigint NOT NULL,
	"segment_id" bigint NOT NULL,
	"filename" text NOT NULL,
	"mapping_profile_id" bigint,
	"uploaded_by" uuid,
	"row_count" integer DEFAULT 0 NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"report" jsonb,
	"status" "import_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mapping_profiles" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "mapping_profiles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"show_id" bigint,
	"audience" text,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "ticket_templates" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ticket_templates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"concert_id" bigint,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"supersedes_id" bigint,
	"background_asset_path" text,
	"background_kind" "background_kind" NOT NULL,
	"page_width_pt" integer NOT NULL,
	"page_height_pt" integer NOT NULL,
	"layout" jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "show_segments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "show_segments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"show_id" bigint NOT NULL,
	"name" text NOT NULL,
	"audience_mode" "audience_mode" NOT NULL,
	"capacity" integer,
	"base_quota" integer,
	"base_claim_deadline" timestamp with time zone,
	"extras_policy" "extras_policy",
	"allow_partial_grant" boolean,
	"max_tickets_per_response" integer,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "show_segments_id_show_key" UNIQUE("id","show_id")
);
--> statement-breakpoint
CREATE TABLE "shows" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "shows_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"concert_id" bigint NOT NULL,
	"name" text NOT NULL,
	"starts_at" timestamp with time zone,
	"doors_open_at" timestamp with time zone,
	"venue_name" text,
	"venue_address" text,
	"capacity" integer,
	"portal_unlock_mode" "portal_unlock_mode",
	"status" "show_status" NOT NULL,
	"ticket_template_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app_users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" "citext" NOT NULL,
	"display_name" text,
	"role" "user_role" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "operator_show_assignments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "operator_show_assignments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"show_id" bigint NOT NULL,
	"assigned_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_allocations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "player_allocations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"player_id" bigint NOT NULL,
	"segment_id" bigint NOT NULL,
	"base_quota_override" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "players_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"concert_id" bigint NOT NULL,
	"full_name" text NOT NULL,
	"email" "citext",
	"instrument" text,
	"section" text,
	"invite_token" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "attendees" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "attendees_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"registration_id" bigint NOT NULL,
	"show_id" bigint NOT NULL,
	"segment_id" bigint NOT NULL,
	"full_name" text,
	"name_source" "name_source" NOT NULL,
	"email" "citext",
	"allocation_type" "allocation_type" NOT NULL,
	"ticket_code" text,
	"qr_token" text,
	"status" "booking_status" NOT NULL,
	"ticket_issued_at" timestamp with time zone,
	"ticket_sent_at" timestamp with time zone,
	"ticket_sent_source" "ticket_sent_source",
	"needs_reissue" boolean DEFAULT false NOT NULL,
	"ticket_template_id" bigint,
	"ticket_template_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "form_responses" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "form_responses_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"form_id" bigint NOT NULL,
	"raw" jsonb NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"edit_token" text
);
--> statement-breakpoint
CREATE TABLE "registration_forms" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "registration_forms_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"segment_id" bigint NOT NULL,
	"round_label" text,
	"title" text NOT NULL,
	"description_md" text,
	"slug" text NOT NULL,
	"schema" jsonb,
	"opens_at" timestamp with time zone,
	"closes_at" timestamp with time zone,
	"max_responses" integer,
	"one_response_per_identity" boolean,
	"max_tickets_per_response" integer,
	"auto_close_on_capacity" boolean,
	"allow_edit_until" timestamp with time zone,
	"confirmation_message_md" text,
	"status" "form_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "registrations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "registrations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"show_id" bigint NOT NULL,
	"segment_id" bigint NOT NULL,
	"round_label" text,
	"player_id" bigint,
	"form_response_id" bigint,
	"import_batch_id" bigint,
	"source" "registration_source" NOT NULL,
	"contact_name" text NOT NULL,
	"contact_email" "citext",
	"contact_phone" text,
	"status" "booking_status" NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "registrations_id_segment_show_key" UNIQUE("id","segment_id","show_id")
);
--> statement-breakpoint
CREATE TABLE "portal_notes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "portal_notes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"concert_id" bigint NOT NULL,
	"show_id" bigint NOT NULL,
	"attendee_id" bigint NOT NULL,
	"to_player_id" bigint,
	"display_name" text,
	"is_anonymous" boolean DEFAULT false NOT NULL,
	"body" text NOT NULL,
	"moderation_status" "moderation_status" NOT NULL,
	"wall_status" "wall_status" NOT NULL,
	"moderated_by" uuid,
	"moderated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_app_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booklets" ADD CONSTRAINT "booklets_concert_id_concerts_id_fk" FOREIGN KEY ("concert_id") REFERENCES "public"."concerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booklets" ADD CONSTRAINT "booklets_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_attendee_id_attendees_id_fk" FOREIGN KEY ("attendee_id") REFERENCES "public"."attendees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_operator_id_app_users_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_reverted_by_app_users_id_fk" FOREIGN KEY ("reverted_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_registration_id_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_segment_id_show_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."show_segments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_mapping_profile_id_mapping_profiles_id_fk" FOREIGN KEY ("mapping_profile_id") REFERENCES "public"."mapping_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_uploaded_by_app_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mapping_profiles" ADD CONSTRAINT "mapping_profiles_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_templates" ADD CONSTRAINT "ticket_templates_concert_id_concerts_id_fk" FOREIGN KEY ("concert_id") REFERENCES "public"."concerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_templates" ADD CONSTRAINT "ticket_templates_supersedes_id_ticket_templates_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."ticket_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "show_segments" ADD CONSTRAINT "show_segments_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shows" ADD CONSTRAINT "shows_concert_id_concerts_id_fk" FOREIGN KEY ("concert_id") REFERENCES "public"."concerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shows" ADD CONSTRAINT "shows_ticket_template_id_ticket_templates_id_fk" FOREIGN KEY ("ticket_template_id") REFERENCES "public"."ticket_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_show_assignments" ADD CONSTRAINT "operator_show_assignments_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_show_assignments" ADD CONSTRAINT "operator_show_assignments_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_show_assignments" ADD CONSTRAINT "operator_show_assignments_assigned_by_app_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_allocations" ADD CONSTRAINT "player_allocations_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_allocations" ADD CONSTRAINT "player_allocations_segment_id_show_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."show_segments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_concert_id_concerts_id_fk" FOREIGN KEY ("concert_id") REFERENCES "public"."concerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendees" ADD CONSTRAINT "attendees_ticket_template_id_ticket_templates_id_fk" FOREIGN KEY ("ticket_template_id") REFERENCES "public"."ticket_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendees" ADD CONSTRAINT "attendees_registration_fk" FOREIGN KEY ("registration_id","segment_id","show_id") REFERENCES "public"."registrations"("id","segment_id","show_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_responses" ADD CONSTRAINT "form_responses_form_id_registration_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."registration_forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_forms" ADD CONSTRAINT "registration_forms_segment_id_show_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."show_segments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_form_response_id_form_responses_id_fk" FOREIGN KEY ("form_response_id") REFERENCES "public"."form_responses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_import_batch_id_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_created_by_app_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_segment_fk" FOREIGN KEY ("segment_id","show_id") REFERENCES "public"."show_segments"("id","show_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_notes" ADD CONSTRAINT "portal_notes_concert_id_concerts_id_fk" FOREIGN KEY ("concert_id") REFERENCES "public"."concerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_notes" ADD CONSTRAINT "portal_notes_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_notes" ADD CONSTRAINT "portal_notes_attendee_id_attendees_id_fk" FOREIGN KEY ("attendee_id") REFERENCES "public"."attendees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_notes" ADD CONSTRAINT "portal_notes_to_player_id_players_id_fk" FOREIGN KEY ("to_player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_notes" ADD CONSTRAINT "portal_notes_moderated_by_app_users_id_fk" FOREIGN KEY ("moderated_by") REFERENCES "public"."app_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "booklets_concert_idx" ON "booklets" USING btree ("concert_id");--> statement-breakpoint
CREATE INDEX "check_ins_show_scanned_idx" ON "check_ins" USING btree ("show_id","scanned_at");--> statement-breakpoint
CREATE INDEX "check_ins_attendee_idx" ON "check_ins" USING btree ("attendee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "concerts_slug_key" ON "concerts" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_no_duplicate_pending" ON "email_outbox" USING btree ("registration_id","template_key") WHERE status in ('DRAFT', 'QUEUED', 'SENDING');--> statement-breakpoint
CREATE INDEX "email_outbox_status_scheduled_idx" ON "email_outbox" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE INDEX "email_outbox_registration_idx" ON "email_outbox" USING btree ("registration_id");--> statement-breakpoint
CREATE INDEX "import_batches_segment_idx" ON "import_batches" USING btree ("segment_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_templates_name_version_key" ON "ticket_templates" USING btree ("concert_id","name","version");--> statement-breakpoint
CREATE UNIQUE INDEX "show_segments_show_audience_key" ON "show_segments" USING btree ("show_id","audience_mode");--> statement-breakpoint
CREATE INDEX "shows_concert_idx" ON "shows" USING btree ("concert_id");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_show_assignments_user_show_key" ON "operator_show_assignments" USING btree ("user_id","show_id");--> statement-breakpoint
CREATE INDEX "operator_show_assignments_show_idx" ON "operator_show_assignments" USING btree ("show_id");--> statement-breakpoint
CREATE UNIQUE INDEX "player_allocations_player_segment_key" ON "player_allocations" USING btree ("player_id","segment_id");--> statement-breakpoint
CREATE INDEX "player_allocations_segment_idx" ON "player_allocations" USING btree ("segment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "players_concert_email_key" ON "players" USING btree ("concert_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "players_invite_token_key" ON "players" USING btree ("invite_token");--> statement-breakpoint
CREATE UNIQUE INDEX "attendees_qr_token_key" ON "attendees" USING btree ("qr_token");--> statement-breakpoint
CREATE UNIQUE INDEX "attendees_ticket_code_key" ON "attendees" USING btree ("ticket_code");--> statement-breakpoint
CREATE INDEX "attendees_segment_status_idx" ON "attendees" USING btree ("segment_id","status","allocation_type");--> statement-breakpoint
CREATE INDEX "attendees_show_status_idx" ON "attendees" USING btree ("show_id","status");--> statement-breakpoint
CREATE INDEX "attendees_registration_idx" ON "attendees" USING btree ("registration_id");--> statement-breakpoint
CREATE INDEX "attendees_template_idx" ON "attendees" USING btree ("ticket_template_id");--> statement-breakpoint
CREATE INDEX "form_responses_form_idx" ON "form_responses" USING btree ("form_id");--> statement-breakpoint
CREATE UNIQUE INDEX "form_responses_edit_token_key" ON "form_responses" USING btree ("edit_token");--> statement-breakpoint
CREATE UNIQUE INDEX "registration_forms_slug_key" ON "registration_forms" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "registration_forms_segment_idx" ON "registration_forms" USING btree ("segment_id");--> statement-breakpoint
CREATE INDEX "registrations_segment_status_requested_idx" ON "registrations" USING btree ("segment_id","status","requested_at");--> statement-breakpoint
CREATE INDEX "registrations_show_status_idx" ON "registrations" USING btree ("show_id","status");--> statement-breakpoint
CREATE INDEX "registrations_player_idx" ON "registrations" USING btree ("player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_notes_attendee_key" ON "portal_notes" USING btree ("attendee_id");--> statement-breakpoint
CREATE INDEX "portal_notes_concert_moderation_idx" ON "portal_notes" USING btree ("concert_id","moderation_status");--> statement-breakpoint
CREATE INDEX "portal_notes_to_player_idx" ON "portal_notes" USING btree ("to_player_id");--> statement-breakpoint
CREATE INDEX "portal_notes_concert_wall_idx" ON "portal_notes" USING btree ("concert_id","wall_status");