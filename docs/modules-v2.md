# V2 module map

**How V2 is cut into branches, what each one owns, and what it may not touch.**

The companion to [`modules.md`](modules.md), which did the same job for V1 and whose rules still apply.
One module per branch, one cloud session per branch, **one PR per branch into `v2`** — not into `main`.
`v2` is the integration branch; it merges to `main` once as a single release, after the 19 Sep concert.

Scope comes from `spec/README.md` §4.2. Behaviour comes from `spec/v2.md` (§8, §13) and
`spec/admin.md` §14.2. Where this file and the spec disagree about behaviour, **the spec wins** — this
file allocates work, it does not define it.

---

## 1. What V2 actually is

Five areas, from `spec/README.md` §4.2:

| Area | Spec |
|---|---|
| Native registration — both form types, the JSON renderer, response limiting, editing | `v2.md` §8 |
| Public verification — double opt-in, unverified-registration review | `v2.md` §8.1 |
| Full portal — progressive disclosure on admission, e-booklet, practical info | `v2.md` §13.1–§13.3 |
| Notes — leaving, moderation, the wall, per-player grouping, digests | `v2.md` §13.4, `admin.md` §14.2 |
| Rate limiting — per-IP form and portal throttles | `v2.md` §8.3 |

**V1 ships a complete system.** Nothing here is a fix; it is the surface set that assumes registration
has moved off Google Forms. That is why none of it was allowed onto the 19 Sep critical path
(`modules.md` §6), and why none of it should be rushed now that the path is clear.

## 1.1 The schema is very nearly already there — check before you migrate

`spec/README.md` §4.2 promised the V1 schema would not need reshaping to accept V2. That promise
**held**, and it was verified against the tree rather than assumed. Already live in `src/db/schema/`
and in migrations `0000`–`0006`:

- **`registration_forms`** — all sixteen columns of `domain.md` §5.1, including `schema` (jsonb),
  `slug`, the window and limit columns, `allow_edit_until` and `status`.
- **`form_responses`** — all seven, including `edit_token`, `ip_address` and `user_agent`.
- **`portal_notes`** — including both flags and `unique (attendee_id)`, which is what backs
  "one note per attendee" (`domain.md` §5.2).
- **`booklets`** — including `published`.
- **`concerts`** — `portal_enabled`, `notes_enabled`, `notes_close_at`, `public_wall_enabled`,
  `public_wall_visibility`, `practical_info_md`.
- **`shows.portal_unlock_mode`**, and the `form_status`, `moderation_status`, `wall_status`,
  `public_wall_visibility` and `name_source` enums.
- **Every V2 settings key** is already in the admin catalogue: `form.max_tickets_per_response`,
  `form.rate_limit_per_ip_per_min`, `form.seat_indicator_exact_below`, `portal.note_max_length`,
  `portal.unlock_mode`, `portal.notes_enabled`, `portal.notes_close_at`,
  `portal.public_wall_enabled`, `portal.public_wall_visibility`.

**So look first.** Two gaps were found, both owned by `SC` below. If you believe you have found a
third, that is a claim about the schema and it goes to `SC` as a small PR — you do not add a column on
your own branch (`modules.md` §4).

---

## 2. The shape of the split

```
SC schema delta  ─┐
                  ├─► FA  form admin
FK form kernel   ─┤
                  ├─► FP  public & player forms ──┬──► VF  verification & release
                  │                               └──► FE  response editing
                  ├─► PT  portal ──────────────────────► NW  notes, wall & digest
                  └─► RL  rate limiting
```

`SC` and `FK` are wave 0 and **run in parallel with each other** — `SC` touches `src/db/schema/` and
`drizzle/` only, `FK` touches `src/lib/forms/`, `src/components/` and a new route group. They do not
overlap. Open `SC` first anyway: its migration needs a manual apply to Supabase (`local.md` §4) and
nothing downstream can be tested against production until that lands.

Four edges are real dependencies rather than convenience: **FP waits on FK**, **VF and FE wait on FP**,
**NW waits on PT** for the section slot and on **SC** for the digest outbox key.

### Why `SC` is serial

Same argument as V1's F1. One migration, applied **by hand** to Supabase — so every V2 column has to be
in it, or someone runs a second manual apply on concert-adjacent infrastructure. It also touches
`email_outbox`, which carries a non-negotiable (§3.1 below). A schema built by six sessions at once is
six migrations that conflict, and Drizzle will generate conflicting files.

### Why `FK` is serial

`spec/surfaces.md` §15.2 is explicit: *"One generic renderer drives both form types from the JSON
schema — do not build two forms."* That renderer has three consumers — `FA`'s live preview, `FP`'s two
public surfaces, and `FE`'s edit screen. Built once it is a couple of days; built three times it is
three divergent renderers and three sets of validation bugs. This is V1's `DataTable` argument,
unchanged.

Keep `FK` small the same way F2 was kept small: **if something is used by exactly one module, it
belongs to that module.**

---

## 3. The modules

### Wave 0 — foundation

#### `SC` — `v2/SC-schema-delta`

**Spec:** `domain.md` §5.1, §5.2 · `v2.md` §8.1 · `email.md` §11.3, §11.4

Schema only. No screens, no handlers.

1. **Registration verification columns.** `v2.md` §8.1 holds a public registration's ticket email until
   the registrant clicks a verification link, and flags unverified registrations older than 48h for
   admin review. `registrations` carries nothing for this today — no verified timestamp and no token.
   Add them, and make the token unique and unguessable like `players.invite_token` is.
2. **The player-addressed digest.** `domain.md` §5.1 already records the resolution: *"`player_notes_digest`
   is the one player-addressed email. It arrives with V2 and adds a nullable `player_id` and its own
   partial unique index."* See §3.1 — **read it before writing the migration.**

**Migration numbering: V2 starts at `0100`.** `main` keeps `0007`+ free for any 19 Sep hotfix, so the two
lines cannot collide while `v2` is open. The gap is deliberate and documents itself.

**Done means:** `pnpm db:generate` produces one migration, `pnpm test` is green including V1's existing
outbox idempotency tests, and `local.md` carries the manual-apply entry.

#### `FK` — `v2/FK-form-kernel`

**Spec:** `v2.md` §8.2 · `surfaces.md` §15.2 · `README.md` §2.2

- The zod contract for the form JSON: four section types (`REGISTRANT`, `GUESTS_BASE`, `GUESTS_EXTRA`,
  `CUSTOM`) and the ten field types. Shared between the builder, the renderer and submit validation —
  one schema, three uses, per `CLAUDE.md`'s conventions.
- **The one generic renderer.** Both form types, driven from the JSON.
- `{{base_quota}}`-style interpolation into `description_md`, resolved through the cascade
  (`README.md` §2.2). This is how copy avoids hardcoding numbers — the same rule as code
  (`CLAUDE.md` non-negotiables).
- The `(registration)` route group and its layout: single column, no chrome, orchestra branding
  (`surfaces.md` §15.2).

**Done means:** a form JSON fixture renders both a player and a public form from one component, and
invalid JSON fails at the zod boundary with a usable message.

**May not touch:** `email_outbox`, allocation, the portal.

### Wave 1 — parallel

#### `FA` — `v2/FA-form-admin`

**Spec:** `v2.md` §8.2 · `domain.md` §5.1 (`registration_forms`) · `admin.md` §14.1

Admin-side form management under `(admin)/admin/concerts/[concertId]/forms/`: create and edit a form,
edit its JSON schema, set `round_label`, `slug`, the open/close window and the limit columns, move it
`DRAFT` → `OPEN` → `CLOSED`, and preview it live with `FK`'s renderer. Plus a `form_responses` viewer
(`DataTable`, server mode — `modules.md` §5.2.1).

A second registration round is **a new form on the same segment with a new `round_label`**, not an edit
of the old one (`domain.md` §5.1). The UI should make that the obvious path.

#### `FP` — `v2/FP-public-player-forms` · *depends on `FK`*

**Spec:** `v2.md` §8.1, §8.3, §8.4 · `surfaces.md` §15.2 · `allocation.md` §7.8

The public-facing surfaces: `/f/{slug}` and the player's `/f/{slug}?k={token}`.

- Player token resolution → known player, prefill, remaining base allocation. No password, no account.
- Public party submit: one registration, one `contact_email`, N attendees, N tickets.
- Response limiting (§8.3): windows, `max_responses`, `one_response_per_identity`,
  `max_tickets_per_response`, `auto_close_on_capacity`.
- **The seat indicator shows a band, not a number, below `form.seat_indicator_exact_below`** — it exists
  to avoid a stampede, so the threshold is the point of it.
- Confirmation (§8.4), and the closed/full states.

**Seats come from `claim_seats()`.** Do not write a second allocation path — that function is the
correctness core and oversell must be impossible (`CLAUDE.md`, `allocation.md` §7.3, §7.8).

**§8.4 is explicit that `email_outbox` rows are created but NOT sent.** Releasing them is `VF`'s job.

#### `VF` — `v2/VF-verification` · *depends on `FP`, `SC`*

**Spec:** `v2.md` §8.1 · `email.md` §11.3, §11.4 · `import.md` §9.4

Double opt-in for the public form: the `public_verify` email, the verification landing page, and the
`public_ticket` release once verified. The registration is `CONFIRMED` immediately — seats are scarce —
so **verification gates the email, never the seat.** Plus the admin review screen for unverified
registrations older than 48h.

**`source = IMPORT` skips verification entirely** (`v2.md` §8.1). An imported registrant never received
a link and holding their tickets behind one would strand them. Get this wrong and the 19 Sep cohort
loses its tickets.

This branch changes outbox release logic. **Re-run the blast idempotency tests** — pressing Send twice
must still be harmless (`email.md` §11.4).

#### `FE` — `v2/FE-response-editing` · *depends on `FP`*

**Spec:** `v2.md` §8.3.1 · `tickets.md` §10.6 · `allocation.md` §7.6

Editing an existing response, via `form_responses.edit_token` or the player token, while
`allow_edit_until` holds. **This module has the sharpest rules in V2 and §8.3.1 has them as a table —
implement the table.**

- An edit may **correct or reduce, never increase.** An edit form that can claim inventory is a second,
  unpoliced allocation path.
- **Remove** a guest → that attendee `CANCELLED`, seat returns to the pool immediately. Nothing caches
  seat counts, so there is no counter to update and none to drift (§8.3.1, `allocation.md` §7.8).
- **Add** a guest → refused. The form offers "request extra tickets", which creates a **new EXTRA
  request with a new `requested_at`**, at the back of the FCFS queue. Keeping the original timestamp
  would let an early registrant reserve a queue position for seats they had not asked for.
- A name or email fix after `ticket_sent_at` sets `needs_reissue` (`tickets.md` §10.6).
- Once tickets are sent, editing closes to the registrant; changes go through admin (`allocation.md` §7.6).

#### `PT` — `v2/PT-portal`

**Spec:** `v2.md` §13.1, §13.2, §13.3 · `surfaces.md` §15.3

Grows module `I`'s read-only `/t/{token}` into the full portal. `I` already built the four states of
§13.2 — **read that page before changing it**, and preserve two properties it got right:

- **The "no such ticket" response is one response for all three reasons** (no match, malformed,
  soft-deleted), so the page cannot tell a wrong guess from a near miss.
- **It renders at `200`, it does not call `notFound()`.** §13.2 explains the trade at length and it was
  measured. Do not "fix" it.

Then: `shows.portal_unlock_mode` (`ON_ADMISSION` / `OPEN_TO_ALL` / `CLOSED`), the unlocked sections of
§13.3 — ticket, booklet viewer in a mobile PDF reader, practical info — and the admin side of booklet
upload and `published`.

**`concerts.portal_enabled` does not gate the status page.** A printed QR cannot be recalled when a flag
is flipped, so turning the portal off must never turn a ticket into a dead link (§13.2).

**Leave a seam for notes.** `NW` mounts §13.4 into the unlocked sections; agree the slot rather than
letting `NW` rewrite this page.

**Segment is never shown to the audience** (§13.3). A guest does not need to know they were in the
"public" block.

#### `NW` — `v2/NW-notes-wall` · *depends on `PT`, `SC`*

**Spec:** `v2.md` §13.4 · `admin.md` §14.2 · `email.md` §11.3

The largest wave-1 branch; consider giving it the longest session.

Portal side: leave a note, one per attendee per show, editable until `notes_close_at`. **The addressing
behaviour derives from the attendee's segment, not the show** — a single show carries both audiences, so
a `PLAYER_INVITED` attendee gets their inviting player prefilled and changeable, and a `PUBLIC` attendee
gets a searchable dropdown plus "The whole orchestra" (§13.4).

Admin side (`admin.md` §14.2): the wall, grouped-by-player view (**admin-only, always**), approve/hide in
bulk, publish to the public wall, export a player's notes, and queue `player_notes_digest` emails.

**The two flags are independent and stay that way** — `moderation_status` is admin triage,
`wall_status` is whether it appears publicly. **A note addressed to a specific player is never
auto-published**; it is personal mail bound for that player's digest.

#### `RL` — `v2/RL-rate-limiting`

**Spec:** `v2.md` §8.3 · `ref.md` §7 · `admin.md` §14.3

Per-IP throttles on the form and portal surfaces, reading `form.rate_limit_per_ip_per_min` through the
cascade. **Extend `src/lib/auth/rate-limit.ts`** — V1 already built this for admin login and a second
implementation is two behaviours under one name.

Small, and it touches two other modules' surfaces, which is exactly why it has one owner rather than
being done twice. Land it last. If sessions are scarce it can fold into `FK`, but then `FK` owns the
portal side too and must say so.

**It goes in the handler, never in `src/proxy.ts`** — the proxy never reads the database
(`modules.md` §5.2.1).

---

## 3.1 The one place V2 touches a V1 non-negotiable

`email_outbox.registration_id` is **not null**, and `CLAUDE.md` says why: *"a nullable key would
silently defeat the index."* The partial unique index on `(registration_id, template_key)` where status
is pending is what makes a repeat blast harmless.

`player_notes_digest` is addressed to a **player**, who has no registration. `domain.md` §5.1 already
settled the shape — a nullable `player_id` and its own partial unique index — but the migration still
has to make `registration_id` nullable to hold a digest row, and that is the exact move the warning is
about.

**The warning is about swapping the key to a nullable one, not about adding a disjoint second key.** So
`SC` must keep both keys total, not optional:

- add nullable `player_id`
- a `check` that **exactly one** of `registration_id` and `player_id` is non-null
- a second partial unique index on `(player_id, template_key)` over the same pending statuses

Every registration-addressed row then still has a non-null `registration_id` and the original index
bites exactly as before. **If `SC` lands without that check constraint, the non-negotiable is gone and
nothing will tell you** — a row with both keys null conflicts with nothing, and `on conflict do nothing`
silently does nothing (`domain.md` §5.1). Write the test that proves a double-queued digest is refused.

---

## 4. Rules for parallel sessions

Everything in `modules.md` §4 still holds, unchanged: **the schema is frozen once `SC` merges**, nobody
rebuilds `DataTable`, stay inside your route group, **no operational value reaches code**, every branch
ends with a `qa` pass, and every branch ends with a handoff under `docs/handoff/` per
`docs/handoff/README.md`.

Four things are specific to V2:

**PRs target `v2`, never `main`.** CI (`on: pull_request`, unfiltered) runs on them already. Note that
`v2` is **not** branch-protected the way `main` is, so green CI does not by itself block a merge —
review accordingly, or ask for a ruleset (`local.md`).

**Rebase on `v2`, not on `main`.** `main` may take a 19 Sep hotfix while V2 is in flight. `v2` picks
those up by merging `main` in; individual branches should not each do it separately.

**V2 is not on a deadline, and that changes what "done" means.** V1 shipped under a dated gun and
`modules.md` §5.3 had a cut list. There is no equivalent here. A branch that is not right does not
merge — nothing downstream is waiting on a concert.

**Read `spec/decisions.md` §19.1 before proposing anything that contradicts a decision.** The obvious
simplification was usually considered and is worse. V2 inherits 36 settled decisions.

---

## 5. Sequence

| Wave | Branches | Notes |
|---|---|---|
| 0 | `SC`, `FK` | Parallel with each other. Open `SC` first — its migration needs a manual Supabase apply before anything downstream can be tested against production |
| 1 | `FA`, `FP`, `PT` | Fan out behind `FK`. `PT` needs neither wave-0 branch and could start immediately |
| 2 | `VF`, `FE`, `NW` | Behind `FP` and `PT` |
| 3 | `RL` | Last. Touches the surfaces the others built |

Nine branches, against V1's eleven. **There is no critical path** — V2's whole premise is that
registration already works on Google Forms, so nothing here blocks a concert.

The one ordering constraint worth respecting is `SC` → manual apply → everything that writes
verification or digest rows. That is a human step in the middle of the graph (`local.md` §4), not a
merge.

---

## 6. What is deliberately not a module

**The V1 backlog is not V2 work.** Two items are outstanding on `main` and belong there, not here:
the shared `AlertDialogAction` fix (25 call sites across 7 files leave a modal standing over an inert
shell — `docs/handoff/archive/blast-queue-banner-outgoing.md`), and the stale `qa/e2e/f-blast.spec.ts`
FLOW-10 assertion. Both predate `v2` and both should land on `main` and flow in.

**The `registrations_no_duplicate_import` index is not V2 either**, but `SC` is the natural place to
carry it — it was written out and deliberately deferred only because a migration before 19 Sep meant a
manual deployment step (`docs/handoff/archive/import-reimport-dedup.md`). That reason expires with the
concert. The SQL is in that handoff.

**Out of scope entirely, per `spec/README.md` §4.3:** payments, pricing, refunds, seat selection or seat
maps, waitlist auto-promotion emails, SMS, native mobile apps, multi-organisation tenancy, i18n, public
marketing pages.
