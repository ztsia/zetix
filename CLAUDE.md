# CLAUDE.md

Orchestra concert ticketing system. Free admission, unreserved seating, no payments anywhere.

## Read these first

All in `docs/`. Each has one job; keep content in the file whose job it is.

| File | What it is | Treat it as |
|---|---|---|
| `docs/spec.md` | The system: data model, allocation engine, tickets, email, check-in, portal, surfaces | The contract. If code disagrees with it, the code is wrong. |
| `docs/context.md` | This concert: real capacities, player counts, dates, delivery plan, open questions | Facts, not rules. Never let these values reach code, and do not edit unless asked. |
| `docs/ref.md` | Patterns distilled from Hi.Events, chiefly the door-scanner IA | Background reading. Do not clone or copy from that repo. |
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
the short version is that anything still true next week belongs in `docs/spec.md`, `docs/context.md` or
`docs/local.md` instead.

## Where the build is

Scaffold only — no schema, no domain code yet. `pnpm dev`, `pnpm test`, `pnpm build` and CI all pass.

| Done | Not started |
|---|---|
| Next.js 16 + Tailwind 4 + all 61 shadcn components | **Drizzle schema** (`src/db/schema/`) |
| Drizzle/postgres.js wiring, two pooler URLs | **`claim_seats()`** and its tests — the next task |
| `src/lib/env.ts`, `/api/health` keep-alive | Everything in `docs/spec.md` §4.1 beyond those |
| CI: typecheck/lint/test/build on a real Postgres 16 | |
| Route groups for the four surfaces | |

**Next task**: decompose V1 (`docs/spec.md` §4.1) into modules that can be built in parallel, one
branch and one PR each. The schema and `claim_seats()` are not parallelisable and everything depends
on them, so they land first, on one branch — with the `docs/spec.md` §7.3 three-row worked example
written as tests *before* the implementation. After the decomposition, `docs/spec.md` becomes `spec/`,
one file per module.

Deployment state: Supabase project live (public sign-ups off, email confirmation on, all three
extensions installed); Vercel project `zetix` live in `sin1` with the GitHub repo connected and
Production env vars set; `main` is branch-protected requiring `ci`. What is still outstanding, and who
must do it, is in `docs/local.md`.

## Non-negotiables

- **No operational value is hardcoded.** Capacities, quotas, deadlines, party caps, batch sizes and
  rate limits are stored and admin-editable, resolved through the four-level cascade in `docs/spec.md` §2.2
  (segment → show → concert → system). If a number from `docs/context.md` appears in a `.ts` file, it is a
  bug.
- **`claim_seats()` is a Postgres function.** It holds a row lock across a read-then-write; oversell
  must be impossible. Its three-row worked example (`docs/spec.md` §7.3) is the primary test case — write
  those tests before the implementation.
- **Blasts are idempotent.** `ticket_sent_at` plus a partial unique index on pending outbox rows
  (`docs/spec.md` §11.4). Pressing Send twice must be harmless. **Email is addressed per registration, never
  per attendee** — `email_outbox.registration_id` is not null, and a nullable key would silently defeat
  the index.
- **Ticket template versions are pinned at issue time** (`docs/spec.md` §10.5). Never let a template edit
  silently change a ticket someone already holds.
- **Segments, not shows, own audience mode.** One show can hold both a public and a player-invited
  block, and for this concert it does. Allocation is computed per segment; the show owns only the hall.

- **The scanner never dereferences the QR.** It extracts the token by pattern and matches the offline
  manifest, so a wrong or dead `APP_URL` cannot stop admission (`docs/spec.md` §10.1). `qr_token` is
  immutable for the life of an attendee — reissuing re-renders the PDF, never the token.

- **`APP_URL` is the Vercel production alias**, hardcoded in the Production environment. Never derive
  it from `VERCEL_URL` — that is the per-deployment hostname and it dies within days.

- **A registration is a party of N, in both audiences.** One email, N `qr_token`s, N PDFs. An attendee
  with no name is not an error — it tickets as a placeholder (`docs/spec.md` §8.2.1).
- **Asymmetric auth.** One shared `ADMIN` account behind a single code; many `OPERATOR` accounts scoped
  to assigned shows. The check-in manifest endpoint must verify assignment before returning data — it
  is the full attendee roster (`docs/spec.md` §12.3, §14.3).

## Scope: V1 ships this concert

`docs/spec.md` §4 splits delivery. **V1** — config, players, spreadsheet import, allocation, ticket editor
and render, outbox and blast, door scanner, admin console, and a read-only ticket page at
`/t/{token}`. **V2** — native registration forms, the full portal, notes. Registration for both rounds
of this concert is on Google Forms, so V1 is a complete system on its own. Do not build V2 surfaces
into the V1 critical path; do not make schema choices that V2 would have to reshape.

## Stack

Next.js 16 (App Router, TypeScript) · shadcn/ui + Tailwind · Supabase (Postgres, Auth, Storage) ·
Drizzle · `nodemailer` + Gmail SMTP · `react-konva` · `pdf-lib` + `sharp` · `@zxing/browser` ·
Vercel Hobby.

Backend logic lives in Route Handlers and Server Actions. **No Supabase Edge Functions** — `sharp` is a
native Node addon and cannot run on Deno (`docs/spec.md` §16.1).

Any route that sends email, renders PDFs, or parses spreadsheets needs `export const runtime = 'nodejs'`.
The email dispatch route also needs `export const maxDuration = 60`.

## Conventions

- Server Actions for mutations; Route Handlers where an external caller or a cron needs a URL.
- `zod` schemas shared between form validation, API boundaries and import mapping.
- One `DataTable` component (TanStack + shadcn) reused across registrations, attendees, players, notes,
  outbox and scan log. Build it well once.
- All timestamps `timestamptz` in UTC; render in `concert.timezone`, never the viewer's zone.
- Four surfaces with separate layouts: admin (web-first), registration (responsive), scanner
  (mobile-first), portal (mobile-first). See `docs/spec.md` §15.

## Commands

```bash
pnpm dev
pnpm test                # claim_seats tests must pass before anything ships
pnpm db:generate         # drizzle migration from schema changes
pnpm db:migrate          # applies to DIRECT_URL (session pooler, port 5432)
pnpm tsc --noEmit
```

Two database URLs, not one: `DATABASE_URL` is the transaction pooler on `6543` with
`prepare: false`; `DIRECT_URL` is the session pooler on `5432` for migrations (`docs/spec.md` §16.2).

The allocation engine is developed against a **local Postgres 16**, not Supabase — it needs `citext`,
`pg_trgm` and `pgcrypto` and nothing else (`docs/spec.md` §16.4).