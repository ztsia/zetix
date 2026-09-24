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

Six areas. Five come from `spec/README.md` §4.2; the sixth was added when V2 was refined on 13 Sep:

| Area | Spec |
|---|---|
| Native registration — both form types, the JSON renderer, response limiting, editing | `v2.md` §8 |
| Public verification — double opt-in, unverified-registration review | `v2.md` §8.1 |
| Full portal — progressive disclosure on admission, e-booklet, practical info | `v2.md` §13.1–§13.3 |
| Notes — leaving, moderation, the wall, per-player grouping, digests | `v2.md` §13.4, `admin.md` §14.2 |
| Rate limiting — per-IP form and portal throttles | `v2.md` §8.3 |
| **Feedback** — a post-show form, the admitted-only blast, show auto-completion | `v2.md` §13.5 |

They are **six areas across six branches, and the two lists do not line up** — rate limiting rides with
the form kernel, feedback rides with the portal, and verification and editing ride with the registration
surface. §2.1 says why.

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

**So look first.** The promise held for everything above. It did **not** survive the 13 Sep refinement
untouched: that session settled the form-builder shape, the feedback surface and show auto-completion,
and those need columns nobody had written down. The full delta is `J`'s scope in §3.

If you believe you have found a further gap, that is a claim about the schema and it goes to `J` as a
small PR — you do not add a column on your own branch (`modules.md` §4).

---

## 2. The shape of the split

```
J  schema delta ─┐
                 ├─► L  form admin
K  form kernel  ─┤
                 ├─► M  registration surface
                 │
                 └─► N  portal, feedback & post-show ──► O  notes, wall & digest
```

Exact dependencies are in §2.2 — `L` needs only `K`, and `N`'s portal half needs neither wave-0 branch.

Six branches. **V1 ran `A`–`I`; V2 continues the same series from `J`**, so a branch letter is
unambiguous for the life of the repository.

### 2.1 Why six and not ten

V2 was first cut into ten branches, mirroring V1's eleven. That was a mistake worth recording, because
the reasoning is easy to repeat.

**V1's fine cut was a scheduling instrument.** `modules.md` §5.1 says so outright — *"Wave 2 is the
whole point of the split"* — eight branches running at once, in up to eight sessions, against a concert
on 19 Sep that `modules.md` §5.3 shows the plan was already a day behind. Slicing thin is how eight
sessions start on day one without colliding.

**V2 has no deadline** (§4), so it starts one or two sessions at a time and that instrument buys
nothing. What it costs is real: more branches than the work needs means more boundaries to police, more
PRs to review, and more seams between things that are one thing.

The asymmetry that settles it: **splitting late was expensive in V1 and is free here.** V1 had to get
the boundaries right up front, because a boundary error meant two sessions building the same thing under
a date. V2 can start coarse and split a branch at the moment it actually proves too big for one session.
So it starts coarse.

**Two of the original ten were serial for real reasons and survive unchanged** — `J` because a schema is
one migration, `K` because a renderer with three consumers is built once. Those are correctness
arguments, not scheduling ones, and they are the only two.

Three merges followed, each of a thing that was never separate:

| Merged | Into | Because |
|---|---|---|
| Rate limiting | `K` | The zod contract, the renderer and the per-IP throttle are one handler layer. The ten-branch map already floated this |
| Verification, response editing | `M` | Neither is a feature beside the public form; both are *parts of* it — same route group, same renderer, same rules |
| Feedback & post-show | `N` | Feedback is a section on a page whose phases `N` already computes |

`N`'s merge is the one with a real argument against it: feedback is the only V2 work that touches show
lifecycle and email dispatch, and it re-opens the blast idempotency tests. It is still one page and one
phase calculation, so it stays together — but if that branch runs long, **feedback is the clean seam to
split back out.**

### 2.2 Dependencies

```
J ──► everything that writes a V2 column
K ──► L, M
N ──► O
```

`J` and `K` are wave 0 and **run in parallel with each other** — `J` touches `src/db/schema/` and
`drizzle/` only, `K` touches `src/lib/forms/`, `src/components/` and a new route group. They do not
overlap. Open `J` first anyway: its migration needs a manual apply to Supabase (`local.md` §4) and
nothing downstream can be tested against production until that lands.

`N` needs neither wave-0 branch for its portal half and could start immediately; its feedback half needs
`J`'s columns and `K`'s renderer.

### Why `J` is serial

Same argument as V1's `F1`. One migration, applied **by hand** to Supabase — so every V2 column has to
be in it, or someone runs a second manual apply on concert-adjacent infrastructure. It also touches
`email_outbox`, which carries a non-negotiable (§3.1 below). A schema built by several sessions at once
is several migrations that conflict, and Drizzle will generate conflicting files.

### Why `K` is serial

`spec/surfaces.md` §15.2 is explicit: *"One generic renderer drives both form types from the JSON
schema — do not build two forms."* That renderer has three consumers — `L`'s live preview, `M`'s public
surfaces, and `M`'s edit screen. Built once it is a couple of days; built three times it is three
divergent renderers and three sets of validation bugs. This is V1's `DataTable` argument, unchanged.

Keep `K` small the same way `F2` was kept small: **if something is used by exactly one module, it
belongs to that module.**

---

## 3. The modules

### Wave 0 — foundation

#### `J` — `claude/J-schema-delta`

**Spec:** `domain.md` §5.1, §5.2 · `v2.md` §8.1.4 · `email.md` §11.3, §11.4

Schema only. No screens, no handlers. Every column V2 needs is in this one migration.

1. **Registration verification columns.** `v2.md` §8.1.4 holds a public registration's ticket email until
   the registrant clicks a verification link, and flags unverified registrations older than 48h for
   admin review. `registrations` carries nothing for this today — no verified timestamp and no token.
   Add `email_verified_at` and `verification_token`, the token unique and unguessable like
   `players.invite_token` is.
2. **The player-addressed digest.** `domain.md` §5.1 already records the resolution: *"`player_notes_digest`
   is the one player-addressed email. It arrives with V2 and adds a nullable `player_id` and its own
   partial unique index."* See §3.1 — **read it before writing the migration.**
3. **`shows.ends_at`** (nullable). What "the show is over" is measured from (`v2.md` §13.2.1). **Nullable
   on purpose and inert when null** — no post-show phase, no auto-completion, no inferred duration
   (decision 41).
4. **`registration_forms.kind`** (`PLAYER` | `PUBLIC` | `FEEDBACK`) and **`schema_version`**, plus a
   nullable `show_id` so a `FEEDBACK` form can attach to a show rather than a segment
   (`v2.md` §8.1, §8.2.4). `segment_id` becomes nullable for the same reason; add a `check` that a form
   has exactly one parent.
5. **`form_responses`**: `form_schema` (the pinned schema), `identity_key` **with its partial unique
   index** on `(form_id, identity_key)`, and `supersedes_id`. The index is what makes
   `one_response_per_identity` real rather than a racing read-then-write (`v2.md` §8.3).
6. **`registrations.custom` and `attendees.custom`** (jsonb, nullable) — the queryable copy of custom
   answers, because `form_responses.raw` exists only for `source = FORM` (`v2.md` §8.2.3).
7. **`feedback_responses`**, unique on `(attendee_id, form_id)` (`v2.md` §13.5, `domain.md` §5.1).
8. **The new settings keys** in the admin catalogue: `show.auto_complete_after_hours`,
   `portal.booklet_enabled`, `portal.feedback_enabled`, `portal.feedback_close_at`,
   `portal.feedback_send_hour`, `form.verification_grace_hours` (`domain.md` §6).

**None of these carries an operational default in code** (§2.1). `show.auto_complete_after_hours` and
`portal.feedback_send_hour` are seeded at system level like every other runtime value and are editable
per show and per concert.

**Migration numbering: V2 starts at `0100`.** `main` keeps `0007`+ free for any 19 Sep hotfix, so the two
lines cannot collide while `v2` is open. The gap is deliberate and documents itself.

**Done means:** `pnpm db:generate` produces one migration, `pnpm test` is green including V1's existing
outbox idempotency tests, and `local.md` carries the manual-apply entry.

#### `K` — `claude/K-form-kernel`

**Spec:** `v2.md` §8.2, §8.3 · `surfaces.md` §15.2 · `README.md` §2.2 · `ref.md` §7

- The zod contract for the form JSON: five block types (`REGISTRANT`, `GUESTS_BASE`, `GUESTS_EXTRA`,
  `GUESTS_PARTY`, `CUSTOM`) and the ten field types. Shared between the builder, the renderer and submit
  validation — one schema, three uses, per `CLAUDE.md`'s conventions.
- **The `system` flag on a field, and the `creates_seat` flag on a `REGISTRANT` block** (`v2.md` §8.2).
  These are the whole mapping model: a system field's `key`, `type` and `required` are immutable and the
  zod contract must refuse a schema that alters or omits one. **There is no mapping step anywhere in V2**
  (decision 35), and this is the boundary that guarantees it.
- **Conditional logic evaluation, custom-to-custom only** (decision 37). A condition that names a system
  field as either source or target is a schema error, not a runtime no-op — it must fail loudly at the
  zod boundary, because the failure mode of the alternative is a form that silently stops asking for an
  email.
- **The one generic renderer.** All three form kinds, driven from the JSON.
- `{{base_quota}}`-style interpolation into `description_md`, resolved through the cascade
  (`README.md` §2.2). This is how copy avoids hardcoding numbers — the same rule as code
  (`CLAUDE.md` non-negotiables).
- The `(registration)` route group and its layout: single column, no chrome, orchestra branding
  (`surfaces.md` §15.2).
- **Per-IP rate limiting for the form and portal surfaces**, reading `form.rate_limit_per_ip_per_min`
  through the cascade. **Extend `src/lib/auth/rate-limit.ts`** — V1 built it for admin login and a second
  implementation is two behaviours under one name. It goes in the handler, **never in `src/proxy.ts`**,
  which never reads the database (`modules.md` §5.2.1). It lives here because `K` already owns the
  boundary every form surface passes through; it was a separate branch in the first cut and did not
  earn one.

**Done means:** one component renders a player form, a public form and a feedback form from three
fixtures; invalid JSON fails at the zod boundary with a usable message; a schema that tries to delete
`contact_email`, retype `full_name`, or condition on a system field is refused with a test proving it;
and a throttled surface returns the right response without the proxy touching the database.

**May not touch:** `email_outbox`, allocation, the portal.

### Wave 1 — parallel

#### `L` — `claude/L-form-admin` · *depends on `K`*

**Spec:** `v2.md` §8.2, §8.5 · `domain.md` §5.1 (`registration_forms`) · `admin.md` §14.1

Admin-side form management under `(admin)/admin/concerts/[concertId]/forms/`: create and edit a form,
set `round_label`, `slug`, the open/close window and the limit columns, move it `DRAFT` → `OPEN` →
`CLOSED`, and preview it live with `K`'s renderer. Plus a `form_responses` viewer (`DataTable`, server
mode — `modules.md` §5.2.1).

**The builder is Google-Forms-shaped and it is the point of the module** — add a block, drag to reorder,
live preview — but it is not a JSON textarea and it is not a field mapper:

- **System blocks are pre-built from `kind`** and cannot be added or deleted. Their key fields render as
  locked rows: label, help text and placeholder are editable, `key` and `type` are not (`v2.md` §8.2).
- **Custom blocks are the free editor** — the ten field types, required, options, and show/hide
  conditions that may only read and target other custom fields.
- **Copy interpolates resolved settings** — `{{base_quota}}`, `{{max_additional_guests}}` — so a form's
  own text never hardcodes a number either (§2.1).
- **Editing the schema bumps `schema_version`.** Responses pin the version they were answered against,
  so an edit never rewrites the meaning of an answer already given (`v2.md` §8.2.4).

A second registration round is **a new form on the same segment with a new `round_label`**, not an edit
of the old one (`domain.md` §5.1). The UI should make that the obvious path.

**Exports are this module's, for all three form kinds** (`v2.md` §8.5): columns built from the **pinned
schema** rather than from the responses, so question order is the admin's and an unanswered question
still gets a column. Registration forms export one row per registration with the party expanded;
feedback forms one row per attendee. Reuse `/api/export/xlsx` — `F2` built it.

#### `M` — `claude/M-registration-surface` · *depends on `K`, `J`*

**Spec:** `v2.md` §8.1, §8.3, §8.3.1, §8.4 · `surfaces.md` §15.2 · `allocation.md` §7.8, §7.6 ·
`email.md` §11.3, §11.4 · `tickets.md` §10.6 · `import.md` §9.4

**The whole public registration flow, end to end.** It was three branches in the first cut — the forms,
verification, and editing — which are not three things: they are one surface, one renderer and one set of
rules, and splitting them put the same route group under three owners.

**The forms** (`/f/{slug}`, and the player's `/f/{slug}?k={token}`):

- Player token resolution → known player, prefill, **remaining** base allocation — not `base_quota`,
  which would re-offer seats the player already holds (`v2.md` §8.1.1).
- **The player form is three blocks** (details, base seats, extra seats); **the public form is two**, and
  on the public form the registrant **is seat #1** — their own details produce an attendee row as well as
  the registration's contact fields, so the repeater renders `form.max_tickets_per_response − 1` rows
  (decision 36).
- Public party submit: one registration, one `contact_email`, N attendees, N tickets. All public seats
  are `allocation_type = EXTRA`, exactly where import already puts them (`v2.md` §8.1.2).
- **Every seat carries a name and every response an email** (`v2.md` §8.1.3). `PLACEHOLDER` names are for
  imported rows only — do not add a "just give me a number" path to a form we control.
- Response limiting (§8.3): windows, `max_responses`, `one_response_per_identity`,
  `max_tickets_per_response`, `auto_close_on_capacity`.
- **The seat indicator shows a band, not a number, below `form.seat_indicator_exact_below`** — it exists
  to avoid a stampede, so the threshold is the point of it.
- Confirmation (§8.4), and the closed/full states.

**Seats come from `claim_seats()`.** Do not write a second allocation path — that function is the
correctness core and oversell must be impossible (`CLAUDE.md`, `allocation.md` §7.3, §7.8). A submit
that loses the race against the cached indicator gets the segment's real state back and says so; it
never silently succeeds with fewer seats than the form showed.

**Verification** — double opt-in for the public form: the `public_verify` email, the verification
landing page, and the `public_ticket` release once verified. The registration is `CONFIRMED` immediately
— seats are scarce — so **verification gates the email, never the seat.** Plus the admin review screen
for registrations unverified beyond `form.verification_grace_hours`.

**`source = IMPORT` skips verification entirely** (`v2.md` §8.1.4). An imported registrant never received
a link and holding their tickets behind one would strand them. Get this wrong and the 19 Sep cohort
loses its tickets. **§8.4 is explicit that `email_outbox` rows are created but NOT sent** — this branch
owns both halves of that, so the release path and the creation path are read together.

**This branch changes outbox release logic. Re-run the blast idempotency tests** — pressing Send twice
must still be harmless (`email.md` §11.4).

**Editing** an existing response, via `form_responses.edit_token` or the player token, while
`allow_edit_until` holds. **This is the sharpest rule set in V2 and §8.3.1 has it as a table — implement
the table.**

- An edit may **correct or reduce, never increase.** An edit form that can claim inventory is a second,
  unpoliced allocation path.
- **Remove** a guest → that attendee `CANCELLED`, seat returns to the pool immediately. Nothing caches
  seat counts, so there is no counter to update and none to drift (§8.3.1, `allocation.md` §7.8).
- **Add** a guest → refused. The form offers "request extra tickets", which creates a **new EXTRA
  request with a new `requested_at`**, at the back of the FCFS queue. Keeping the original timestamp
  would let an early registrant reserve a queue position for seats they had not asked for.
- An edit **inserts a new `form_responses` row** chained by `supersedes_id`; it never mutates `raw`
  (`v2.md` §8.2.3).
- A name or email fix after `ticket_sent_at` sets `needs_reissue` (`tickets.md` §10.6).
- Once tickets are sent, editing closes to the registrant; changes go through admin (`allocation.md` §7.6).

**This is the largest branch in V2. If it runs long, verification is the clean seam to split out** — it
is the one part with its own email templates and its own admin screen.

#### `N` — `claude/N-portal`

**Spec:** `v2.md` §13.1, §13.2, §13.2.1, §13.3, §13.5 · `surfaces.md` §15.3 · `email.md` §11.2, §11.4 ·
`platform.md` §17.1

Grows module `I`'s read-only `/t/{token}` into the full portal, including its post-show life. `I`
already built the pre-admission states of §13.2 — **read that page before changing it**, and preserve
two properties it got right:

- **The "no such ticket" response is one response for all three reasons** (no match, malformed,
  soft-deleted), so the page cannot tell a wrong guess from a near miss.
- **It renders at `200`, it does not call `notFound()`.** §13.2 explains the trade at length and it was
  measured. Do not "fix" it.

**The portal proper.** `portal.unlock_mode` (`ON_ADMISSION` / `OPEN_TO_ALL` / `CLOSED`) **resolved
through the cascade, never read off the column** (§2.2), and the unlocked sections of §13.3 — ticket,
booklet viewer in a mobile PDF reader, practical info — plus the admin side of booklet upload and
`published`. Each section is independently enabled per show: `portal.booklet_enabled`,
`portal.notes_enabled`, `portal.feedback_enabled`.

**`unlock_mode` answers who, never when** (decision 39). It gates *who* may see unlocked sections; it is
never flipped by a show reaching `COMPLETED`, because `CLOSED` would take the booklet and the feedback
form down at the moment attendees are emailed a link to them.

**The post-show phase is derived, not stored** (`v2.md` §13.2.1, decision 40):

```
show is over  ⇔  now() > shows.ends_at + resolveSetting('show.auto_complete_after_hours')
```

No job, no flag, correct the instant it is true — a guest opening their link at 11pm on concert night
gets the post-show portal. **With `ends_at` null there is no post-show phase at all** (decision 41).

**`concerts.portal_enabled` does not gate the status page.** A printed QR cannot be recalled when a flag
is flipped, so turning the portal off must never turn a ticket into a dead link (§13.2).

**Segment is never shown to the audience** (§13.3). A guest does not need to know they were in the
"public" block.

**Feedback** (§13.5) is a section of this page and ships with it:

1. **The form.** A `kind = FEEDBACK` form with **no seat blocks** — the `REGISTRANT` block collapses to
   the identity resolved from the attendee's own `qr_token` and everything else is custom fields. Built
   in `L`'s builder, rendered by `K`'s renderer, exported by `L`'s exporter. One response per attendee,
   `unique (attendee_id, form_id)`.
2. **Its slot.** Last in §13.3's list, **first on the page** once the show is over — nobody opens that
   link to re-read the parking instructions.
3. **Show auto-completion.** `OPEN` → `COMPLETED` once `now() > ends_at + show.auto_complete_after_hours`,
   run on the **existing daily dispatch cron** — not a new scheduled job. Vercel Hobby allows two crons
   and both are spent (`platform.md` §17.1), and the precision buys nothing now that the portal phase is
   read from the clock (decision 40). It only ever moves `OPEN` → `COMPLETED`, never touches `DRAFT` or
   `CLOSED`, never reopens anything, does nothing at all when `ends_at` is null, and is idempotent.
4. **The blast.** Completion queues `email_outbox` rows as `QUEUED` with `scheduled_for` set to the next
   `portal.feedback_send_hour` in `concert.timezone`.

**Admitted only, computed at send time.** The audience is attendees with a `check_ins` row — a manual or
override admit counts, because those people were in the hall. **Do not freeze the list at completion
time:** an usher's phone that stayed offline all evening may not drain until the next morning
(`checkin.manifest_ttl_hours` is 12), and a frozen list would silently omit everyone on that device with
nothing to reveal it (`v2.md` §13.5.1).

**One email per registration, carrying one link per admitted attendee.** Decision 22 is unchanged: a
party of four where three were admitted gets one message with three links, the same shape as the ticket
blast carrying N PDFs.

**This branch narrows decision 23 and must say so where it does.** Feedback rows are queued directly,
skipping the `DRAFT` review gate — settled as decision 38. Everything else in the outbox keeps the gate.
`outbox_no_duplicate_pending` is what makes double-queueing harmless; **re-run the blast idempotency
tests** (`email.md` §11.4).

**Every automatic step needs its manual twin** (decision 42, §2.4): the status dialog still sets
`COMPLETED` by hand, **Generate feedback emails** queues without waiting for the cron, and **Send now**
on the blast screen drains immediately. Shipping the automation without the buttons is not done.

**Leave a seam for notes.** `O` mounts §13.4 into the unlocked sections; agree the slot rather than
letting `O` rewrite this page. The slot needs to accept an ordering, not just an append — feedback
already moves to the top after the show.

**Done means:** each of §13.2's states renders for a real token; a show with `ends_at` in the past
auto-completes on one cron run and not on the next; a show with `ends_at` null never auto-completes;
feedback queues once for a party with mixed attendance and carries exactly the admitted links; and every
automatic step has a working button.

#### `O` — `claude/O-notes-wall` · *depends on `N`, `J`*

**Spec:** `v2.md` §13.4 · `admin.md` §14.2 · `email.md` §11.3

Portal side: leave a note, one per attendee per show, editable until `portal.notes_close_at`. **The
addressing behaviour derives from the attendee's segment, not the show** — a single show carries both
audiences, so a `PLAYER_INVITED` attendee gets their inviting player prefilled and changeable, and a
`PUBLIC` attendee gets a searchable dropdown plus "The whole orchestra" (§13.4).

**Editing an approved note returns it to `PENDING`** (§13.4). Otherwise moderation reviews one text and
the wall publishes another.

Admin side (`admin.md` §14.2): the wall, grouped-by-player view (**admin-only, always**), approve/hide in
bulk, publish to the public wall, export a player's notes, and queue `player_notes_digest` emails.

**The two flags are independent and stay that way** — `moderation_status` is admin triage,
`wall_status` is whether it appears publicly. **A note addressed to a specific player is never
auto-published**; it is personal mail bound for that player's digest.

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
`J` must keep both keys total, not optional:

- add nullable `player_id`
- a `check` that **exactly one** of `registration_id` and `player_id` is non-null
- a second partial unique index on `(player_id, template_key)` over the same pending statuses

Every registration-addressed row then still has a non-null `registration_id` and the original index
bites exactly as before. **If `J` lands without that check constraint, the non-negotiable is gone and
nothing will tell you** — a row with both keys null conflicts with nothing, and `on conflict do nothing`
silently does nothing (`domain.md` §5.1). Write the test that proves a double-queued digest is refused.

---

## 4. Rules for parallel sessions

Everything in `modules.md` §4 still holds, unchanged: **the schema is frozen once `J` merges**, nobody
rebuilds `DataTable`, stay inside your route group, **no operational value reaches code**, every branch
ends with a `qa` pass, and every branch ends with a handoff under `docs/handoff/` per
`docs/handoff/README.md`.

Five things are specific to V2:

**Branch names use the `claude/` prefix, as V1's did** — `claude/J-schema-delta`, and so on. Not
`v2/J-…`: git cannot hold both a branch named `v2` and a branch under `v2/`, since a ref is either a
file or a directory. The integration branch owns that name.

**PRs target `v2`, never `main`.** CI (`on: pull_request`, unfiltered) runs on them already. Note that
`v2` is **not** branch-protected the way `main` is, so green CI does not by itself block a merge —
review accordingly, or ask for a ruleset (`local.md`).

**Rebase on `v2`, not on `main`.** `main` may take a 19 Sep hotfix while V2 is in flight. `v2` picks
those up by merging `main` in; individual branches should not each do it separately.

**V2 is not on a deadline, and that changes what "done" means.** V1 shipped under a dated gun and
`modules.md` §5.3 had a cut list. There is no equivalent here. A branch that is not right does not
merge — nothing downstream is waiting on a concert.

**A branch too big for one session is split then, not pre-empted now.** The cut is deliberately coarse
(§2.1) because splitting late costs nothing here. `M` and `N` each name their own clean seam —
verification and feedback respectively. Taking one is a normal call, not a departure from this file.

**Read `spec/decisions.md` §19.1 before proposing anything that contradicts a decision.** The obvious
simplification was usually considered and is worse. V2 inherits 45 settled decisions, of which
**35–42 were written for V2 itself** on 13 Sep, and **43 was settled by `L`** and answer most of what a branch would otherwise
re-litigate.

---

## 5. Sequence

| Wave | Branches | Notes |
|---|---|---|
| 0 | `J`, `K` | Parallel with each other. Open `J` first — its migration needs a manual Supabase apply before anything downstream can be tested against production |
| 1 | `L`, `M`, `N` | `L` and `M` fan out behind `K`; `N`'s portal half needs neither wave-0 branch and could start immediately |
| 2 | `O` | Behind `N`, for the section slot, and `J`, for the digest outbox key |

Six branches, against V1's eleven — for a smaller scope, deliberately (§2.1). **There is no critical
path**: V2's whole premise is that registration already works on Google Forms, so nothing here blocks a
concert.

`M` and `N` are the two long ones. Neither blocks anything except `O`, so running them concurrently in
two sessions is the natural shape; running them one after the other costs nothing but time.

The one ordering constraint worth respecting is `J` → manual apply → everything that writes
verification or digest rows. That is a human step in the middle of the graph (`local.md` §4), not a
merge.

---

## 6. What is deliberately not a module

**The V1 backlog is not V2 work.** Two items are outstanding on `main` and belong there, not here:
the shared `AlertDialogAction` fix (25 call sites across 7 files leave a modal standing over an inert
shell — `docs/handoff/archive/blast-queue-banner-outgoing.md`), and the stale `qa/e2e/f-blast.spec.ts`
FLOW-10 assertion. Both predate `v2` and both should land on `main` and flow in.

**The reserved-slug check in `L`'s form editor is a small fix, not a module.** `/f/verify` is a
static route, and Next resolves a static segment ahead of `/f/[slug]`, so a form created with the
slug `verify` is permanently unreachable — with no error at creation, no error at request, and
nothing in the editor to suggest why. Nothing enforces it today. The fix is a reserved-slug list in
the form editor, which owns slug validation; `verify` is the only entry the routes need right now,
and any future static segment under `/f/` has to be added with it. `M` asked for this and `O`
carried it forward unclaimed; it is recorded here so it stops travelling in handoffs.

**The `registrations_no_duplicate_import` index is not V2 either**, but `J` is the natural place to
carry it — it was written out and deliberately deferred only because a migration before 19 Sep meant a
manual deployment step (`docs/handoff/archive/import-reimport-dedup.md`). That reason expires with the
concert. The SQL is in that handoff.

**Out of scope entirely, per `spec/README.md` §4.3:** payments, pricing, refunds, seat selection or seat
maps, waitlist auto-promotion emails, SMS, native mobile apps, multi-organisation tenancy, i18n, public
marketing pages.
