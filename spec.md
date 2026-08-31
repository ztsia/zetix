# Orchestra Concert Ticketing — System Specification

Status: draft v5

**This document defines the system. It contains no concert-specific values.** Capacities, quotas,
player counts, dates and deadlines live in `context.md` as data an admin enters, never as constants in
code. Any number appearing in this document is either a structural limit or an illustrative example
explicitly labelled as such.

Companion documents:

| File | Holds | Authority |
|---|---|---|
| `spec.md` (this) | What the system does and how it behaves | The contract |
| `context.md` | This orchestra's concert: real numbers, dates, delivery plan, open questions | The data |
| `ref.md` | Patterns distilled from Hi.Events, chiefly the door-scanner IA | Background |

---

## 1. Context

Today registration runs on Google Forms. Each concert has several **shows**. Two audience models exist:

- **Player-invited** — every audience member is tied to a performing player. Players receive a base
  allocation of seats and may request extra seats with no per-player cap, granted first-come-first-served
  from a shared pool.
- **Public** — audience members register for themselves, with no player relationship.

A show has exactly one audience model. Mixed-mode shows are out of scope.

Seating is unreserved and admission is free. There is no pricing, no payment, and no seat selection
anywhere in this system.

### 1.1 What the current process cannot do

| Pain | Consequence |
|---|---|
| Responses live in a spreadsheet | No single source of truth, manual dedupe |
| No tickets | Door admission is a name-list search |
| No capacity enforcement | Overbooking discovered late |
| No player↔audience link in data | Cannot report or message per player |
| No post-registration comms | Booklet and notes handled ad hoc |

---

## 2. Design principles

These govern every decision below. They are requirements, not style preferences.

### 2.1 Nothing operational is hardcoded

No capacity, quota, deadline, cap, or limit may appear as a literal in application code. Every one of
them is a stored, admin-editable value. Specifically forbidden as constants in code paths: hall
capacities, segment capacities, base quotas, player counts, party-size caps, batch sizes, rate limits,
and daily send caps.

The concrete values for a given concert live in `context.md` and are entered through the admin UI. If a
number from `context.md` appears anywhere in a `.ts` file, it is a bug.

The reference list of every configurable value lives in §6. If a new tunable is introduced, it goes in
that table and the cascade below — it does not go in a `const`.

### 2.2 Three-level configuration cascade

```
system_settings  →  concert.defaults  →  show.<field>
   (global)          (per concert)        (per show, authoritative)
```

Every tunable is `NULL`-able at the concert and show level, resolving upward until a value is found.
The system level always has a value, so resolution can never fail. Reads go through one resolver:

```ts
resolveSetting(key, { showId, concertId })   // show → concert → system
```

Never read a raw column for a cascading value; always resolve. This is what makes "each show is
independently configured" true without forcing the admin to re-enter everything per show.

### 2.3 Each show is independently configurable

Capacity, base quota, deadlines, extras policy, form windows, party caps, and portal behaviour are all
per-show. A concert with three shows may have three different capacities and three different base
quotas. Nothing is shared across shows except the concert's branding, players, booklet, and templates.

### 2.4 Admin can always override

Every automated rule has a manual escape hatch, because real events do not follow the rules. Admin can
create, edit, and delete registrations and attendees directly; register a player after the deadline has
passed; grant extras out of order; exceed capacity with an explicit confirmation; and admit a guest at
the door whose ticket scans amber or red. Overrides are recorded, never silently blocked.

### 2.5 Data is retained

There is no purge job. Attendee names and emails are kept indefinitely for future reference. Deletions
are soft (`deleted_at`), and check-ins are append-only and reversible rather than destructive.

---

## 3. Build decision

### 3.1 Recommendation: build from scratch, use Hi.Events only as a reference

Reject: forking Hi.Events, and refactoring Hi.Events onto Supabase.

1. **Feature overlap is shallow and inverted.** Hi.Events supplies forms, QR check-in, email and
   attendee export — the easy 40%. Every distinctive requirement here (player allocation model,
   spreadsheet import with column mapping, ticket canvas editor, concert portal with player-addressed
   notes) is net-new work inside an unfamiliar 93k-LOC PHP codebase. It has no import feature at all —
   export only.
2. **The value it is engineered for is irrelevant here.** Stripe Connect, taxes, fees, invoices,
   refunds, promo codes, affiliates and multi-tenant SaaS mode are all load-bearing in its schema and
   order lifecycle, and all useless for a free concert.
3. **Hosting is decided by runtime shape.** Hi.Events needs an always-on container running
   nginx + php-fpm + a Node SSR server + a queue worker + a scheduler, plus Postgres *and* Redis. That
   fits no genuinely free tier. A Next.js app on serverless has no always-on component at all.
4. **Licence friction.** AGPL-3.0 with a Section 7(b) term requiring a "Powered by Hi.Events"
   attribution in the footer of every page **and every email**, linking to hi.events. That lands on the
   orchestra's concert pages and tickets. Removing it requires a commercial licence.
5. **Scale is trivial.** A few hundred seats per show, a handful of shows a year. None of its
   performance engineering earns its complexity.

Refactoring onto Supabase is the worst option: it means rewriting the entire Eloquent layer across 146
migrations while keeping the feature surface you do not want, and its frontend is Vite SSR on Express,
not Next.js, so it does not drop onto Vercel cleanly either.

### 3.2 What Hi.Events is actually worth, given a one-week build

Ranked by value to this project:

1. **The door-scanner information architecture — genuinely worth copying.** See §15.4. It is the one
   piece of its UI that has been through real venue use.
2. **Domain modelling decisions** — dual identifiers, append-only check-ins, scoped operator access.
   Already extracted into this document; the file map is in Appendix B.
3. **Its admin IA — mostly not worth copying.** It is structured around products, orders, promo codes,
   organizers and payments. Our admin is a different, much smaller shape. Copying its navigation would
   import complexity we do not have.
4. **Its `TicketDesigner` — nothing to borrow.** Five files, a settings form with a live preview, not a
   canvas editor. Our §10.3 is a different and more capable thing.

**Do not spend build-week hours browsing the repo.** §15 below gives the screen inventory directly,
which is faster than reverse-engineering it.

---

## 4. Scope

### 4.1 In scope (v1)

Concerts, shows, players, admin/operator accounts; two registration form types with response limiting;
the allocation engine; spreadsheet import with saved column-mapping profiles; ticket generation with a
template editor and seeded defaults; batched email via Gmail SMTP; an offline-tolerant door scanner; and
a QR-reachable concert portal with e-booklet and notes.

### 4.2 Out of scope (v1)

Payments, pricing, refunds, seat selection or seat maps, waitlist auto-promotion emails, SMS, native
mobile apps, multi-organisation tenancy, i18n, public marketing pages.

---

## 5. Domain model

```
concert
 ├── show                     (one concert has many shows, each independently configured)
 │    ├── registration_form   (one active form per show)
 │    ├── registration        (a booking party)
 │    │    └── attendee       (one row per seat / per ticket)
 │    └── check_in            (append-only scan log)
 ├── player                   (performer, scoped to concert)
 │    └── player_allocation   (player × show → quota + usage)
 ├── ticket_template          (canvas layout JSON + background asset)
 ├── booklet                  (e-booklet PDF)
 └── portal_note              (note from an attendee, optionally addressed to a player)
```

### 5.1 Tables

**`system_settings`** — single-row or key/value; the root of the cascade (§2.2)
`key`, `value` (jsonb), `updated_at`, `updated_by`

**`concerts`**
`id`, `name`, `slug`, `season`, `starts_on`, `ends_on`, `status` (DRAFT|ACTIVE|ARCHIVED),
`defaults` (jsonb — concert-level cascade overrides),
`portal_enabled`, `notes_enabled`, `notes_close_at`,
`public_wall_enabled` (bool), `public_wall_visibility` (ADMIN_ONLY|AUDIENCE),
`practical_info_md`, `created_at`, `updated_at`, `deleted_at`

**`shows`**
`id`, `concert_id`, `name`, `starts_at` (timestamptz), `doors_open_at`, `venue_name`, `venue_address`,
`soft_capacity`, `hard_capacity`, `held_seats`,
`portal_unlock_mode` (ON_ADMISSION | OPEN_TO_ALL | CLOSED),
`status` (DRAFT|OPEN|CLOSED|COMPLETED), `ticket_template_id`,
`created_at`, `updated_at`, `deleted_at`

The show owns the **physical hall**: total capacity and the door. It no longer carries an audience
mode — see segments below.

**`show_segments`** — a slice of one show's capacity with its own audience model
`id`, `show_id`, `name` (e.g. "Public", "Player invited"),
`audience_mode` (PLAYER_INVITED | PUBLIC),
`capacity` (this segment's slice of the hall),
`base_quota` (nullable; PLAYER_INVITED only),
`base_claim_deadline` (nullable),
`extras_policy` (REVIEW | AUTO_FCFS),
`allow_partial_grant`, `max_tickets_per_response` (nullable),
`display_order`, `created_at`, `updated_at`
Unique: `(show_id, audience_mode)` — at most one segment per mode per show

A show has one or more segments; a single-audience show simply has one. Constraint:
`Σ segment.capacity + held_seats <= hard_capacity`, validated on save with a clear error naming the
overflow. A second constraint on base entitlement is in §7.4.

Segments do **not** borrow from each other automatically. If the player segment finishes with 20
unclaimed seats and the public segment is full, an admin moves the numbers explicitly (player 80,
public 320) — recorded in `audit_log`. Automatic borrowing would make capacity unpredictable on the
night.

All capacity and quota columns are nullable and resolve up the cascade (§2.2). None has a literal
default in code.

**`players`**
`id`, `concert_id`, `full_name`, `email` (citext), `instrument`, `section`,
`invite_token` (unique, unguessable), `is_active`, `created_at`, `updated_at`, `deleted_at`
Unique: `(concert_id, lower(email))`

**`player_allocations`**
`id`, `player_id`, `segment_id`, `base_quota_override` (nullable → falls back to `segment.base_quota`),
`notes`, `created_at`, `updated_at`
Unique: `(player_id, segment_id)`

Quota is uniform across players in practice, so the admin UI edits it at show level. The per-player
override column exists because it costs one nullable column and removes a future migration.

**`registration_forms`**
`id`, `segment_id`, `round_label` (e.g. "Round 1"), `title`, `description_md`, `slug` (unique),
`schema` (jsonb — §8.2), `opens_at`, `closes_at`, `max_responses`,
`one_response_per_identity`, `max_tickets_per_response` (nullable),
`auto_close_on_capacity`, `allow_edit_until`, `confirmation_message_md`,
`status` (DRAFT|OPEN|CLOSED), `created_at`, `updated_at`

A form belongs to a segment, and the segment's `audience_mode` decides which form type renders. A
second registration round is a new form on the same segment with a new `round_label`.

**`form_responses`**
`id`, `form_id`, `raw` (jsonb — exact submitted payload, never mutated), `submitted_at`,
`ip_address`, `user_agent`, `edit_token` (unique, nullable)

**`registrations`** — a booking party
`id`, `show_id`, `segment_id`, `round_label` (nullable),
`player_id` (nullable), `form_response_id` (nullable), `import_batch_id` (nullable),
`source` (FORM|IMPORT|ADMIN),
`contact_name`, `contact_email` (citext), `contact_phone`,
`status` (CONFIRMED|PENDING_REVIEW|WAITLIST|CANCELLED),
`requested_at` (timestamptz — the FCFS ordering key),
`created_by`, `created_at`, `updated_at`, `deleted_at`
Index: `(segment_id, status, requested_at)`, `(show_id, status)`

**`attendees`** — one row per seat
`id`, `registration_id`, `show_id`, `segment_id`, `full_name`, `email` (citext, nullable),
`allocation_type` (BASE|EXTRA|HELD|COMP),
`ticket_code` (unique), `qr_token` (unique),
`status` (CONFIRMED|PENDING_REVIEW|WAITLIST|CANCELLED),
`ticket_issued_at`, `ticket_sent_at`,
`ticket_template_id`, `ticket_template_version` (pinned at issue time — see §10.5),
`created_at`, `updated_at`, `deleted_at`
Index: `(segment_id, status)`, `(show_id, status)`; unique on `qr_token`, unique on `ticket_code`

`ticket_sent_at` is the **dedup key for repeat blasts** (§11.4). It is set only on a confirmed
successful send.

**`check_ins`** — append-only
`id`, `attendee_id`, `show_id`, `operator_id` (nullable), `device_id`,
`scanned_at`, `synced_at`, `source` (ONLINE|OFFLINE_SYNC|MANUAL),
`override_reason` (nullable), `reverted_at`, `reverted_by`
Index: `(show_id, scanned_at)`, `(attendee_id)`

**`ticket_templates`**
`id`, `concert_id` (nullable — null = global default), `name`, `version`,
`background_asset_path`, `background_kind` (IMAGE|PDF|NONE),
`page_width_pt`, `page_height_pt`, `layout` (jsonb — §10.2),
`is_default`, `created_at`, `updated_at`

**`booklets`**
`id`, `concert_id`, `show_id` (nullable), `title`, `pdf_path`, `published`, `created_at`

**`portal_notes`**
`id`, `concert_id`, `show_id`, `attendee_id`, `to_player_id` (nullable),
`display_name`, `is_anonymous`, `body`,
`moderation_status` (PENDING|APPROVED|HIDDEN),
`wall_status` (NOT_PUBLISHED|PUBLISHED),
`moderated_by`, `moderated_at`, `created_at`, `updated_at`
Index: `(concert_id, moderation_status)`, `(to_player_id)`, `(concert_id, wall_status)`

**`import_batches`**
`id`, `show_id`, `filename`, `mapping_profile_id`, `uploaded_by`,
`row_count`, `created_count`, `skipped_count`, `error_count`,
`report` (jsonb), `status` (DRY_RUN|COMMITTED|ROLLED_BACK), `created_at`

**`mapping_profiles`**
`id`, `name`, `show_id` (nullable), `audience`, `config` (jsonb — §9.3), `created_at`, `updated_at`

**`email_outbox`**
`id`, `to_email`, `to_name`, `subject`, `template_key`, `context` (jsonb),
`attendee_id` (nullable), `registration_id` (nullable), `attachment_path` (nullable),
`status` (QUEUED|SENDING|SENT|FAILED|CANCELLED),
`attempts`, `last_error`, `scheduled_for`, `sent_at`, `created_at`
Index: `(status, scheduled_for)`

```sql
create unique index outbox_no_duplicate_pending
  on email_outbox (attendee_id, template_key)
  where status in ('QUEUED', 'SENDING');
```

This index is what makes a repeat blast safe (§11.4). Do not omit it.

**`app_users`** — backed by Supabase Auth
`id` (= `auth.users.id`), `email`, `display_name`, `role` (ADMIN | OPERATOR),
`is_active`, `last_login_at`, `created_at`, `deleted_at`

Two very different populations share this table:

- **Exactly one `ADMIN` row.** A single shared account used by the whole committee, unlocked by one
  secret code. No invitations, no admin user management.
- **Many `OPERATOR` rows**, provisioned from the admin UI, one per usher.

**`operator_show_assignments`**
`id`, `user_id`, `show_id`, `assigned_by`, `created_at`
Unique: `(user_id, show_id)`

An operator may work one show or several. `ADMIN` ignores this table entirely and sees every show.
An operator with **no** assignments can log in and sees an empty show list — they cannot reach any
attendee data. This is the correct behaviour for an account created but not yet rostered.

**First-run bootstrap.** With no sign-up flow, the single `ADMIN` cannot be created through the UI. Ship
a `scripts/bootstrap-admin.ts` that creates its Supabase Auth user and `app_users` row from environment
variables, idempotently, and document it as a one-time step. Operators are created from inside the app
thereafter.

**`audit_log`****`audit_log`**
`id`, `actor_id`, `action`, `entity_type`, `entity_id`, `before` (jsonb), `after` (jsonb),
`reason` (nullable), `created_at`

Every admin override (§2.4) writes here.

---

## 6. Configuration reference

The complete set of tunables. Each resolves segment → show → concert → system (§2.2). Suggested seed values are
starting points written to `system_settings` at install — they are **not** defaults in code.

**Operational values — no code defaults.** These are entered per concert through the admin UI. The
system ships with no numeric default for any of them; a missing value is a validation error at save
time, not a silent fallback.

| Key | Level | Meaning |
|---|---|---|
| `capacity.soft` | show | Advisory threshold on the hall; crossing it warns, never blocks |
| `capacity.hard` | show | Enforced hall ceiling; only an explicit admin override exceeds it |
| `capacity.held_seats` | show | Withheld from all segments (staff, press, guests of honour) |
| `segment.capacity` | segment | This segment's slice of the hall |
| `allocation.base_quota` | segment | Seats each active player is entitled to (PLAYER_INVITED only) |
| `allocation.base_claim_deadline` | segment | After this, unclaimed base releases into that segment's extras pool |
| `allocation.extras_policy` | segment | `REVIEW` (batch grant) or `AUTO_FCFS` (instant) |
| `allocation.allow_partial_grant` | segment | A boundary request may be granted in part |
| `allocation.allow_base_oversubscription` | segment | Permits base entitlement to exceed segment capacity (§7.4) |
| `form.max_tickets_per_response` | segment | Party size cap |
| `form.extra_rows_max` | segment | Rows in the "request extras" repeater |
| `portal.unlock_mode` | show | `ON_ADMISSION`, `OPEN_TO_ALL`, `CLOSED` |
| `portal.notes_enabled` | concert | |
| `portal.notes_close_at` | concert | |
| `portal.public_wall_enabled` | concert | |
| `portal.public_wall_visibility` | concert | `ADMIN_ONLY` or `AUDIENCE` |
| `concert.timezone` | concert | IANA zone; all show times are stored UTC and rendered in it (§6.1) |

**System values — seeded, rarely changed.** These describe the runtime, not the event, so they do carry
install-time seeds.

| Key | Level | Seed | Meaning |
|---|---|---|---|
| `portal.note_max_length` | system | 1000 | |
| `form.rate_limit_per_ip_per_min` | system | 5 | |
| `email.transport` | system | `gmail_smtp` | Active transport; alternatives are adapters, not rewrites |
| `email.max_per_dispatch` | system | 25 | Sized to stay inside the function timeout |
| `email.max_per_day` | system | 450 | Gmail free-account quota guard (§11.1) |
| `email.inter_message_delay_ms` | system | 400 | |
| `email.max_attempts` | system | 3 | |
| `email.merge_attachments_above` | system | 8 | Merge into one PDF past this many tickets |
| `email.max_attachment_mb` | system | 20 | Gmail's ceiling is 25MB; leave headroom |
| `ticket.default_template_id` | concert | seeded | |
| `checkin.manifest_ttl_hours` | system | 12 | Offline manifest lifetime after show start |
| `checkin.scan_debounce_ms` | system | 1500 | |
| `import.fuzzy_match_threshold` | system | 0.85 | Below this, a player match needs confirmation |
| `keepalive.enabled` | system | true | Daily DB ping that defeats the Supabase idle pause (§17.1) |

### 6.1 Time

All timestamps are stored as `timestamptz` in UTC. Every user-facing time renders in
`concert.timezone`. Never render a show time in the viewer's local zone — an audience member travelling
must see the time at the venue, not at home. Never store a naive timestamp.

---

## 7. Capacity and allocation engine

The only genuinely non-trivial logic in the system. Specify precisely, test hard.

### 7.1 Segments own the allocation; shows own the hall

A show is a physical event with one door and one total capacity. Within it, **segments** carve that
capacity into blocks with different audience models. A show may have a single segment, or several — for
example a public block and a player-invited block sharing one hall on one night.

Every formula below is evaluated **per segment**, never per show. The show-level check is only that
segments plus held seats fit inside the hall.

Concrete segment configurations for the current concert are in `context.md`.

### 7.2 Definitions per segment

```
sellable        = segment.capacity
confirmed       = count(attendees WHERE segment_id = G AND status = 'CONFIRMED')
base_claimed(p) = count(attendees for player p in G, allocation_type='BASE', status='CONFIRMED')
unclaimed_base  = Σ over active players of max(0, base_quota(p,G) - base_claimed(p,G))
open_seats      = sellable - confirmed

extras_pool = open_seats - unclaimed_base     -- before base_claim_deadline
extras_pool = open_seats                      -- after base_claim_deadline
```

For a `PUBLIC` segment there are no players, so `unclaimed_base = 0` and `extras_pool = open_seats`.

`capacity.soft` and `capacity.hard` remain **show-level** — they describe how many bodies fit in the
room. Crossing soft warns; hard blocks except under explicit admin override (§7.6).

### 7.3 Worked example

**Illustrative numbers, not any real concert's** — see `context.md` for those. A player segment of 120
seats with 30 active players at a base quota of 3:

| Moment | confirmed | unclaimed_base | open_seats | extras_pool |
|---|---|---|---|---|
| Registration opens | 0 | 90 | 120 | **30** |
| 50 base seats claimed | 50 | 40 | 70 | **30** |
| Deadline passes, 72 base claimed | 72 | 18 (released) | 48 | **48** |

The pool starts at capacity minus what players are collectively entitled to, and grows by exactly the
unclaimed remainder when the deadline passes. Before the deadline, extras can never consume a seat a
player is still entitled to.

Where base quota × players exactly equals segment capacity, the pool is zero until the deadline. That
is correct, not a bug: extras are precisely the seats players did not take.

These three rows are the primary test case for `claim_seats()`. Write them as unit tests first.

### 7.4 Grant rules

**BASE seats** are granted immediately whenever `base_claimed(p) < base_quota(p)` and `open_seats > 0`
in that segment. A player is never refused their base allocation before the deadline.

**Base entitlement may not exceed segment capacity.** The system blocks any save where

```
base_quota × count(active players in segment) > segment.capacity
```

The check runs on **all three** mutations that can breach it — editing segment capacity down, editing
base quota up, and adding or reactivating a player — not just on the segment form. Blocking only one of
them leaves the other two as silent routes to an oversubscribed segment.

The error names the numbers and the shortfall: *"82 active players × 2 base = 164 seats, but the
segment holds 100. Reduce the quota to 1, raise capacity to 164, or deactivate 32 players."*

An explicit `allocation.allow_base_oversubscription` toggle overrides it, behind a typed confirmation,
for organisers who knowingly overbook on the expectation that some players never claim. Once enabled,
the segment carries a permanent warning banner showing the projected shortfall. It defaults off,
because the default promise — every player gets their allocation — must be one the system can keep.

**EXTRA seats** follow the segment's `extras_policy`:

- **`REVIEW` (default for player segments).** Requests are created as `PENDING_REVIEW` with
  `requested_at` set, consuming no seats. After the deadline the admin grants in batch (§7.5).
- **`AUTO_FCFS` (default for public segments).** Granted at submission if the pool has room,
  atomically. With `allow_partial_grant`, the remainder becomes `WAITLIST`.

**Ordering key** is `registrations.requested_at` — the form submission time, or for imports the Google
Form response timestamp. Never `created_at`: an import run a week later must preserve original
submission order, and with two registration rounds this matters more, not less.

### 7.5 Extras review screen

Scoped to one segment.

- Header shows the live pool: `extras_pool` seats, N requests for M seats.
- Table sorted by `requested_at ASC`: position, requested time, round, player, contact, seats
  requested, guest names, running cumulative total, granted count.
- **Preselection is a strict FCFS greedy walk by cumulative seat count** — walk in time order,
  selecting until the next request would exceed the pool. The boundary request is granted in part when
  `allow_partial_grant` is on, otherwise skipped whole. Strict order, never best-fit: first come first
  served means the clock decides, not the packing.
- Admin toggles rows and edits granted counts freely; the header recomputes live and blocks commit
  above the pool unless overridden.
- Commit runs in one transaction, moves granted rows to `CONFIRMED`, leaves the rest `WAITLIST`, and
  **queues** the resulting emails without sending (§11.2).

### 7.6 Manual and late registrations

Players registering after the form closes are expected, not exceptional. Admin can create a
registration against any segment bypassing form windows; edit contact details, player link and guest
list; add, rename or remove attendees; move a registration between segments or shows; cancel and
restore; and exceed `hard_capacity` with a typed confirmation recorded in `audit_log`.

Manual actions still route through `claim_seats()` so counters stay consistent. Only the hall ceiling
is overridable, and only deliberately.

### 7.7 Moving capacity between segments

Segments do not borrow automatically. When the player segment closes with unclaimed seats and public
demand remains, an admin edits both capacities (player 80, public 320). The edit is validated against
the hall total, refuses to drop a segment below its confirmed count, and is logged.

Automatic borrowing is deliberately excluded: it makes the number of people arriving at the door
unpredictable, which is the one number the front of house needs to trust.

### 7.8 Concurrency

Oversell must be impossible. All grants run inside one Postgres function that locks the **show** — not
the segment — so that concurrent claims across two segments cannot jointly exceed the hall:

```sql
create function claim_seats(p_segment_id bigint, p_registration_id bigint, p_requests jsonb)
returns jsonb language plpgsql as $$
begin
  perform 1 from shows s
    join show_segments g on g.show_id = s.id
   where g.id = p_segment_id
     for update of s;                      -- serialise per hall
  -- recompute confirmed / unclaimed_base / extras_pool for this segment
  -- verify the show-level hall ceiling across all segments
  -- insert attendees as CONFIRMED / PENDING_REVIEW / WAITLIST
  -- return {granted_base, granted_extra, pending, waitlisted}
end; $$;
```

Contention is irrelevant at this scale; correctness is not.

### 7.9 Cancellation

Cancelling sets `status = CANCELLED` and returns seats to that segment immediately. Admin sees "N seats
freed, M waiting". Auto-promotion is out of scope — promotion is deliberate, because it sends email.

## 8. Registration forms

### 8.1 Two form types, distinct audiences

| | Player form | Public form |
|---|---|---|
| Attached to | a `PLAYER_INVITED` segment | a `PUBLIC` segment |
| Filled by | The player | The audience member |
| Access | Per-player tokenised URL, no login | Open public URL |
| Identity | Resolved from token → known player | Self-declared email |
| Ticket email to | The player, who forwards PDFs to guests | The registrant |
| Sections | Base guests (fixed N) + extra guests | Party members |

**Player access.** Each player holds `players.invite_token`; the URL is `/f/{form_slug}?k={token}`. No
password, no account. The token identifies the player, prefills their details, and shows their remaining
base allocation. Tokens are rotatable from admin.

**Guest emails are optional** on the player form. A guest without an email never receives their own
ticket; their PDF is attached to the player's confirmation email for the player to forward. This is
accepted and is the reason the player, not the guest, fills the form.

**Players consume no seats.** A player is a performer, not audience, and holds no attendee row in the
player segment of their own show. (A player attending a *different* show of the same concert registers through that
show's form, or is added by admin.)

**Public form** uses double opt-in: the registration is created `CONFIRMED` immediately, because seats
are scarce, but the ticket email is released only after the registrant clicks a verification link. This
catches typo'd addresses. Unverified registrations older than 48h are flagged for admin review.

**Imported registrations skip verification entirely** (`source = IMPORT`). They were captured by an
external form that we cannot re-verify, and holding their tickets behind a link they never received
would strand them. Import validates email syntax and flags malformed addresses instead (§9.4).

### 8.2 Form schema

Forms are JSON, rendered by one generic component — a light builder, not a Google Forms clone.

```jsonc
{
  "sections": [
    { "id": "registrant", "type": "REGISTRANT", "title": "Your details",
      "fields": [
        { "key": "contact_name",  "label": "Full name", "type": "text",  "required": true },
        { "key": "contact_email", "label": "Email",     "type": "email", "required": true },
        { "key": "contact_phone", "label": "Phone",     "type": "tel",   "required": false }
      ] },
    { "id": "base_guests", "type": "GUESTS_BASE", "title": "Your allocated tickets",
      "description_md": "You have **{{base_quota}}** tickets allocated.",
      "guest_fields": [
        { "key": "full_name", "label": "Guest name", "type": "text", "required": true },
        { "key": "email", "label": "Guest email (optional)", "type": "email", "required": false }
      ] },
    { "id": "extra_guests", "type": "GUESTS_EXTRA", "title": "Request extra tickets",
      "description_md": "Extra tickets are reviewed after {{base_claim_deadline}} and granted in order of request.",
      "guest_fields": [
        { "key": "full_name", "label": "Guest name", "type": "text", "required": true }
      ] },
    { "id": "extras", "type": "CUSTOM", "title": "Anything else",
      "fields": [
        { "key": "accessibility", "label": "Accessibility needs", "type": "textarea", "required": false }
      ] }
  ]
}
```

Section types: `REGISTRANT` (flat fields about the submitter), `GUESTS_BASE` (renders exactly
`base_quota` rows, player forms only), `GUESTS_EXTRA` (dynamic repeater capped by `form.extra_rows_max`),
`CUSTOM` (arbitrary flat fields stored in `form_responses.raw`).

Field types: `text`, `textarea`, `email`, `tel`, `number`, `select`, `multiselect`, `checkbox`, `radio`,
`date`. `{{base_quota}}` and other resolved settings interpolate into `description_md`, so copy never
hardcodes numbers either.

### 8.3 Response limiting

Enforced server-side on submit and reflected in the form UI: `opens_at`/`closes_at`; `max_responses`;
`one_response_per_identity` (per player token, or per email — a repeat visit loads the existing response
for editing while `allow_edit_until` holds); `max_tickets_per_response`; `auto_close_on_capacity`; a
live remaining-seats indicator (cached ~10s, never exact below 20 to avoid a stampede); and IP rate
limiting.

### 8.4 Confirmation

The registrant sees seats granted (base and extra broken out), anything pending review or waitlisted,
show details, and when tickets will arrive. `email_outbox` rows are created but **not** sent — see §11.

---

## 9. Spreadsheet import

Needed for historical data and for any concert still collected on Google Forms.

### 9.1 Flow

Upload `.xlsx`/`.csv` → select sheet and header row → map columns (auto-suggested, §9.2) → validate
(dry run, no writes) → review per-row report → commit (one transaction, produces an `import_batch`) →
rollback available while no tickets have been emailed.

SheetJS parses in the browser for preview and again server-side for the commit, so the client cannot
forge rows.

### 9.2 Repeating-group mapping

The hard part: a Google Form with "fill in your 4 allocated names, then optionally add extras" produces
a **wide** sheet.

```
Timestamp | Email | Your name | Guest 1 Name | Guest 1 Email | Guest 2 Name | … | Extra 1 Name | Extra 2 Name
```

One row becomes one `registration` plus N `attendees`. A plain column-to-field mapper cannot express
that, so the model has an explicit **guest group** concept that unpivots wide→long.

Auto-detection proposes groups from header patterns —
`/^(?<label>.*?)\s*(?<n>\d+)\s*(?<field>name|email|full name)$/i`, grouped by `label`, ordered by `n`.
The admin confirms or edits every proposal; auto-detection suggests, never applies silently.

### 9.3 Mapping profile config

```jsonc
{
  "header_row": 1,
  "identity": {
    "player_match": { "column": "Email Address", "strategy": "EMAIL" },
    "contact_name": "Your name",
    "contact_email": "Email Address",
    "requested_at": "Timestamp"
  },
  "guest_groups": [
    { "label": "Allocated", "allocation_type": "BASE", "rows": [
        { "full_name": "Guest 1 Name", "email": "Guest 1 Email" },
        { "full_name": "Guest 2 Name", "email": "Guest 2 Email" },
        { "full_name": "Guest 3 Name", "email": "Guest 3 Email" },
        { "full_name": "Guest 4 Name", "email": "Guest 4 Email" } ] },
    { "label": "Extra", "allocation_type": "EXTRA", "rows": [
        { "full_name": "Extra Ticket 1 Name" },
        { "full_name": "Extra Ticket 2 Name" } ] }
  ],
  "include_registrant_as_attendee": false,
  "extra_fields": { "accessibility": "Accessibility needs" },
  "transforms": {
    "trim_whitespace": true, "lowercase_emails": true,
    "titlecase_names": false, "skip_blank_guest_rows": true
  }
}
```

`player_match.strategy`: `EMAIL` (exact, case-insensitive), `NAME` (normalised exact), or `NAME_FUZZY`
(trigram similarity; anything below `import.fuzzy_match_threshold` requires explicit confirmation).
Unmatched players are listed and can be created inline or skipped.

Profiles are saved and reusable, since each concert's form differs slightly.

### 9.4 Validation

| Check | Level |
|---|---|
| Malformed email | Warning — import and flag |
| Duplicate email within the file | Warning |
| Registration already exists for this player + show | Blocking — skip row |
| Player not matched | Blocking until resolved |
| All guest cells blank | Skip row silently |
| Guest count exceeds base quota | Info — surplus becomes `EXTRA` |
| Import would exceed `hard_capacity` | Blocking — report overflow, admin chooses to cap in row order or raise capacity |

Imports run through `claim_seats()` in `requested_at` order, so capacity rules cannot be bypassed by
importing. Under `REVIEW` policy, imported extras land as `PENDING_REVIEW` alongside form requests and
compete fairly on timestamp.

---

## 10. Tickets

### 10.1 Identifiers

- **`ticket_code`** — human-readable, e.g. `ORC-7K4Q`. Crockford base32 (no `I`, `L`, `O`, `U`),
  collision-checked. Printed on the ticket, used for door lookup and phone support.
- **`qr_token`** — 128 bits of CSPRNG entropy, base62 (~22 chars), unique-indexed, unguessable. The
  only thing inside the QR.

**The QR encodes a URL**, not a bare token: `https://{APP_URL}/t/{qr_token}`. This is what makes it
multi-purpose (§13) — an audience phone camera lands in the portal; the operator scanner extracts the
token and calls the check-in API.

### 10.2 Template layout format

A background asset plus absolutely-positioned elements, stored in `ticket_templates.layout`:

```jsonc
{
  "canvas": { "width_pt": 595, "height_pt": 280, "dpi": 300 },
  "elements": [
    { "id": "el_name", "type": "TEXT", "binding": "attendee.full_name",
      "x": 48, "y": 120, "w": 320, "h": 34, "rotation": 0,
      "font_family": "Inter", "font_size": 22, "font_weight": 600,
      "color": "#1a1a1a", "align": "left", "valign": "middle",
      "max_lines": 1, "overflow": "SHRINK" },
    { "id": "el_qr", "type": "QR", "binding": "attendee.qr_url",
      "x": 430, "y": 60, "w": 130, "h": 130, "ec_level": "M", "margin_modules": 2 },
    { "id": "el_code", "type": "TEXT", "binding": "attendee.ticket_code",
      "x": 430, "y": 196, "w": 130, "h": 18,
      "font_family": "JetBrains Mono", "font_size": 12, "align": "center" },
    { "id": "el_static", "type": "TEXT", "binding": null,
      "text": "Free seating · Doors {{show.doors_open_at}}",
      "x": 48, "y": 200, "w": 320, "h": 18, "font_size": 11, "color": "#666666" }
  ]
}
```

Element types: `TEXT`, `QR`, `IMAGE`, `RECT`. Bindings are picked from a list, never free-typed:

```
attendee.full_name   attendee.ticket_code   attendee.qr_url
registration.contact_name   player.full_name   player.instrument
show.name   show.starts_at   show.doors_open_at   show.venue_name   show.venue_address
concert.name
```

Dates render through a per-element `format` string (e.g. `EEE d MMM yyyy, HH:mm`).

### 10.3 Template editor

Admin-only canvas editor:

- Upload background: PNG/JPG, or PDF page 1. Canvas dimensions derive from the asset; for PDF the page
  box in points is authoritative.
- Drag, resize, rotate; snap-to-grid and alignment guides; arrow-key nudge (1pt, 10pt with shift);
  z-order, lock, duplicate, multi-select.
- Properties panel: binding picker, typography, colour, alignment, overflow behaviour.
- Live preview against a real attendee, plus a **"longest name in this show"** preview so overflow is
  caught before a whole show's tickets go out.
- Undo/redo. Templates are **versioned** — never mutate a template that has already issued tickets;
  clone it.
- **Three seeded default layouts** (Classic Landscape, Minimal Portrait, Wide Banner) that work with no
  background asset, so the system is usable before anyone opens the editor.

Library: **react-konva**, dynamically imported with `ssr: false`.

### 10.4 Rendering

Server-side, deterministic, consuming the same layout JSON as the editor:

| Background | Renderer | Output |
|---|---|---|
| PDF | `pdf-lib` — load the original, draw text and QR onto page 1 | PDF, vector design preserved |
| Image / none | `sharp` composite or `satori` + `resvg-js`, embedded via `pdf-lib` | PDF |

Always attach a **PDF**: it prints predictably and every phone opens it. QR at ≥25mm printed, error
correction M.

Render on demand rather than storing, to stay inside free storage limits; cache to Storage keyed by
`attendee_id + template_version` only when a ticket is fetched repeatedly.

**Fonts must be self-hosted and embedded** — serverless runtimes have almost no system fonts, and the
render must match the editor.

**QR contrast is a rendering constraint, not a design preference.** Artwork with a busy or dark region
behind the QR will not scan. The renderer always draws an opaque light backing plate under the QR with
a quiet zone of at least `margin_modules`, regardless of what the template background looks like. The
editor shows this plate so the layout is honest about the space it takes.

### 10.5 Template versions are pinned at issue time

Rendering on demand creates a trap: if an admin edits a template after tickets have been emailed, every
already-issued ticket would re-render differently on its next download. The PDF in someone's inbox and
the PDF behind their portal link would disagree, and the door would be scanning against a design nobody
sent.

So: **`attendees.ticket_template_id` and `ticket_template_version` are written when the ticket is first
issued, and rendering always uses the pinned version.** Editing a template creates a new version and
affects only tickets issued afterwards.

Re-rendering an already-issued ticket against a newer template is possible but explicit — an admin
action, "Reissue tickets with current template", which repins the version, clears `ticket_sent_at` for
the affected attendees, and queues a resend so the recipient actually receives what changed. It refuses
to run silently.

---

## 11. Email

### 11.1 Transport

**Gmail SMTP over `nodemailer`, sent from a Vercel Node.js function.** This works — the widely-repeated
"serverless blocks SMTP" claim is about **port 25 only**. Ports 465 and 587 are not blocked; Vercel
functions run on AWS Lambda, which has unrestricted outbound on both.

```
host: smtp.gmail.com   port: 465   secure: true
auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD }   // app password requires 2FA
```

Three things must be right or it fails in ways that look like a platform problem:

1. **`export const runtime = 'nodejs'`** on the dispatch route. The Edge runtime has no TCP sockets.
2. **`export const maxDuration = 60`** — Vercel Hobby's ceiling, against a 10s default. Each send costs
   roughly 1–2s including the SMTP handshake, so a batch of ~20–25 fits comfortably. This is what
   `email.max_per_dispatch` is sized against.
3. **Assume no connection reuse** between invocations. Open, send the batch, close.

**Volume scales with registrations, not seats.** Email goes to *registrants*: one message per player
carrying several ticket PDFs, one per public party. A show typically generates emails numbering in the
low hundreds at most, well inside a free Gmail account's 500/day even across two registration rounds.
Expected figures for the current concert are in `context.md`.

The outbox enforces `email.max_per_day` regardless, so exceeding a provider cap defers the remainder to
the next day rather than failing.

Transport sits behind one `MailTransport` interface so an alternative is an adapter file, not a
rewrite. Documented alternatives, in case Gmail becomes a constraint:

| Alternative | When |
|---|---|
| Brevo HTTP API (300/day) | If SMTP proves flaky in the full-volume dry run, or deliverability suffers |
| Resend HTTP API (3000/mo, 100/day) | Secondary failover; the daily cap is the binding limit |
| Supabase Edge Function + `denomailer` | Works (Deno runtime allows TCP), but splits the dispatcher across two platforms for no gain |
| GitHub Actions + `nodemailer` | Moves dispatch off Vercel entirely; only worth it if function limits become the bottleneck |

Verify the sender address before the first real send. Deliverability problems present as silent
spam-foldering, not as errors, so send test messages to Gmail, Outlook and one university/corporate
address and confirm all three land in the inbox.

### 11.2 Outbox pattern — no always-on worker

1. Anything that should send email writes `email_outbox` rows as `QUEUED`.
2. Admin opens **Email → Outbox**, reviews the batch (recipients, template, preview), clicks **Send**.
3. The UI calls `POST /api/outbox/dispatch` repeatedly. Each call claims up to `email.max_per_dispatch`
   rows (`FOR UPDATE SKIP LOCKED`), sends with `email.inter_message_delay_ms` between messages, commits
   per message, and returns progress. The UI shows a progress bar until the queue drains or the daily
   cap is hit.
4. A daily cron hits the same endpoint as a safety net.

This is the one-click blast model: no persistent process, and it survives function timeouts because
progress is committed per message. Failures back off, retry to `email.max_attempts`, then surface in
admin with `last_error`.

### 11.3 Templates

| Key | Trigger | To |
|---|---|---|
| `player_confirmation` | Player form submitted | Player — summary + all guest tickets attached |
| `public_verify` | Public registration created | Registrant — verification link only |
| `public_ticket` | Public registration verified | Registrant — party's tickets attached |
| `extras_granted` | Extras review committed | Registrant — with tickets |
| `extras_declined` | Extras review committed | Registrant |
| `registration_cancelled` | Admin cancels | Registrant |
| `reminder` | Admin-triggered, pre-show | All confirmed |
| `player_notes_digest` | Admin-triggered, post-show | Player — notes addressed to them |

Markdown + `{{ }}` placeholders stored in the DB, editable with live preview and a documented token
list. Plain-text alternative auto-generated. Tickets attach as one PDF per attendee, named
`{show}-{name}-{ticket_code}.pdf`; past `email.merge_attachments_above`, merge into one PDF to stay
under `email.max_attachment_mb` (Gmail's hard ceiling is 25MB).

Every ticket email also carries the portal link as secondary text — but the **PDF is the ticket** (§13.1).

### 11.4 Repeat blasts must never double-send

Registration arrives in rounds. Round 1 closes, tickets go out; leftover seats reopen registration;
round 2 closes, and a second blast must reach **only the new people**. Someone who already has their
ticket must not receive it twice, and nobody must be silently skipped.

Three mechanisms, all required:

1. **`attendees.ticket_sent_at` is the dedup key.** Set only on a confirmed successful send, never on
   queueing. Any attendee with a non-null value is excluded from future blasts.
2. **Queueing is a filtered insert**, not a loop in application code:
   ```sql
   insert into email_outbox (attendee_id, template_key, ...)
   select a.id, 'public_ticket', ...
     from attendees a
    where a.segment_id = $1
      and a.status = 'CONFIRMED'
      and a.ticket_sent_at is null
   on conflict do nothing;
   ```
3. **The partial unique index** on `(attendee_id, template_key) where status in ('QUEUED','SENDING')`
   (§5.1) makes the `on conflict do nothing` meaningful. Without it, clicking Send twice queues
   everything twice.

Together these make the blast **idempotent**: pressing it repeatedly is harmless. This matters because
an admin who is unsure whether the first click registered will click again.

**The blast screen must show the split before committing:**

```
Player invited · Round 2
   84 confirmed attendees
   62 already sent          (excluded)
   22 pending               ← this blast
    0 failed, retryable
```

Nothing is queued until the admin confirms against those numbers.

**Explicit resend** is a separate action — select specific attendees, "Resend ticket", which clears
`ticket_sent_at` for exactly those rows and queues them. Used when someone deletes their email. It is
never the default path, and never operates on a whole segment at once without a typed confirmation.

**Round attribution.** `registrations.round_label` is copied from the form that captured the
registration, so the blast screen, exports and reports can group by round without inferring it from
timestamps.

---

## 12. Door check-in

### 12.1 Scanner

A mobile web app at `/scan` for `OPERATOR` and `ADMIN`.

**Signing in.** Operators enter a **display name and an access code**, both issued by the admin. Behind
the form this is Supabase Auth against a synthetic address (`<slug>@operators.local`) with the code as
the password, so session handling, hashing, refresh and rate limiting all come from the platform rather
than hand-rolled cookies. The session persists on the device, so an usher signs in once during setup
rather than at the door.

- **The show picker lists only the operator's assigned shows.** With exactly one assignment — the
  common case — it is auto-selected and the pill (`ref.md` §1.3) renders read-only, removing the
  single most damaging setup mistake: an usher admitting against the wrong show.
- Camera scan via `@zxing/browser`. HTTPS required.
- Continuous scanning with `checkin.scan_debounce_ms` per token to stop double-fires.
- Manual fallback: type or search `ticket_code`, or search by attendee name.

**Result states**, readable at arm's length in a dim foyer:

| State | Colour | Shows |
|---|---|---|
| Admitted | Green | Name, allocation type, inviting player |
| Already checked in | Amber | Name, first scan time, operator |
| Wrong show | Red | The show the ticket is actually for |
| Cancelled | Red | Name, "refer to desk" |
| Not found | Red | "Invalid ticket" |

Amber and red are **never hard blocks**. The operator can **Admit anyway**, recorded with
`source = MANUAL` and an `override_reason`. Turning away a real guest at a free concert is worse than a
duplicate row.

### 12.2 Scan feedback: colour, sound, haptics

Three channels, because no single one is reliable in a foyer.

**Colour** — a full-screen flash, held ~800ms. The only universally available channel; it must carry
the meaning on its own.

**Sound** — synthesised with the Web Audio API (oscillator nodes, no audio files to load):

| State | Tone |
|---|---|
| Admitted | Two ascending notes, 880 Hz → 1320 Hz, 80ms each |
| Already checked in | One note, 440 Hz, 200ms |
| Error (invalid / wrong show / cancelled) | Two descending notes, 300 Hz → 200 Hz, 150ms each |

**Gotcha:** browser autoplay policy blocks audio until a user gesture. The scanner must open with an
explicit **"Start scanning"** button whose handler creates and resumes the `AudioContext`. Without
this, the first several scans are silent on iOS.

**Haptics** — `navigator.vibrate()`: `[60]` admitted, `[40, 60, 40]` amber, `[200]` error.

**Gotcha:** **iOS Safari does not support the Vibration API at all.** On iPhone there is no vibration,
so colour and sound must be sufficient alone. Do not design a signal that depends on haptics.

A mute toggle is persisted per device. Foyers are loud — sound is a supplement to colour, not a
replacement.

### 12.3 Offline tolerance

Venue wifi is unreliable and a full house arrives inside twenty minutes. Scanning must not depend on
the network.

- On show selection, download a **manifest**: `[{ qr_token_sha256, ticket_code, name, player_name,
  status }]` for every attendee — a few hundred rows, well under 200KB — into IndexedDB.

  **The manifest is the attendee roster, so its endpoint is the security boundary that matters.**
  `GET /api/checkin/manifest?showId=` must verify an `operator_show_assignments` row for the caller
  before returning a single byte, and reject with 403 otherwise. An operator who can request any
  `showId` can download the full name list of every show, which defeats the point of scoping. Enforce
  it in the handler *and* as a Supabase RLS policy — the handler is the contract, RLS is what survives
  a mistake in the handler.
- Scans validate locally and enqueue.
- Online, each scan also POSTs immediately. Offline, the queue drains on reconnect, preserving the
  original `scanned_at` with `source = OFFLINE_SYNC`. The check-in endpoint re-verifies assignment on
  every write, including on delayed offline sync — an assignment revoked mid-event takes effect on the
  next sync rather than being trusted from the client.
- Duplicates across two offline devices resolve only on sync. The server accepts both and flags the
  attendee as multi-scanned. Do not attempt distributed locking.
- Manifest expires at show start + `checkin.manifest_ttl_hours`.

### 12.4 Admin check-in dashboard

Live: confirmed, checked in, remaining, arrival rate over time, per-operator counts, and a searchable
scan log with revert (sets `reverted_at`, never deletes).

---

## 13. Concert portal

### 13.1 The ticket is the PDF; the portal is a bonus

The emailed PDF is the ticket of record. The portal is a separate, additive surface reached from the
QR. If the portal is down, admission is unaffected — the operator scanner works from its offline
manifest and the audience holds a PDF. This decoupling is deliberate; do not move the ticket into the
portal.

The portal link appears in the email as secondary text, never as a replacement for the attachment.

### 13.2 Progressive disclosure, not a dead link

The portal URL is live from the moment the ticket is issued, but its **content** depends on state.
A ticket holder who scans their own QR out of curiosity three days early must get something friendly,
not a 404.

| State | Shown |
|---|---|
| **Issued, not yet admitted** | Ticket status: name, show, date, doors, venue with map link, "Present this QR at the door", countdown. No booklet, no notes. |
| **Admitted** (a `check_ins` row exists) | Full portal: ticket, e-booklet, leave a note, public wall if enabled, practical info. |
| **Cancelled** | "This ticket is no longer valid — please see the front desk." |

Unlocking on admission gets both things worth having: the booklet does not leak before the concert, and
notes come only from people who actually attended.

`shows.portal_unlock_mode` controls this:
- `ON_ADMISSION` (default) — as above
- `OPEN_TO_ALL` — everything visible to any valid ticket holder. **One-click admin fallback** if door
  scanning falls behind or venue connectivity fails, so the booklet is still reachable.
- `CLOSED` — status page only, for after the concert

### 13.3 Sections when unlocked

1. **Your ticket** — name, code, show, date, doors, venue, free-seating notice, download PDF, and a
   checked-in badge. Segment is never shown to the audience; a guest does not need to know they were
   in the "public" block.
2. **Programme booklet** — the uploaded PDF in a mobile viewer with a download link. Visible only when
   `booklets.published`, so it can be held back until the day.
3. **Leave a note** — §13.4.
4. **Public wall** — only when `portal.public_wall_enabled` and `public_wall_visibility = AUDIENCE`.
5. **Practical info** — per-concert Markdown (parking, latecomers, interval).

Access control: possession of the token is the credential. Rate-limited, `noindex`, and no PII beyond
the attendee's own name. It must be readable on a phone in a dark hall and load on 3G — high contrast,
large touch targets, minimal payload.

### 13.4 Notes

Left by an identified attendee — the token says who — which removes almost all of the spam problem.

- `body`, required, capped at `portal.note_max_length`
- `to_player_id`, optional. **Behaviour derives from the attendee's segment, not the show** — a single
  show carries both kinds of audience. An attendee in a `PLAYER_INVITED` segment gets their inviting
  player prefilled and changeable; one in a `PUBLIC` segment gets a searchable dropdown of concert
  players plus "The whole orchestra".
- `display_name`, defaulting to the attendee's name; `is_anonymous` hides it on the wall but never
  from admin.

One note per attendee per show by default, editable until `notes_close_at`.

**Two independent flags, deliberately separate:**

- `moderation_status` — `PENDING` → `APPROVED`/`HIDDEN`. Admin triage.
- `wall_status` — `NOT_PUBLISHED` → `PUBLISHED`. Whether it appears on the public wall.

**Notes addressed to a specific player are never auto-published.** They are personal messages, visible
to admin and destined for that player's digest. Only an explicit admin action puts any note on the
public wall, and only when the concert has the wall enabled.

---

## 14. Admin

### 14.1 Structure

```
/admin
  /concerts                    list, create, archive
  /concerts/{id}
    /overview                  capacity across all shows, at-a-glance status
    /shows                     CRUD; capacity, quota, deadline, policy, portal mode per show
    /players                   CRUD, CSV import, invite links, resend/rotate tokens
    /forms                     builder, preview, open/close, response list
    /registrations             searchable table + full manual CRUD (§7.5)
    /extras-review             the batch grant screen, per segment (§7.5)
    /import                    upload → map → validate → commit
    /tickets                   template editor, bulk regenerate, preview
    /email                     templates, outbox, blast (with round dedup, §11.4), send log
    /checkin                   live dashboard, scan log
    /operators                 provision operators, assign shows, reset codes, deactivate
    /portal                    booklet upload, practical info, unlock mode
    /notes                     wall + per-player grouping (§14.2)
    /exports                   CSV/XLSX of any table view
  /settings                    users, roles, system defaults, SMTP test, audit log
```

### 14.2 Notes wall

The primary post-concert artefact.

- **Wall view** — approved notes as cards, filterable by show, player, moderation and wall status.
- **Grouped by player** — a collapsible section per player with every note addressed to them and a
  count. **Admin-only, always**, regardless of public-wall settings. This is the view used to prepare
  what goes back to players.
- Each note renders as `"{body}" — from {display_name}`, or "Anonymous".
- **Actions** — approve/hide individually or in bulk; publish to the public wall (explicit, never
  automatic); export a player's notes as PDF or CSV; queue `player_notes_digest` emails to selected
  players in one action.
- Unaddressed notes group under "For the orchestra" and are the natural public-wall candidates.

### 14.3 Roles and accounts

Two populations, deliberately asymmetric.

| | `ADMIN` | `OPERATOR` |
|---|---|---|
| How many | **Exactly one, shared** | One per usher |
| Sign-in | A single secret code | Display name + access code |
| Created by | `bootstrap-admin` script, once | The admin, from `/admin/operators` |
| Scope | Everything, all shows | Only assigned shows |
| Can | All admin functions | Sign in, select an assigned show, scan, check in, search attendees within that show |
| Cannot | — | Edit any data, export, view PII beyond name and ticket status, or reach an unassigned show |

Players and audience members never have accounts — they hold unguessable tokens (§8.1, §13).

#### The shared admin account

The committee shares one login. This removes admin user management entirely, at two costs worth stating
plainly:

- **`audit_log` records what and when, but not who.** Every override, capacity change and manual
  registration is attributed to the one admin account. The schema already supports individual admin
  accounts if attribution is ever wanted — add rows with `role = ADMIN` and nothing else changes.
- **The code is the entire security boundary** for every attendee's name and email. So: generate a long
  random passphrase rather than choosing a memorable one, rate-limit the login route hard (5 attempts
  per IP per 15 minutes, then a growing lockout), and rotate it after each concert and whenever someone
  leaves the committee. Rotation is a one-field change on the admin account.

**Login UX.** The form asks for the code only. The admin email is a constant held server-side, so nobody
has to remember an address — but it is still a real Supabase Auth password sign-in underneath, not a
bespoke cookie. Do not invent a custom session mechanism for this.

#### Provisioning operators

`/admin/operators` lists operators with their assigned shows, check-in counts and last sign-in. Creating
one generates a display name slug and a random access code, shown **once** on screen for the admin to
pass on. Codes can be regenerated; operators can be deactivated, which invalidates their session at the
next request.

Assignment is a checkbox grid of shows per operator, editable at any time. Revoking an assignment takes
effect immediately on the server, including for a device that is currently offline — its queued scans
are rejected on sync and surfaced to the admin rather than silently dropped.

---

## 15. Surfaces and UI architecture

Four surfaces, each with a different audience, device target, and auth model. They share a design
system and almost nothing else. Build them as separate route groups with separate layouts.

| # | Surface | Audience | Auth | Device target |
|---|---|---|---|---|
| 1 | **Admin console** | Committee | Supabase Auth, `ADMIN` | **Web-first**, responsive later |
| 2 | **Registration** | Players, public | Token in URL, or open | **Responsive** (most will be on phones) |
| 3 | **Door scanner** | Ushers | Supabase Auth, `OPERATOR` | **Mobile-first**, phone only |
| 4 | **Concert portal** | Admitted audience | Ticket token | **Mobile-first**, phone only |

### 15.1 Admin console (web-first)

Standard shadcn app shell: sidebar navigation, breadcrumb header, content area. Concert is selected
once and held in context, so every inner page is scoped to it.

Screens are listed in §14.1. The dominant pattern is **table + filters + row actions + a detail sheet**,
so build one good `DataTable` (TanStack Table + shadcn) with server-side pagination, column visibility,
and CSV export, then reuse it for registrations, attendees, players, notes, outbox and scan log. That
single component is most of the admin console.

Mobile responsiveness for admin is a nice-to-have. Tables degrade to cards below `md`; do not spend
build-week time on it.

### 15.2 Registration (responsive)

Single-column, no chrome, orchestra branding. One generic renderer drives both form types from the JSON
schema (§8.2) — do not build two forms.

Screens: form (with live seat indicator), confirmation, edit-existing-response, closed/full state,
public email-verification landing.

### 15.3 Concert portal (mobile-first)

Single column, large type, high contrast for a dark hall. Sections per §13.3, rendered by state.
Keep the payload small — this loads on venue wifi at the worst possible moment.

### 15.4 Door scanner (mobile-first) — borrow this IA from Hi.Events

The one place its UI is worth copying, because it has been through real venue use.
Reference: `frontend/src/components/layouts/CheckIn/`.

- **Bottom tab navigation**, three tabs — thumb-reachable, no hamburger.
  Reference `CheckIn/BottomNav.tsx`.
  - **Scan** — full-bleed camera, minimal chrome, result overlay. Reference `tabs/ScanTab.tsx`,
    `tabs/InlineCameraScanner.tsx`.
  - **Search** — name and ticket-code lookup for when the QR will not read. Reference `tabs/SearchTab.tsx`.
  - **Stats** — checked in / remaining, live. Reference `tabs/StatsTab.tsx`.
- **Bottom sheet for attendee detail**, not a modal or a route change — the operator never loses the
  camera. Reference `CheckIn/AttendeeDetailSheet.tsx`.
- **Show selector as a persistent pill** in the header, so the operator can always see which show they
  are admitting to. Reference `CheckIn/OccurrenceFilterPill.tsx`.

Everything below the IA — the scanning library, offline manifest, feedback channels — is ours per §12.
Read the structure, write the code fresh in shadcn.

### 15.5 Shared

One design system: shadcn/ui + Tailwind, one theme, one set of tokens, orchestra branding applied via
CSS variables so it can change per concert without code edits.

---

## 16. Tech stack

| Concern | Choice | Note |
|---|---|---|
| Framework | Next.js 15, App Router, TypeScript | Server Actions for mutations, RSC for admin tables |
| UI | shadcn/ui + Tailwind | |
| DB / Auth / Storage | **Supabase** | One service for all three; the idle pause is handled by a keep-alive cron (§17.1) |
| Data access | Drizzle + `postgres.js` | Typed migrations; allocation logic is a raw SQL function |
| Email | **`nodemailer` + Gmail SMTP** | Node runtime, `maxDuration = 60` (§11.1) |
| Spreadsheet | `sheetjs` | Client preview and server commit |
| QR generate / scan | `qrcode` / `@zxing/browser` | |
| Ticket canvas | `react-konva` | Dynamic import, `ssr: false` |
| PDF render | `pdf-lib` + `sharp` | |
| Tables | TanStack Table | |
| Validation | `zod` | Shared across form schema, API, import |
| Offline store | `idb-keyval` | Scanner manifest and pending queue |

Any route that sends email, renders PDFs, or parses spreadsheets must declare
`export const runtime = 'nodejs'` — none of that works on Edge.

### 16.1 Where the backend lives

**Next.js Route Handlers and Server Actions are the backend.** They run server-side on Lambda, not in
the browser; there is no layering compromise in putting SMTP, PDF rendering or spreadsheet parsing
there.

**Supabase Edge Functions are not used**, for one concrete reason: `sharp` is a native Node addon and
cannot run on their Deno runtime. Ticket rendering therefore has to be on Vercel regardless, and moving
only email to Edge Functions would split the backend across two runtimes, two deploy targets, two sets
of environment variables and two log surfaces — with CORS in between — to relocate the one function
that already works where it is.

**Postgres functions are used where they earn it.** `claim_seats()` (§7.8) lives in the database
because it needs a row lock held across a read-then-write, and correctness there is worth more than
keeping all logic in one language. Reporting aggregates are plain SQL views. Everything else is a
Route Handler.

**Portability is deliberate.** Standard Postgres wire protocol, an S3-compatible storage API, plain
Next.js, and SMTP behind an interface. If any free tier changes, the stack moves to a €3.29/month VPS
with no code changes.

## 17. Hosting

**Vercel Hobby + Supabase Free + Gmail SMTP.** Two services and an email account. Consolidation was
chosen over per-layer optimality: with a ten-day build, Supabase supplying database, auth and storage
in one is worth more than a marginally better tier on each.

### 17.1 The Supabase idle pause, and the fix

Supabase free projects pause after **7 days of inactivity**, and a paused project does not wake on an
incoming query — it needs a manual restore from the dashboard. For a service used a few times a year
that would otherwise be fatal.

The fix is a **daily keep-alive**: a Vercel Cron hitting `/api/health`, which runs `select 1`. Project
activity resets the idle timer, so a daily ping carries 7× margin.

Two details:

- **Vercel Hobby crons run only on Production deployments**, and fire within roughly an hour of the
  scheduled time. Both are irrelevant at daily-versus-weekly margins.
- **The failure mode is silent.** If the cron breaks — project renamed, route erroring, deployment
  removed — nothing tells you until the database is already paused, most likely a month before a
  concert. Add a **second keep-alive as a GitHub Actions cron** hitting the same endpoint. One YAML
  file, no new service, and it removes the single point of failure.

`/api/health` should return the current time straight from Postgres, so a 200 proves the database
answered rather than just that Next.js is up.

### 17.2 Egress

Supabase free allows **5GB egress/month**. The e-booklet is the only asset downloaded at scale, so the
ceiling is roughly `booklet size × attendees`:

| Booklet size | 400 downloads | 1,000 downloads |
|---|---|---|
| 2 MB | 0.8 GB | 2.0 GB |
| 5 MB | 2.0 GB | 5.0 GB |
| 10 MB | 4.0 GB | 10.0 GB |
| 20 MB | 8.0 GB | 20.0 GB |

Previewing counts as downloading — embedding a PDF transfers the whole file. A PDF.js viewer using
**range requests** (Supabase Storage supports them) fetches only the pages someone opens, which for a
programme most people skim is a large saving.

If the finished programme would breach the cap at the expected attendance, compress it first, then move
that single file to Cloudflare R2, which has zero egress charges. Everything else stays on Supabase.

Nothing else approaches a limit: a 500MB database against text-only rows, 1GB storage against artwork
and a booklet, 1M function invocations against a few thousand requests a year.

### 17.3 Allowances

| Layer | Provider | Free allowance | Headroom |
|---|---|---|---|
| App + functions | Vercel Hobby | 100GB bandwidth, 1M invocations/mo | Burst uses <1% |
| DB / Auth / Storage | Supabase Free | 500MB DB, 1GB storage, 5GB egress, 50k MAU | Egress is the only one worth watching (§17.2) |
| Email | Gmail (free account) | 500/day | Low hundreds per show, blasted show by show |

### 17.4 Vercel Hobby licensing — the precise line

Hobby is non-commercial only, and the boundary is narrower than it sounds:

- **Soliciting donations does not make it commercial.** Explicitly permitted.
- **Paying developers to maintain the codebase does.** A volunteer-run orchestra site is compliant; one
  maintained by a paid contractor is not.
- Selling tickets, sponsorship placements or ad units would also cross the line.

Free admission and volunteer labour keep this compliant. If that changes, the escape is
`@cloudflare/next-on-pages` onto Cloudflare Pages, which permits commercial use on its free tier.

### 17.5 Failure modes

| Risk | Mitigation |
|---|---|
| **Keep-alive silently stops, database pauses.** | Two independent crons (§17.1). Check the Supabase dashboard as the first item on the pre-concert runbook. |
| **Booklet egress.** | Compress, use range requests, or move the booklet alone to R2 (§17.2). |
| **SMTP throughput.** | `maxDuration = 60` with batches of ~25; the outbox commits per message and resumes. Confirmed in the day-10 dry run. |
| **Gmail daily cap.** | `email.max_per_day` guards it and the queue resumes the next day. |
| Function timeout | Everything batches: dispatch, import, rendering. |
| Cold starts at the door | Irrelevant — the scanner downloads its manifest up front and validates locally. |

### 17.6 Why Hi.Events cannot be hosted free — confirmed

An always-on container (1.5–2GB RAM, persistent Postgres *and* Redis, continuous queue worker and
scheduler) is **not achievable on genuinely free infrastructure**. Three independent blocks:

- **Memory.** The only perpetual free VMs are GCP `e2-micro` at 1GB — insufficient, the OOM killer
  takes Postgres or Node — and 12-month-limited AWS/Azure micro instances.
- **Sleep and CPU throttling.** Render (15min), Koyeb, Glitch and Replit sleep idle containers, killing
  the queue worker. Cloud Run throttles CPU to ~0 between HTTP requests, freezing background execution.
- **Oracle Cloud Always Free** has the hardware (4 ARM OCPUs, 24GB RAM) but reclaims instances whose
  95th-percentile CPU, network *and* memory sit below 20% over 7 days — precisely this usage pattern.
  Faking load to defeat it violates their acceptable use policy.

Northflank's 512MB tier cannot hold the stack either. The cheapest stable option there is a Hetzner
CAX11 at €3.29/month — which is also the fallback for our own stack if a free tier changes.

### 17.7 Free-tier stability

Free tiers have contracted sharply: PlanetScale removed Hobby (2024), Railway and Fly.io now require
payment, Render deletes free Postgres after 30 days, Heroku removed everything. The pattern is
consistent — **always-on container tiers are being withdrawn; scale-to-zero serverless tiers are not**,
because idle serverless costs the provider nothing. This stack is entirely scale-to-zero, and the
portability note in §16 hedges the rest.

## 18. Delivery plan

**The schedule lives in `context.md` §5**, because it belongs to this engagement rather than to the
system. It carries the phase breakdown, dates, priority order and cut list.

Two properties of that plan are architectural rather than scheduling, so they are recorded here:

- **The ticket pipeline is the critical path.** Import → render → outbox → blast is the sequence that
  must work; everything else degrades gracefully. A missing portal is a disappointment, a missing
  ticket is a person at a door with nothing.
- **A full-volume dry run is mandatory before first real use.** Generating and sending a complete
  show's tickets is where PDF render time, function timeouts, font embedding and attachment size
  surface. Run it against real inboxes — Gmail, Outlook, and one university or corporate address — and
  confirm all three land in the inbox rather than spam.

## 19. Decisions

### 19.1 Settled

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
| 9 | Registration capture | Google Forms exports are a first-class input via import (§9), equal to native forms. Neither is privileged in the data model. |
| 10 | Ticket editor | A real canvas editor over the organisation's own artwork, with seeded defaults so the system works before anyone opens it. |
| 11 | Database / auth / storage | **Supabase**, with a daily keep-alive cron defeating the 7-day idle pause. One service for three concerns; the pause is a solved problem, not a disqualifier. |
| 12 | Email transport | **Gmail SMTP via `nodemailer` from a Vercel Node.js function.** Only port 25 is blocked on serverless — 465 and 587 work. Behind a `MailTransport` interface so an HTTP provider is an adapter swap. |
| 13 | Booklet delivery | Supabase Storage with range requests; move the booklet alone to R2 only if egress demands it (§17.2). |
| 14 | Reference material | `ref.md`, not a vendored clone of Hi.Events. |
| 15 | Backend placement | Next.js Route Handlers and Server Actions. **No Supabase Edge Functions** — `sharp` cannot run on Deno, so rendering must be on Vercel anyway (§16.1). `claim_seats()` stays a Postgres function because it needs a row lock. |
| 16 | Repeat blasts | Idempotent by construction: `ticket_sent_at` as dedup key, a filtered `insert … on conflict do nothing`, and a partial unique index on pending outbox rows (§11.4). |
| 17 | Base oversubscription | Blocked by default across all three mutations that can cause it, with an explicit opt-out toggle (§7.4). |
| 18 | Configuration | No operational value has a code default. Concert data lives in `context.md` and is entered through the admin UI (§2.1, §6). |
| 19 | Admin accounts | **One shared `ADMIN` account** unlocked by a single secret code. No admin user management. Costs audit attribution, which is accepted; the schema still supports individual admins if that changes (§14.3). |
| 20 | Operator accounts | **Multi-account, provisioned by the admin, scoped to assigned shows** via `operator_show_assignments`. Enforced in the handler and again by RLS — the manifest endpoint is the boundary that matters, since the manifest is the attendee roster (§12.3). |

### 19.2 Still open

Open questions are concert-specific and tracked in **`context.md` §6**, each with the date it is needed
by. Nothing in the system design is currently blocked on an unanswered question.

## Appendix A — Research prompt: genuinely free hosting

Paste into Gemini Deep Research if reconsidering the hosting decision.

> I need to host a small internal web application with **zero ongoing cost**, permanently — not a trial
> or a time-limited credit. Research and compare currently-available free tiers, verifying each claim
> against the provider's own pricing and terms pages. Free tiers change often, so flag anything you
> cannot confirm from a primary source, and state the date of the page you checked.
>
> **Two candidate architectures, evaluated separately:**
>
> **A. Serverless + managed Postgres.** A Next.js app on a serverless platform, managed Postgres, ~1GB
> object storage, outbound SMTP. No always-on process. Traffic is extremely bursty: near-zero for weeks,
> then ~2000 requests over a few hours, three or four times a year.
>
> **B. Always-on container.** One Docker container running nginx + PHP-FPM + a Node SSR process + a
> background queue worker + a cron scheduler, needing roughly 1.5–2GB RAM and 1 vCPU, plus persistent
> PostgreSQL 15+ and persistent Redis. The worker and scheduler must run continuously — a platform that
> sleeps idle containers breaks it.
>
> **For every provider, report:**
> 1. Exact free-tier limits (RAM, vCPU, storage, bandwidth, build minutes, DB size, connection limits)
> 2. Whether the free tier **sleeps, suspends, or deletes** idle projects — after how long, whether it
>    auto-resumes, and the cold-start penalty
> 3. Whether a credit card is required at sign-up
> 4. Whether the terms permit this use — especially any **non-commercial-only** restriction, and how
>    each provider defines commercial (the real case is a free-admission community arts organisation
>    with no revenue on the site)
> 5. Persistent storage: does it exist, does it survive redeploys, what is the limit
> 6. Outbound SMTP: blocked? port or rate restrictions?
> 7. Custom domain and free TLS
> 8. Any hard cap that causes an **outage** rather than a bill — a free tier that goes down mid-event is
>    worse than one that degrades
> 9. Data export and lock-in
>
> **Cover at minimum**: Vercel, Netlify, Cloudflare (Pages/Workers/D1/R2), Supabase, Neon, Turso, Xata,
> Railway, Render, Fly.io, Northflank, Koyeb, Deno Deploy, Oracle Cloud Always Free, Google Cloud Run,
> AWS Free Tier (noting what expires at 12 months), Azure, PythonAnywhere, Glitch, Replit, Clever Cloud,
> Scaleway, Hetzner (paid — include as a cost baseline), and free Redis-compatible options (Upstash,
> Redis Cloud).
>
> **Deliverables:**
> - A comparison table for architecture A and another for B
> - A specific recommended stack for each, naming the exact combination of providers
> - The top three failure modes of each recommendation and how to mitigate them
> - An explicit statement of whether architecture B is achievable **at all** on genuinely free
>   infrastructure, or whether it necessarily costs money — and if so, the cheapest realistic monthly cost
> - Which providers have reduced or removed free tiers in the last 24 months, as a stability signal

---

## Appendix B — Environment variables

| Variable | Used by | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | client + server | |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | client | RLS-protected access only |
| `SUPABASE_SERVICE_ROLE_KEY` | server only | **Never expose to the client.** Bypasses RLS. |
| `DATABASE_URL` | server | Direct Postgres connection for Drizzle migrations |
| `GMAIL_USER` | server | Sending address |
| `GMAIL_APP_PASSWORD` | server | App password, not the account password; requires 2FA |
| `APP_URL` | server | Absolute base for QR URLs and email links; must be the production origin |
| `CRON_SECRET` | server | Shared secret checked by `/api/health` and dispatch routes so they are not openly callable |
| `ADMIN_EMAIL` | server | Constant address behind the code-only admin login (§14.3) |
| `BOOTSTRAP_ADMIN_PASSWORD` | script | The initial shared admin code; rotate from the UI afterwards |

`APP_URL` deserves care: it is baked into every QR code at issue time. If tickets are generated against
a preview URL and then the domain changes, every QR points at a dead host and the only fix is
reissuing. Set it correctly before the first render, not before the first send.

---

## Appendix C — Hi.Events reference map

**Superseded by `ref.md`**, which writes out everything worth taking in enough detail that the source
is not needed. The table below is the file map behind those notes; do not vendor or copy from it.

| Topic | Path | Worth |
|---|---|---|
| **Scanner IA — bottom nav, tabs, detail sheet** | `frontend/src/components/layouts/CheckIn/` | **High** — copy the structure (§15.4) |
| Attendee identifiers (`short_id` + `public_id`) | `backend/app/DomainObjects/Generated/AttendeeDomainObjectAbstract.php` | Medium |
| Check-in as an append-only log | `backend/app/DomainObjects/Generated/AttendeeCheckInDomainObjectAbstract.php` | Medium |
| Scoped door-operator access | `backend/app/Http/Actions/CheckInLists/Public/` | Medium |
| Multi-date shows | `backend/app/Services/Domain/EventOccurrence/` | Low |
| Capacity assignment modelling | `backend/app/Services/Domain/CapacityAssignment/` | Medium |
| Email templating + token context | `backend/app/Services/Domain/Email/EmailTokenContextBuilder.php` | Medium |
| Waitlist handling | `backend/app/Services/Domain/Waitlist/` | Low |
| Ticket designer | `frontend/src/components/routes/event/TicketDesigner/` | **None** — a settings form, not a canvas editor |