# V1 module map

**How V1 is cut into branches, what each one owns, and what it may not touch.**

One module per branch, one PR per branch into `main`, one cloud session per branch. This file is the
contract between those sessions: it is how nine sessions that never see each other's code avoid
building the same thing twice or reshaping each other's tables.

Scope comes from `spec/README.md` §4.1. Dates and priority come from `context.md` §5. Where this file
and the spec disagree about behaviour, the spec wins — this file allocates work, it does not define it.

---

## 1. The shape of the split

Two foundation branches land in sequence. Everything else fans out behind them.

```
F1 core ──► F2 shell ──┬──► A  config & people
                       ├──► B  registrations & extras review
                       ├──► C  spreadsheet import
                       ├──► D  ticket render ──► F  outbox & blast
                       ├──► E  template editor
                       ├──► G  door scanner
                       ├──► H  check-in dashboard & operators
                       └──► I  ticket status page
```

Only two edges in that graph are real dependencies rather than convenience: **everything waits on F1**,
and **F waits on D**. The rest is genuinely parallel.

### Why F1 is serial

Every module reads the same tables, and `claim_seats()` is the correctness core — oversell must be
impossible, and that property is established once, in one function, or not at all. A schema built by
nine sessions at once is nine migrations that conflict. `CLAUDE.md` states the rule: the
`spec/allocation.md` §7.3 three-row worked example is written as tests **before** the implementation.

### Why F2 is serial

`DataTable` is used by registrations, attendees, players, notes, outbox and the scan log. Built once it
is a day's work; built six times it is six inconsistent tables and six sets of bugs. Auth and the admin
shell are the same argument — every admin route mounts inside them.

F2 is UI over F1's tables and touches almost no domain logic, so it is short. Do not let it grow: if
something is only used by one module, it belongs to that module, not here.

---

## 2. Foundation

### F1 — `claude/core-schema-allocation`

**The blocker. Nothing else starts until this merges.**

| Owns | Spec |
|---|---|
| Drizzle schema, all V1 tables, in `src/db/schema/` | §5.1 |
| V2-shaped columns present but unused, so V2 reshapes nothing | §4.2 |
| Composite foreign keys on `registrations` and `attendees` | §5.2 |
| Indexes, including `outbox_no_duplicate_pending` | §5.1, §11.4 |
| Generated migrations (**generated here, applied by the user** — `local.md` §4) | §16.2 |
| The four-level settings cascade resolver: segment → show → concert → system | §2.2, §6 |
| `claim_seats()` and the base-entitlement guard on all three mutations | §7.4, §7.8 |
| Dev seed and fixtures against local Postgres 16 | §16.4 |
| A test harness that can exercise a Postgres function | §16.4 |

**Done means:** `pnpm test` runs the §7.3 three-row example green, the guard blocks all three
oversubscription routes with the error text of §7.4, and CI passes on a real Postgres 16.

**Write the tests first.** Not a style preference — it is the one non-negotiable in `CLAUDE.md` that
has a named test case attached to it.

### F2 — `claude/app-shell-auth`

| Owns | Spec |
|---|---|
| Supabase Auth wiring; shared `ADMIN` single-code login | §14.3 |
| `OPERATOR` login against synthetic `<slug>@operators.invalid` | §12.1, decision 20a |
| Route protection across all four surface groups | §15 |
| Admin layout, navigation, the empty route skeleton of §14.1 | §14.1, §15.1 |
| **`DataTable`** — TanStack + shadcn, the one shared table | conventions |
| `audit_log` writer helper | §2.4 |
| CSV/XLSX export helper | §14.1 |
| `scripts/bootstrap-admin.ts` | §5.1, `local.md` §5 |
| Admin login rate limiting (**V1, not V2**) | §4.2 |

**Done means:** an admin logs in with the bootstrap code and reaches an empty console; an operator logs
in and sees an empty show list; `DataTable` renders a demo dataset with sort, filter, pagination and
export.

---

## 3. Parallel modules

Each is a branch, a session and a PR. Each names the spec sections that are its contract.

| # | Branch | Owns | Spec | Depends on |
|---|---|---|---|---|
| **A** | `claude/config-and-people` | Concerts, shows, segments CRUD; capacity moves between segments; players CRUD + CSV import + invite tokens; system settings UI | §5.1, §6, §7.7, §14.1 | F2 |
| **B** | `claude/registrations-extras` | Registrations table and full manual CRUD; attendee editing; cancellation; **extras review screen** with the strict-FCFS preselection walk | §7.5, §7.6, §7.9 | F2 |
| **C** | `claude/spreadsheet-import` | Upload, header detection, mapping profiles, repeating-group mapping, validation, dry run, commit | §9 | F2 |
| **D** | `claude/ticket-render` | `ticket_code` / `qr_token` minting, layout renderer, QR, `pdf-lib` + `sharp`, seeded default templates, version pinning, reissue flagging | §10.1, §10.4, §10.5, §10.6 | F2 |
| **E** | `claude/template-editor` | `react-konva` canvas editor, element bindings, versioning, longest-name preview | §10.2, §10.3 | F2 |
| **F** | `claude/outbox-blast` | Email templates, render-to-`DRAFT`, review and edit, Gmail SMTP, `/api/outbox/dispatch`, idempotent blast, mark-delivered-by-hand | §11 | **D** |
| **G** | `claude/door-scanner` | Manifest endpoint with assignment check, offline queue, Scan / Search / Stats tabs, colour + sound + haptics | §12.1, §12.2, §12.3, §15.4 | F2 |
| **H** | `claude/checkin-dashboard` | Live check-in dashboard, scan log with revert, operator provisioning and show assignment | §12.4, §14.3 | F2 |
| **I** | `claude/ticket-status-page` | Read-only `/t/{qr_token}` — name, show, date, doors, venue, QR | §4.1, §13.2 | F2 |

### Notes on the two edges that matter

**F depends on D** because a blast attaches PDFs. This is the critical path — `context.md` §5 puts the
ticket pipeline at 13 Sep, and core → shell → D → F is the longest chain in the graph. Start D the
moment F2 merges and give it the strongest session.

**E does not depend on D**, despite appearances. The layout JSON format is fully specified in §10.2, so
the editor writes it and the renderer reads it against the same written contract. D ships seeded
default templates so the system renders tickets before anyone opens the editor — that is exactly what
decision 10 bought. Building them in parallel is safe; building E *first* is not, because then nothing
can render.

**G does not depend on D either.** The scanner matches `qr_token` against the offline manifest, and
tokens exist as soon as F1's schema does. It needs no PDF, no render, and no `APP_URL` — decision 28 is
what makes that true.

---

## 4. Rules for parallel sessions

Nine branches off one commit will collide unless these hold.

**The schema is frozen when F1 merges.** A module that needs a column it does not have does not add it
on its own branch — that is a second migration racing the first, and Drizzle will generate conflicting
files. Open a small PR against `main` that changes `src/db/schema/` alone, land it, then rebase. If it
is urgent enough to block, say so rather than working around it.

**Nobody rebuilds `DataTable`.** If it does not do what a module needs, extend the shared component in a
small PR. Six divergent copies is the specific failure this split exists to prevent.

**Stay inside your route group.** Modules touch their own routes under `src/app/(admin)/…`,
`(scanner)/…`, `(portal)/…`. The shared surfaces — nav registration, shared components, schema — are the
collision points; treat every edit to them as needing a reason.

**No operational value reaches code.** Capacities, quotas, deadlines, party caps, batch sizes and rate
limits resolve through the cascade. A number from `context.md` in a `.ts` file is a bug, and it is a bug
in whichever module wrote it (`CLAUDE.md`).

**The outbox cron stays out of `vercel.json` until F ships.** A cron pointed at a route that does not
exist 404s daily and trains everyone to ignore the alert (§11.2). F adds it; nobody else does.

**Every branch ends with a handoff.** `docs/handoff/<branch-slug>.md`, per the protocol in
`docs/handoff/README.md`.

---

## 5. Sequencing against the calendar

`context.md` §5 sets the deadlines: ticket pipeline **13 Sep**, scanner **18 Sep**, concert **19 Sep**.

| When | Serial | In parallel |
|---|---|---|
| 1 – 2 Sep | **F1 core** | — |
| 3 Sep | **F2 shell** | — |
| 3 – 8 Sep | — | **D render** (critical path), A, C, G |
| 6 – 11 Sep | — | B, E, H, I |
| 9 – 13 Sep | **F outbox & blast** | remainder |
| 14 – 18 Sep | — | scanner rehearsal, dry runs, fixes |

Phase 1 in `context.md` §5 allotted 31 Aug – 1 Sep to schema and shell together. That window closes
today with neither started, so **the plan is a day behind before the first branch opens.** The
compression above absorbs it by fanning out earlier and moving the admin shell off the critical path —
but there is no slack left after that. If F1 slips past 2 Sep, the thing to cut is not a Phase 1 item:
it is B's extras review screen (round 1 can be granted by hand for one concert) or H's dashboard.

**Two gates, neither of which is a checklist item:**

- **A printed-ticket scan test blocks the first blast** (§10.1 rule 6, §18). Render, print, scan on a real
  usher phone, off paper and off screen, in low light, offline.
- **A full 400-ticket dry run precedes first real use** (§18). Render time, function timeouts, font
  embedding and attachment size only surface at volume.

---

## 6. What is deliberately not a module

**V2 is not here** — native forms (§8), the full portal (§13), notes (§13.4, §14.2), per-IP rate
limiting (§8.3). `spec/README.md` §4.2 keeps them specified so the V1 schema does not need reshaping, but no
V1 branch builds them and none should make a schema choice V2 would have to undo.

**The spec split was not a module either, and is done.** `spec.md` is now `spec/` — one file per
module above — so that a session working on the scanner reads the scanner's spec rather than 2,000
lines of everything. `spec/README.md` carries the index and the section-to-file map. Section numbers
are unchanged, so §7.3 is still §7.3; only the filename in front of it moved.
