Part of the system specification — see [`README.md`](README.md) for the index.

**Read this file before re-litigating anything.** Each row is a question that was worked through once;
the obvious simplification was usually considered and is worse.

**Read by:** every module, before re-litigating anything.
See [`../modules.md`](../modules.md) for what each label owns and when it runs.

---

# 19. Decisions

## 19.1 Settled

System decisions only. Concert-specific choices and their deadlines are in `context.md` §6.

| # | Question | Decision |
|---|---|---|
| 1 | Guests without an email | Acceptable. The player receives their PDFs and forwards them. Guest email is optional on the player form. |
| 2 | Base quota variance | Uniform across players within a segment. Set at segment level; a per-player override column exists but is not surfaced prominently. |
| 3 | Do players attend their own show? | No. A player consumes zero seats in the player segment of their own show. |
| 4 | Extras policy | **Batch review** is the default for player segments. Requests hold as `PENDING_REVIEW`; admin grants after the deadline from a strict-FCFS preselected list. Public segments default to `AUTO_FCFS`. |
| 5 | **Mixed-mode shows** | Player-invited and public audiences **coexist in one show**. `audience_mode` lives on `show_segments`, not on the show; each segment owns its capacity, quota, deadline, policy and form. The show owns the hall. |
| 6 | Note visibility | Per-player grouping is **always admin-only**. The public wall is configurable per concert, and publishing to it is always an explicit admin action. |
| 7 | Retention | Keep indefinitely. No purge job. Soft deletes only. |
| 8 | Ticket vs portal | The PDF is the ticket; the portal is additive and decoupled. Content unlocks on admission, with a friendly pre-admission status page and a one-click `OPEN_TO_ALL` fallback. |
| 9 | Registration capture | Google Forms exports are a first-class input via import (`import.md` §9), equal to native forms. Neither is privileged in the data model. |
| 10 | Ticket editor | A real canvas editor over the organisation's own artwork, with seeded defaults so the system works before anyone opens it. |
| 11 | Database / auth / storage | **Supabase**, with a daily keep-alive cron defeating the 7-day idle pause. One service for three concerns; the pause is a solved problem, not a disqualifier. |
| 12 | Email transport | **Gmail SMTP via `nodemailer` from a Vercel Node.js function.** Only port 25 is blocked on serverless — 465 and 587 work. Behind a `MailTransport` interface so an HTTP provider is an adapter swap. |
| 13 | Booklet delivery | Supabase Storage with range requests; move the booklet alone to R2 only if egress demands it (`platform.md` §17.2). |
| 14 | Reference material | `ref.md`, not a vendored clone of Hi.Events. |
| 15 | Backend placement | Next.js Route Handlers and Server Actions. **No Supabase Edge Functions** — `sharp` cannot run on Deno, so rendering must be on Vercel anyway (`platform.md` §16.1). `claim_seats()` stays a Postgres function because it needs a row lock. |
| 16 | Repeat blasts | Idempotent by construction: `ticket_sent_at` as dedup key, a filtered `insert … on conflict do nothing`, and a partial unique index on pending outbox rows (`email.md` §11.4). |
| 17 | Base oversubscription | Always blocked, across all three mutations that can cause it. **No opt-out toggle** — lowering the quota or raising capacity already expresses the same intent honestly (`allocation.md` §7.4). |
| 18 | Configuration | No operational value has a code default. Concert data lives in `context.md` and is entered through the admin UI (`README.md` §2.1, `domain.md` §6). |
| 19 | Admin accounts | **One shared `ADMIN` account** unlocked by a single secret code. No admin user management. Costs audit attribution, which is accepted; the schema still supports individual admins if that changes (`admin.md` §14.3). |
| 20 | Operator accounts | **Multi-account, provisioned by the admin, scoped to assigned shows** via `operator_show_assignments`. Enforced in the handler and again **in the database** — the manifest endpoint is the boundary that matters, since the manifest is the attendee roster (`checkin.md` §12.3). The database layer is a `security definer` function, not an RLS policy; see 20b, which amends this row. |
| 20a | Operator credentials | Supabase Auth password sign-in against a synthetic `<slug>@operators.invalid` address. **Not** anonymous sign-in and not a hand-rolled id/password pair — both move the credential check into our code, which is the thing the platform is there to do (`checkin.md` §12.1). |
| 20b | **How the database layer is enforced** | A **`security definer` function** — `manifest_for_show()` — reached by `supabase-js` `.rpc()`, with `execute` granted to `authenticated` and **no table grants at all**. Decided 4–5 Sep; it replaces the wording "and again by RLS" in 20. Two alternatives were measured and rejected. **Not RLS policies on the base tables**: PostgREST can only read a table `authenticated` has been *granted*, and that grant publishes the roster at `https://<ref>.supabase.co/rest/v1/attendees` to anyone holding the publishable key, which ships in the browser bundle by design — one layer on a newly opened door, where a policy bug is exploitable from a browser console. **Not a non-owner role plus `set local app.user_id`**: it is the textbook answer and does cover paths nobody has written yet, but 15 days out it changes `DATABASE_URL` in Vercel, CI and every `.env.local`, and makes every protected read run inside a transaction that sets identity first — a rule whose failure mode is a wrapper that forgets. Revisit after the concert. The cost of what was chosen is stated honestly: **coverage is opt-in**, so it protects only reads that call it — closed mechanically by an ESLint `no-restricted-imports` rule and `tests/auth/manifest-call-site.test.ts`, not by documentation. **Scope: the manifest read only.** Scan writes and the offline-sync drain stay handler-only — a scan write is a single row in an append-only, revertible log keyed by a token the operator physically holds, and its failure mode is a bad row, not the disclosure of the whole roster. RLS is additionally *enabled with no policies* on **every** table in `public`, so the deny is real if a grant ever leaks (`drizzle/0003_manifest_rls.sql`, `drizzle/0004_lock_down_public_grants.sql`). **Corrected 5 Sep, on first contact with the real project:** the argument above assumed the base-table grant was something a future diff might add. It was already there — Supabase pre-grants `anon` and `authenticated` every privilege on every table in `public` the moment the schema lands, 294 rows, and relies on RLS alone. Worse and separate, `execute` on a function defaults to `PUBLIC`, which both roles inherit, so every function was live at `/rest/v1/rpc/<name>` including `claim_seats()`. The decision stands and is now better supported: `0004` revokes the tables, sequences and functions, takes function `execute` off `PUBLIC` itself, revokes the default privileges, and enables RLS everywhere. Verified from outside with the publishable key and with a real signed-in session (`../local.md` §5a). |
| 21 | Capacity model | **One number per show** plus per-segment slices. No soft threshold, no `held_seats` column — held seats are simply seats no segment holds (`domain.md` §5.1, `allocation.md` §7.2). |
| 22 | Email addressing | Every message is addressed to a **registration**, never a seat. `email_outbox.registration_id` is not null and is the dedup key; a successful send stamps every attendee whose PDF it carried (`email.md` §11.4). |
| 23 | Review before send | Outbox rows are rendered into `DRAFT` and edited by a human — per template or per message — before anything is queued. The dispatcher sends stored content verbatim (`email.md` §11.5). |
| 24 | Delivery outside the system | An explicit "Mark as delivered" admin action sets `ticket_sent_at` with `source = MANUAL`, so hand-delivered tickets leave the pending bucket (`email.md` §11.6). |
| 25 | Editing a response | May correct or reduce, never add seats. More seats means a new EXTRA request at the back of the FCFS queue (`v2.md` §8.3.1). |
| 26 | Import direction | One import run per segment; after commit this database is the source of truth and there is no rollback or re-sync (`import.md` §9.1). |
| 27 | Referential integrity | Composite foreign keys, not triggers: an attendee cannot disagree with its registration about segment or show (`domain.md` §5.2). |
| 28 | QR durability | The scanner treats the QR as opaque data and never dereferences it, so a changed or dead `APP_URL` cannot affect admission. `qr_token` is immutable for life (`tickets.md` §10.1). |
| 30 | QR origin | **No custom domain.** The Vercel production alias `<project>.vercel.app` is the origin, which is safe because decision 28 makes admission independent of it. The project name is frozen before the first render and `APP_URL` is never derived from `VERCEL_URL` (`tickets.md` §10.1). |
| 31 | Party tickets | A registration is a party of N in both audiences: one email, N `qr_token`s, N PDFs. No shared "admits 4" QR. The door gets an **Admit remaining** control instead (`v2.md` §8.1, `checkin.md` §12.1). |
| 32 | Missing attendee names | Never blocking. Imported seats with no name ticket as "Guest of {contact_name}" with `name_source = PLACEHOLDER` (`v2.md` §8.2.1). |
| 29 | Delivery split | **V1** runs the concert (import → ticket → blast → door). **V2** adds native forms, the full portal and notes (`README.md` §4). |

## 19.2 Still open

Open questions are concert-specific and tracked in **`context.md` §6**, each with the date it is needed
by. Nothing in the system design is currently blocked on an unanswered question.
