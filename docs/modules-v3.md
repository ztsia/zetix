# V3 module map

**How V3 is cut into branches, what each one owns, and in what order.**

The companion to [`modules.md`](modules.md) and [`modules-v2.md`](modules-v2.md), whose rules still
apply. Behaviour comes from [`spec/v3.md`](spec/v3.md); where this file and the spec disagree, **the
spec wins** — this file allocates work, it does not define it.

---

## 1. Shape

V3 has no deadline, so it follows V2's lesson (`modules-v2.md` §2.1): start coarse, split a branch only
when it proves too big for one session. Letters continue from V2's `O`.

```
P schema delta ──► Q platform kernel ──┬──► S audience workspace ──► T send wizard & messages
                                       ├──► R roles & accounts
                                       ├──► U inbox & scheduler
                                       └──► V intake
                         S, T, U, V ──► W home, setup & theme ──► X publication
```

| Wave | Modules | Runs |
|---|---|---|
| 0 | `P` | alone — one migration |
| 1 | `Q` | alone — the shared machinery every screen uses |
| 2 | `R`, `S`, `U`, `V` | in parallel |
| 3 | `T` | after `S` |
| 4 | `W` | after `S`, `T`, `U`, `V` |
| 5 | `X` | last |

**Integration branch: `v3`.** Every module PR targets `v3`, which merges to `main` once, as V2 did.

---

## 2. The modules

### `P` — `claude/P-schema-delta`

**Spec:** `v3.md` §30.1, §30.2.

Schema and settings only, no screens. Every V3 column, table, view, enum value and settings key in one
migration numbered `0200`, the `claim_seats()` / `promote_seats()` override parameter with tests
written first (the §7.3 worked example must still pass unchanged with the override off), the
`party_pipeline` view with a test per stage and per flag, and the backfills (`approved_at`,
`attendees.requested_at`, `email_outbox.purpose`).

Also: the conditional `pg_cron` scheduling function (§27.2), created only where the extension exists.

**Done means:** one migration, `pnpm test` green including every V1/V2 idempotency and allocation test,
and `local.md` §16 carrying the manual-apply steps.

### `Q` — `claude/Q-platform-kernel`

**Spec:** `v3.md` §22.3, §23.1, §23.3, §23.6.

Built once because every later module uses it (the `F2` and `K` argument):

- `DataTable`: selection as `{ filter, excludedIds }` ("select all N matching" everywhere), saved views
  in the URL, server mode by default.
- The command runner: preview → run → report, `command_runs` / `command_run_items`, blast-radius
  helpers, the typed-confirmation threshold, and continuation from the scheduler tick.
- Trash and permanent delete; the Activity log reader.

### `R` — `claude/R-roles-accounts`

**Spec:** `v3.md` §28.

`VIEWER`, named admin accounts, Settings › People, `requireRole()` replacing `requireAdmin()` across
every action and handler, masking for viewers, guard tests extended to viewer denial, bootstrap script
updated. Operator auth unchanged.

### `S` — `claude/S-audience-workspace`

**Spec:** `v3.md` §21, §22, §23.2, §23.4, §23.5.

The Audience table on `party_pipeline`, both grains, built-in views including Needs review with the
pool meter, the party record, and every non-delivery command. Retires Registrations, Unverified,
Extras review and Tickets as separate screens.

### `T` — `claude/T-send-wizard`

**Spec:** `v3.md` §24.

The Send tickets wizard, purposes and per-segment defaults, supersede, late re-addressing, the Messages
view with an exit for every status, address checks on every entry path, the concert-scoped queue banner.
Retires Email and Email › Delivery. Template and design editors move under Setup unchanged.

### `U` — `claude/U-inbox-scheduler`

**Spec:** `v3.md` §26, §27.

`src/lib/mail/` with `MailInbox`, the IMAP adapter, tagging of outgoing messages, sync with cursors,
matching, bounce parsing, threads, the Inbox area, reply from the record; the tick route and its
heartbeat. Needs `P`'s outbox columns; shows its threads on `S`'s record once `S` lands.

### `V` — `claude/V-intake`

**Spec:** `v3.md` §25.

Public links and Copy link, the player picker, the receipt email, the review gate, duplicate
detection and merge, forms on their parents with a funnel, the party update link, waitlist mode, the
Invite players command, per-form themes, and the import staging grid with email grouping, wide-sheet
mapping and undo.

If it runs long, **import is the clean seam to split out**.

### `W` — `claude/W-home-setup-theme`

**Spec:** `v3.md` §29.

The seven-area navigation, Home, the setup checklist, Setup consolidation (concert editing included),
After consolidation, the theme switcher modelled on `ztsia/fyp-web-frontend`.

### `X` — `claude/X-publication`

**Spec:** `v3.md` §31.

Personal data out of the tree and history, `context.md` replaced by a fictional example, demo seed and
deployment, README with screenshots.

---

## 3. Separate sessions, not modules

- **Extracting `src/lib/mail/` into its own package**, with further provider adapters. `U` keeps it
  liftable; the extraction is its own project.
