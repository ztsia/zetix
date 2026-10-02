# CLAUDE.md

Orchestra concert ticketing system. Free admission, unreserved seating, no payments anywhere.

## Read these first

All in `docs/`. Each has one job; keep content in the file whose job it is.

| File | What it is | Treat it as |
|---|---|---|
| `docs/spec/` | The system, one file per module: data model, allocation, tickets, email, check-in, portal, surfaces | The contract. If code disagrees with it, the code is wrong. Start at `spec/README.md` — it maps sections to files. |
| `docs/context.md` | This concert: real capacities, player counts, dates, delivery plan, open questions | Facts, not rules. Never let these values reach code, and do not edit unless asked. |
| `docs/ref.md` | Patterns distilled from Hi.Events, chiefly the door-scanner IA | Background reading. Do not clone or copy from that repo. |
| `docs/modules.md`, `modules-v2.md`, `modules-v3.md` | How each version is cut into branches, what each owns, and the rules that keep parallel sessions from colliding | Your branch's boundary. Read the row for your module before starting. |
| `docs/local.md` | Everything only a human or a local session can do — dashboards, secrets, migrations | A queue. Add to it rather than attempting these from a cloud session. |
| `docs/handoff/` | One-time notes handing one session's context to the next | See below. Read once, then archive. |

### Session rotation

**At the start of a session, list `docs/handoff/`.** Any `.md` directly in it — not in `archive/`,
not the README — was written for you: read it before doing anything else, then archive it in the
same commit as your first real change:

```bash
git mv docs/handoff/<file>.md docs/handoff/archive/
```

A handoff is read once and never again. `docs/handoff/README.md` has the protocol for writing one;
the short version is that anything still true next week belongs in `docs/spec/`, `docs/context.md` or
`docs/local.md` instead.

## Where the build is

**V1 and V2 are complete and merged to `main`** (`A`–`I`, then `J`–`O`: native forms, the portal,
notes and feedback). The 19 Sep concert ran on V1; its feedback went out on 20 Sep. `pnpm dev`,
`pnpm test`, `pnpm build` and CI pass.

**Now: V3, in progress.** `P` (schema delta, `drizzle/0200`), `Q` (command runner, Trash, Activity),
`R` (named roles), `S` (the Audience workspace and party record), `T` (send wizard, Messages), `U`
(inbox and scheduler), `V` (intake), `W` (the seven-area console, Home, Setup, themes) and `Y`
(surface fixes, `v3.md` §32: whole-set table exports, the door's walk-ins and stats, the portal;
`drizzle/0205`) are done. **Next is `X`, publication, last**, which runs locally. The console is rebuilt around one record, the party,
with derived stages, work queues, whole-job commands, a send wizard, an intake review gate, an inbox
for replies and bounces, a `pg_cron` scheduler and named roles. Behaviour is `docs/spec/v3.md`; the
branch map is `docs/modules-v3.md` (`P`–`X`, each PR straight to `main`, migrations from `0200`); the
decisions it reverses are `docs/spec/decisions.md` §19.3. The console's navigation is data in
`src/app/(admin)/admin/nav.ts`: seven areas over routes that never moved (`v3.md` §29.6).
Every module branch starts by rebasing onto `main` and reading its handoff there (`modules-v3.md` §3).
Until V3 lands, the non-negotiables below describe the running system — where V3 changes one, the spec says so.

Deployment: Supabase live (`docs/local.md` §4, §5a, §8), Vercel project `zetix` in `sin1`,
`main` branch-protected requiring `ci`. Nothing is configured in code: every capacity, quota and
deadline is entered through the admin UI (§2.1). Human-only steps are queued in `docs/local.md`.

**`pnpm test` must never point at Supabase.** The suite truncates every table. Put the local
Postgres URL in `.env.test.local`, which vitest loads ahead of `.env.local`; `tests/helpers/db.ts`
refuses a non-local hostname outright (`docs/local.md` §6.1).

## Non-negotiables

- **No operational value is hardcoded.** Capacities, quotas, deadlines, party caps, batch sizes and
  rate limits are stored and admin-editable, resolved through the four-level cascade in `docs/spec/README.md` §2.2
  (segment → show → concert → system). If a number from `docs/context.md` appears in a `.ts` file, it is a
  bug.
- **`claim_seats()` is a Postgres function.** It holds a row lock across a read-then-write; oversell
  must be impossible. Its three-row worked example (`docs/spec/allocation.md` §7.3) is the primary test case — write
  those tests before the implementation.
- **Blasts are idempotent.** `ticket_sent_at` plus a partial unique index on pending outbox rows
  (`docs/spec/email.md` §11.4). Pressing Send twice must be harmless. **Email is addressed per registration, never
  per attendee** — `email_outbox.registration_id` is not null, and a nullable key would silently defeat
  the index.
- **Ticket template versions are pinned at issue time** (`docs/spec/tickets.md` §10.5). Never let a template edit
  silently change a ticket someone already holds.
- **Segments, not shows, own audience mode.** One show can hold both a public and a player-invited
  block, and for this concert it does. Allocation is computed per segment; the show owns only the hall.

- **The scanner never dereferences the QR.** It extracts the token by pattern and matches the offline
  manifest, so a wrong or dead `APP_URL` cannot stop admission (`docs/spec/tickets.md` §10.1). `qr_token` is
  immutable for the life of an attendee — reissuing re-renders the PDF, never the token.

- **`APP_URL` is the Vercel production alias**, hardcoded in the Production environment. Never derive
  it from `VERCEL_URL` — that is the per-deployment hostname and it dies within days.

- **A registration is a party of N, in both audiences.** One email, N `qr_token`s, N PDFs. An attendee
  with no name is not an error — it tickets as a placeholder (`docs/spec/v2.md` §8.2.1).
- **Asymmetric auth.** Named `ADMIN` and read-only `VIEWER` console accounts (email and password,
  `docs/spec/v3.md` §28); many `OPERATOR` accounts scoped to assigned shows. The check-in manifest
  endpoint must verify assignment before returning data — it is the full attendee roster
  (`docs/spec/checkin.md` §12.3, §14.3).
- **Every admin screen is readable by a viewer, and nothing on it is changeable by one.** Mutations,
  commands and exports call `requireRole('ADMIN')`; pages and reads call `requireRole('ADMIN', 'VIEWER')`
  and pass what they hand the browser through `maskForRole()` (`src/lib/auth/mask.ts`). Hide mutating
  controls with `<AdminOnly>` / `useCanEdit()` (`src/components/auth/role.tsx`); `ActionDialog`,
  `DeleteButton`, `CommandDialog` and the `DataTable` export already do. A server-side search a viewer
  can run must not match a column they see masked — a hit-or-miss answer spells the value out a
  character at a time. `tests/auth/viewer-denial.test.ts`, `viewer-routes.test.ts` and
  `viewer-pages.test.ts` call every action, every `/api` route and every page as a viewer; add a new
  page to the last one's list.

## Scope: V1 ships this concert

`docs/spec/README.md` §4 splits delivery. **V1** — config, players, spreadsheet import, allocation, ticket editor
and render, outbox and blast, door scanner, admin console, and a read-only ticket page at
`/t/{token}`. **V2** — native registration forms, the full portal, notes. Registration for both rounds
of this concert is on Google Forms, so V1 is a complete system on its own. Do not build V2 surfaces
into the V1 critical path; do not make schema choices that V2 would have to reshape.

## Stack

Next.js 16 (App Router, TypeScript) · shadcn/ui + Tailwind · Supabase (Postgres, Auth, Storage) ·
Drizzle · `nodemailer` + Gmail SMTP · `react-konva` · `pdf-lib` + `sharp` · `@zxing/browser` ·
Vercel Hobby.

Backend logic lives in Route Handlers and Server Actions. **No Supabase Edge Functions** — `sharp` is a
native Node addon and cannot run on Deno (`docs/spec/platform.md` §16.1).

Any route that sends email, renders PDFs, or parses spreadsheets needs `export const runtime = 'nodejs'`.
The email dispatch route also needs `export const maxDuration = 60`.

## Conventions

- Server Actions for mutations; Route Handlers where an external caller or a cron needs a URL.
- `zod` schemas shared between form validation, API boundaries and import mapping.
- One `DataTable` component (TanStack + shadcn) reused across registrations, attendees, players, notes,
  outbox and scan log. Build it well once.
- All timestamps `timestamptz` in UTC; render in `concert.timezone`, never the viewer's zone.
- Four surfaces with separate layouts: admin (web-first), registration (responsive), scanner
  (mobile-first), portal (mobile-first). See `docs/spec/surfaces.md` §15.

## Commands

```bash
pnpm dev
pnpm test                # claim_seats tests must pass before anything ships
pnpm db:generate         # drizzle migration from schema changes
pnpm db:migrate          # applies to DIRECT_URL (session pooler, port 5432)
pnpm tsc --noEmit

./scripts/qa-db.sh       # disposable zetix_qa database for a QA run
pnpm exec playwright test # end-to-end; Chromium is preinstalled, never `playwright install`
```

Two database URLs, not one. `DIRECT_URL` is the session pooler on `5432`, for migrations.

**`DATABASE_URL` was moved to the session pooler on `5432` on 10 Sep** and no longer matches
`docs/spec/platform.md` §16.2, which still says the transaction pooler on `6543`. That pooler
intermittently kills the first query on a fresh connection with a spurious `57014`, and `max: 1`
turns one wedged query into every route timing out at once. Evidence, and what to check before
moving it back, are in `docs/local.md` §5g. `prepare: false` stays either way.

The allocation engine is developed against a **local Postgres 16**, not Supabase — it needs `citext`,
`pg_trgm` and `pgcrypto` and nothing else (`docs/spec/platform.md` §16.4).

## Skills

Three project skills in `.claude/skills/`, available to every session:

| Skill | Use it when |
|---|---|
| `qa` | A module is finished and before its PR opens, or a non-negotiable was touched. Spawns the `qa-reviewer` subagent (`.claude/agents/`) — clean context, writes acceptance criteria from the spec *before* reading the code, checks the tests have teeth, then walks the flows in a real browser on happy **and** sad paths. |
| `uiux` | Choosing shadcn components for a screen, or auditing one. Reads its index first, then only the component docs it shortlists. All 61 components are already installed — never `npx shadcn add`. |
| `database` | Designing tables, writing or reviewing SQL and RLS, adding a mutation, or auditing a handler. It encodes this project's settled architecture, which is **not** the generic Supabase-first one. |

Skills are model-invoked from their descriptions — no session needs to be told to use one, and none
of them will stop to ask a question, because most sessions here run unattended. The **superpowers**
plugin was evaluated on 1 Sep and declined: its mandatory phases duplicate this file and the handoff
protocol, and its worktree machinery buys nothing when every module already gets its own session.
Worth revisiting after 19 Sep for V2.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
