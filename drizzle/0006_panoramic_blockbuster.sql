CREATE TABLE "email_templates" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"subject" text NOT NULL,
	"body_md" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
-- Close the door Supabase opens for this table, exactly as `0004` does for the
-- rest of the schema.
--
-- `0004` revoked the grants that existed *then* and altered the default
-- privileges so future tables do not inherit them — but the RLS half is
-- per-table and a new table arrives with `relrowsecurity = false`. On Supabase a
-- table without it is reachable at `/rest/v1/email_templates` the moment any
-- grant returns, and this one holds the wording of every message the orchestra
-- sends. `tests/schema/rls-lockdown.test.ts` derives its list from the catalog
-- precisely so this cannot be forgotten quietly.
--
-- No policy is added, so the deny is total: `email_templates` is read and
-- written only through the server, behind `requireAdmin()`.
alter table "email_templates" enable row level security;--> statement-breakpoint
revoke all on table "email_templates" from anon, authenticated;
