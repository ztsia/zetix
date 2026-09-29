# Domain model and configuration

*Tables, columns, keys and the configuration cascade. Every module reads this one.*

Part of the system specification — see [`README.md`](README.md) for the index, and
[`decisions.md`](decisions.md) before re-litigating anything here.

**Built by:** `F1`. **Read by:** every module — every branch queries these tables.
See [`../modules.md`](../modules.md) for what each label owns and when it runs.

---

## 5. Domain model

```
concert
 ├── show                     (a hall on a night; owns total capacity and the door)
 │    ├── show_segment        (a slice of that capacity with its own audience mode)
 │    │    ├── registration_form   (one active form per round, per segment)
 │    │    └── registration        (a booking party)
 │    │         └── attendee       (one row per seat / per ticket)
 │    └── check_in            (append-only scan log, per show)
 ├── player                   (performer, scoped to concert)
 │    └── player_allocation   (player × segment → quota override)
 ├── ticket_template          (canvas layout JSON + background asset)
 ├── booklet                  (e-booklet PDF)
 └── portal_note              (note from an attendee, optionally addressed to a player)
```

### 5.1 Tables

**`system_settings`** — single-row or key/value; the root of the cascade (`README.md` §2.2)
`key`, `value` (jsonb), `updated_at`, `updated_by`

**`concerts`**
`id`, `name`, `slug`, `season`, `starts_on`, `ends_on`, `status` (DRAFT|ACTIVE|ARCHIVED),
`defaults` (jsonb — concert-level cascade overrides),
`portal_enabled`, `notes_enabled`, `notes_close_at`,
`public_wall_enabled` (bool), `public_wall_visibility` (ADMIN_ONLY|AUDIENCE),
`practical_info_md`, `created_at`, `updated_at`, `deleted_at`

**`shows`**
`id`, `concert_id`, `name`, `starts_at` (timestamptz), `ends_at` (nullable), `doors_open_at`,
`venue_name`, `venue_address`,
`capacity`,
`portal_unlock_mode` (ON_ADMISSION | OPEN_TO_ALL | CLOSED),
`status` (DRAFT|OPEN|CLOSED|COMPLETED), `ticket_template_id` (nullable),
`created_at`, `updated_at`, `deleted_at`

`ticket_template_id` resolves like any other cascading value: **show → concert
(`ticket.default_template_id`) → the seeded global default**. It is nullable precisely so a concert can
set one template for all its shows and a single show can override it. Never read the column directly.
V3 puts a segment level in front (`show_segments.default_ticket_template_id`, `v3.md` §24.2); null on a
segment changes nothing.

The show owns the **physical hall**: one capacity number and the door. It carries no audience mode —
see segments below.

**`ends_at` is nullable and its absence means "do not guess".** It is what "the show is over" is measured
from — the portal's post-show phase and auto-completion both derive from
`ends_at + show.auto_complete_after_hours` (`v2.md` §13.2.1). A concert with an interval can run well past
its nominal length, so no duration is inferred from `starts_at`: with `ends_at` null there is no post-show
phase and no auto-completion, and an admin marks the show `COMPLETED` by hand as before (§2.1 — a missing
value is a validation error, never a silent fallback).

**One capacity, not three.** There is no separate soft threshold and no `held_seats` column. Seats you
want to withhold — staff, press, guests of honour — are simply seats you do not give to any segment:
if the hall is 400 and the segments total 390, ten seats are held, and Home shows them
as unallocated (the Overview before V3). One number is easier to reason about at 9pm on a concert night than three.

**`show_segments`** — a slice of one show's capacity with its own audience model
`id`, `show_id`, `name` (e.g. "Public", "Player invited"),
`audience_mode` (PLAYER_INVITED | PUBLIC),
`capacity` (this segment's slice of the hall),
`base_quota` (nullable; PLAYER_INVITED only),
`base_claim_deadline` (nullable),
`extras_policy` (REVIEW | AUTO_FCFS),
`allow_partial_grant`, `max_tickets_per_response` (nullable),
`default_ticket_template_id` (nullable — V3, the segment level of `ticket.default_template_id`),
`auto_approve_clean` (nullable — V3, the segment level of `review.auto_approve_clean`),
`display_order`, `created_at`, `updated_at`
Unique: `(show_id, audience_mode)` — at most one segment per mode per show
Unique: `(id, show_id)` — exists only so child tables can carry a composite foreign key (§5.2)

A show has one or more segments; a single-audience show simply has one. Constraint:
`Σ segment.capacity <= show.capacity`, validated on save with a clear error naming the overflow. A
second constraint on base entitlement is in `allocation.md` §7.4.

Segments do **not** borrow from each other automatically. If the player segment finishes with 20
unclaimed seats and the public segment is full, an admin moves the numbers explicitly (player 80,
public 320) — recorded in `audit_log`. Automatic borrowing would make capacity unpredictable on the
night.

All capacity and quota columns are nullable and resolve up the cascade (`README.md` §2.2). None has a literal
default in code.

**`players`**
`id`, `concert_id`, `full_name`, `email` (citext), `instrument`, `section`,
`invite_token` (unique, unguessable), `is_active`, `created_at`, `updated_at`, `deleted_at`
Unique: `(concert_id, lower(email))`

**`player_allocations`**
`id`, `player_id`, `segment_id`, `base_quota_override` (nullable → resolves up the cascade, `README.md` §2.2),
`notes`, `created_at`, `updated_at`
Unique: `(player_id, segment_id)`

Quota is uniform across players in practice, so the admin UI edits it at show level. The per-player
override column exists because it costs one nullable column and removes a future migration.

**`registration_forms`**
`id`, `segment_id` (nullable — null for `FEEDBACK`, which attaches to a show), `show_id` (nullable),
`kind` (PLAYER | PUBLIC | FEEDBACK), `round_label` (e.g. "Round 1"), `title`, `description_md`,
`slug` (unique),
`schema` (jsonb — `v2.md` §8.2), `schema_version` (int, bumped on every save),
`opens_at`, `closes_at`, `max_responses`,
`one_response_per_identity`, `max_tickets_per_response` (nullable),
`auto_close_on_capacity`, `allow_edit_until`, `confirmation_message_md`,
`theme` (jsonb, nullable — V3, `v3.md` §25.6),
`status` (DRAFT|OPEN|CLOSED), `created_at`, `updated_at`

A registration form belongs to a segment, and `kind` decides which **system blocks** are pre-built into
it (`v2.md` §8.2) — `PLAYER` and `PUBLIC` must agree with the segment's `audience_mode`. A `FEEDBACK` form
belongs to a show instead and creates no seats at all (`v2.md` §13.5). A second registration round is a new
form on the same segment with a new `round_label`.

`schema_version` exists so a response can pin the schema it was answered against (`v2.md` §8.2.4), the same
way a ticket pins its template version (`tickets.md` §10.5). Without it an admin renaming a question
retroactively changes what every earlier answer meant.

**`form_responses`**
`id`, `form_id`, `raw` (jsonb — exact submitted payload, never mutated),
`form_schema` (jsonb — the schema as it stood at submit time, `v2.md` §8.2.4),
`identity_key` (nullable — the player id or lowercased email),
`supersedes_id` (nullable, self-reference — the response this edit replaces, `v2.md` §8.3.1),
`submitted_at`, `ip_address`, `user_agent`, `edit_token` (unique, nullable)

```sql
create unique index form_responses_identity_key
  on form_responses (form_id, identity_key)
  where identity_key is not null;
```

That index is what enforces `one_response_per_identity` (`v2.md` §8.3). A read-then-write check in the
handler is a race at precisely the moment scarce seats attract double-clicks — the same reasoning that
makes `claim_seats()` a Postgres function rather than application code.

**An edit inserts a new row rather than mutating `raw`**, chained through `supersedes_id`; the
registration points at the newest. `raw` is the receipt of what someone actually typed and a dispute is
settled from it, so nothing may overwrite it.

**`registrations`** — a booking party
`id`, `show_id`, `segment_id`, `round_label` (nullable),
`player_id` (nullable), `form_response_id` (nullable), `import_batch_id` (nullable),
`source` (FORM|IMPORT|ADMIN),
`contact_name`, `contact_email` (citext), `contact_phone`,
`custom` (jsonb, nullable — answers to `CUSTOM` blocks, `v2.md` §8.2.3),
`status` (CONFIRMED|PENDING_REVIEW|WAITLIST|CANCELLED),
`email_verified_at` (nullable), `verification_token` (unique, nullable, unguessable),
`requested_at` (timestamptz — the FCFS ordering key; since V3 the party's earliest seat),
`approved_at`, `approved_by` (V3 review gate, `v3.md` §25.4), `merged_into_id` (§25.5),
`update_token` (unique, nullable — §25.6),
`email_issue`, `email_checked_at`, `email_issue_accepted_at` (the stored address check, §24.6),
`created_by`, `created_at`, `updated_at`, `deleted_at`
Index: `(segment_id, status, requested_at)`, `(show_id, status)`
Unique: `(id, segment_id, show_id)` — for the composite foreign key in §5.2

**Verification gates the email, never the seat** (`v2.md` §8.1.4). A public registration is `CONFIRMED`
the moment it is submitted, because seats are scarce and holding them for an unclicked link would give
them away; `email_verified_at` decides only whether the ticket email is released. `source = IMPORT` and
`source = ADMIN` registrations are never gated — an imported registrant never received a link, and
holding their tickets behind one would strand them (`import.md` §9.4).

**`custom` duplicates `form_responses.raw` on purpose.** `raw` is the immutable receipt and exists only
for `source = FORM`; an admin table or an export reading it would show blanks for every imported and
admin-created registration, which is most of them. `custom` is the queryable copy that screens, filters
and exports read (`v2.md` §8.2.3).

**`attendees`** — one row per seat
`id`, `registration_id`, `show_id`, `segment_id`,
`full_name`, `name_source` (PROVIDED|PLACEHOLDER), `email` (citext, nullable),
`custom` (jsonb, nullable — per-seat answers to custom fields inside a repeater, `v2.md` §8.2.3),
`allocation_type` (BASE|EXTRA|HELD|COMP),
`ticket_code` (unique), `qr_token` (unique),
`status` (CONFIRMED|PENDING_REVIEW|WAITLIST|CANCELLED),
`ticket_issued_at`, `ticket_sent_at`, `ticket_sent_source` (EMAIL|MANUAL, nullable),
`needs_reissue` (bool — set when a bound field changes after sending, `tickets.md` §10.6),
`ticket_template_id`, `ticket_template_version` (pinned at issue time — see `tickets.md` §10.5),
`requested_at` (V3 — this seat's own first-come time, defaulting to its registration's, `v3.md` §21.3),
`over_capacity_at` (V3 — set when an override granted this seat past a limit, §23.5),
`import_row_id` (V3 — the staged import row that created it, §25.7),
`created_at`, `updated_at`, `deleted_at`
Index: `(segment_id, status)`, `(show_id, status)`; unique on `qr_token`, unique on `ticket_code`

`ticket_sent_at` is the **per-seat delivery truth and the dedup key for repeat blasts** (`email.md` §11.4). It is
set only when delivery is confirmed — either by a successful send (`ticket_sent_source = EMAIL`) or by
an admin marking it delivered by hand (`MANUAL`, `email.md` §11.5). Email itself is addressed per *registration*,
not per attendee, so one successful send stamps every attendee whose PDF it carried.

**`check_ins`** — append-only
`id`, `attendee_id`, `show_id`, `operator_id` (nullable), `device_id`,
`scanned_at`, `synced_at`, `source` (ONLINE|OFFLINE_SYNC|MANUAL),
`override_reason` (nullable), `reverted_at`, `reverted_by`
Index: `(show_id, scanned_at)`, `(attendee_id)`

**`ticket_templates`**
`id`, `concert_id` (nullable — null = global default), `name`, `version`,
`background_asset_path`, `background_kind` (IMAGE|PDF|NONE),
`page_width_pt`, `page_height_pt`, `layout` (jsonb — `tickets.md` §10.2),
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

**`feedback_responses`** — one attendee's answers to a `FEEDBACK` form (`v2.md` §13.5)
`id`, `form_id`, `attendee_id`, `show_id`,
`answers` (jsonb), `form_schema` (jsonb — pinned as in §8.2.4), `submitted_at`, `updated_at`
Unique: `(attendee_id, form_id)`

One response per attendee, not per registration. *"How was your evening?"* is not a group answer, and a
party of four that split up at the interval has four of them. The audience is attendees with a
`check_ins` row — a manual or override admit counts, because those people were in the hall
(`v2.md` §13.5.1).

**`import_batches`**
`id`, `show_id`, `segment_id`, `filename`, `mapping_profile_id`, `uploaded_by`,
`row_count`, `created_count`, `skipped_count`, `error_count`,
`report` (jsonb), `status` (DRY_RUN|COMMITTED|STAGED|UNDONE), `queue_receipts` (V3),
`created_at`, `updated_at`

**`mapping_profiles`**
`id`, `name`, `show_id` (nullable), `audience`, `config` (jsonb — `import.md` §9.3), `created_at`, `updated_at`

**`email_outbox`** — one row per *message*, and every message has exactly one addressee
`id`, `registration_id` (nullable), `player_id` (nullable),
`purpose` (V3 — RECEIPT|VERIFICATION|TICKETS|EXTRAS_DECISION|CANCELLATION|REMINDER|FEEDBACK|
NOTES_DIGEST|PLAYER_INVITE|REPLY, not null, no default), `template_key` (null only for `REPLY`),
`to_email`, `to_name`,
`subject`, `body_md`, `context` (jsonb — the merge values the body was rendered from),
`attachment_paths` (jsonb array, nullable),
`status` (DRAFT|QUEUED|SENDING|SENT|FAILED|CANCELLED|BOUNCED),
`attempts`, `last_error`, `scheduled_for`, `sent_at`,
`message_id`, `superseded_by_id`, `bounced_at`, `bounce_code`, `bounce_detail`,
`in_reply_to_message_id` (V3, `v3.md` §24, §26), `created_at`, `updated_at`
Index: `(status, scheduled_for)`, `(registration_id)`; unique on `message_id`

```sql
-- V3 keys both on purpose, not template (v3.md §24.2, decision 52), and leaves
-- REPLY out: two replies a person wrote are two messages.
create unique index outbox_no_duplicate_pending
  on email_outbox (registration_id, purpose)
  where status in ('DRAFT', 'QUEUED', 'SENDING') and purpose <> 'REPLY';

-- V2, for the one player-addressed template. Both keys stay total:
create unique index outbox_no_duplicate_pending_player
  on email_outbox (player_id, purpose)
  where status in ('DRAFT', 'QUEUED', 'SENDING') and purpose <> 'REPLY';

alter table email_outbox
  add constraint email_outbox_one_addressee
  check (num_nonnulls(registration_id, player_id) = 1);
```

**Every email in this system is addressed to a registrant, never to a seat** (`email.md` §11.3): a player receives
one message carrying all their guests' PDFs, a public party receives one message carrying theirs. Guest
emails are optional (`v2.md` §8.1), so an attendee is not reliably addressable at all. Keying the outbox on
`registration_id` — non-nullable — is therefore both the accurate model and the only one where the
partial unique index actually bites; a nullable `attendee_id` would never conflict with itself in
Postgres and the `on conflict do nothing` in `email.md` §11.4 would silently do nothing.

`subject` and `body_md` hold the **rendered** message, not a template reference, so the admin can edit
any message before dispatch and the dispatcher sends exactly what was reviewed (`email.md` §11.5).

This index is what makes a repeat blast safe (`email.md` §11.4). Do not omit it.

**`player_notes_digest` is the one player-addressed email**, and a player has no registration. V2
therefore made `registration_id` nullable — the exact move the paragraph above warns about — and kept
the guarantee by **adding a disjoint second key rather than swapping the first**: nullable `player_id`,
a `check` that exactly one of the two is non-null, and a second partial unique index over the same
pending statuses. Every registration-addressed row still carries a non-null `registration_id` and the
original index bites unchanged.

**The check constraint is the load-bearing half.** Without it a row with both keys null conflicts with
nothing, `on conflict do nothing` silently does nothing, and a double-queued digest sends twice with no
error anywhere. `tests/schema/outbox.test.ts` proves both halves.

**`app_users`** — backed by Supabase Auth
`id` (= `auth.users.id`), `email`, `display_name`, `role` (ADMIN | OPERATOR | VIEWER — V3, `v3.md` §28),
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

**V3 tables** — `segment_message_defaults`, `email_threads`, `email_messages`, `mail_sync_state`,
`import_rows`, `duplicate_candidates`, `command_runs`, `command_run_items`, `scheduler_heartbeat`, and the
view `party_pipeline`. Their columns and reasons are in `v3.md` §30.1 and the schema files
(`src/db/schema/`); they are not restated here.

**`audit_log`**
`id`, `actor_id`, `action`, `entity_type`, `entity_id`, `before` (jsonb), `after` (jsonb),
`reason` (nullable), `created_at`

Every admin override (`README.md` §2.4) writes here.

### 5.2 Referential integrity: composite foreign keys, not triggers

`registrations` and `attendees` each carry **both** `show_id` and `segment_id`, because almost every
query filters on one or the other and the denormalisation earns its place. The risk is drift: an
attendee whose `segment_id` disagrees with its registration's, or a registration pointing at a segment
that belongs to a different show. Either would corrupt every capacity count in `allocation.md` §7 silently.

Postgres can make both impossible with no triggers and no application checks, using the redundant
unique keys declared above:

```sql
alter table registrations
  add constraint registrations_segment_fk
  foreign key (segment_id, show_id) references show_segments (id, show_id);

alter table attendees
  add constraint attendees_registration_fk
  foreign key (registration_id, segment_id, show_id)
  references registrations (id, segment_id, show_id);
```

An attendee can now only exist in the same segment and show as its registration, and a registration
only in a segment that genuinely belongs to its show. Moving a registration between segments (`allocation.md` §7.6)
updates parent and children in one transaction; the constraint is what stops it being done by half.

**`attendees_registration_fk` is `deferrable initially deferred`.** With an immediate constraint that
move is not merely awkward, it is impossible: updating the attendees first points them at a
registration still in the old segment, updating the registration first strands the attendees, and
re-creating them is barred because `qr_token` is immutable for life (decision 28). Deferring to commit
is what "in one transaction" above actually requires — a half-finished move still fails, a complete one
succeeds. Two consequences for callers: the violation surfaces at `COMMIT` rather than at the
statement, and the move must genuinely be in one transaction.

`registrations_segment_fk` stays immediate. A registration moving to another show changes `show_id`
and `segment_id` in the same row in one statement, so it never passes through an inconsistent state.

Both foreign keys target `unique` **constraints** rather than unique indexes — Postgres rejects a bare
unique index as a foreign key target.

Apply the same reasoning elsewhere: `player_allocations` is unique on `(player_id, segment_id)`,
`check_ins` needs no segment column because it derives from the attendee, and `portal_notes` (V2)
takes `unique (attendee_id)` to back "one note per attendee".

## 6. Configuration reference

The complete set of tunables. Each resolves segment → show → concert → system (`README.md` §2.2). Suggested seed values are
starting points written to `system_settings` at install — they are **not** defaults in code.

**Operational values — no code defaults.** These are entered per concert through the admin UI. The
system ships with no numeric default for any of them; a missing value is a validation error at save
time, not a silent fallback.

| Key | Level | Meaning |
|---|---|---|
| `capacity` | show | The hall. Segments must fit inside it; only an explicit admin override exceeds it |
| `segment.capacity` | segment | This segment's slice of the hall. Seats in no segment are held seats |
| `allocation.base_quota` | segment | Seats each active player is entitled to (PLAYER_INVITED only) |
| `allocation.base_claim_deadline` | segment | After this, unclaimed base releases into that segment's extras pool |
| `allocation.extras_policy` | segment | `REVIEW` (batch grant) or `AUTO_FCFS` (instant) |
| `allocation.allow_partial_grant` | segment | A boundary request may be granted in part |
| `form.max_tickets_per_response` | segment | **Total** party size cap, registrant included. The public repeater therefore renders `cap − 1` rows (`v2.md` §8.1.2) |
| `form.extra_rows_max` | segment | Rows in the "request extras" repeater |
| `portal.unlock_mode` | show | `ON_ADMISSION`, `OPEN_TO_ALL`, `CLOSED`. **Who** may see unlocked sections, nothing more — it is never flipped by a show reaching `COMPLETED` (`v2.md` §13.2.1) |
| `portal.booklet_enabled` | show | |
| `portal.notes_enabled` | concert | |
| `portal.notes_close_at` | concert | |
| `portal.feedback_enabled` | show | |
| `portal.feedback_close_at` | show | |
| `portal.public_wall_enabled` | concert | |
| `portal.public_wall_visibility` | concert | `ADMIN_ONLY` or `AUDIENCE` |
| `concert.timezone` | concert | IANA zone; all show times are stored UTC and rendered in it (§6.1) |

**System values — seeded, rarely changed.** These describe the runtime, not the event, so they do carry
install-time seeds.

Two of them sit at a show or concert **level** while still being runtime values, and they are listed
here rather than above because they are seeded: how long after a printed end time an evening counts as
over, and what hour of the day is a civil one to email people at. Neither is a capacity, a quota or a
deadline for this concert; both are overridden per show or per concert like anything else in the
cascade, and their seeds are `v2.md` §13.2.1's and §13.5.2's own worked figures.

| Key | Level | Seed | Meaning |
|---|---|---|---|
| `portal.note_max_length` | system | 1000 | V2 |
| `form.rate_limit_per_ip_per_min` | system | 5 | V2 |
| `form.verification_grace_hours` | system | 48 | Unverified public registrations older than this are flagged for admin review (`v2.md` §8.1.4) |
| `show.auto_complete_after_hours` | show | 2 | How long after `ends_at` the show counts as over — the portal's post-show phase and auto-completion both read it (`v2.md` §13.2.1). **Inert while `ends_at` is null.** Overridden per show and per concert |
| `portal.feedback_send_hour` | concert | 12 | Hour in `concert.timezone` at which queued feedback email becomes due (`v2.md` §13.5.2) |
| `form.seat_indicator_exact_below` | system | 20 | Below this the form shows a band, not a number (`v2.md` §8.3) |
| `auth.admin_max_attempts` | system | 5 | Admin sign-in attempts per IP before lockout (`admin.md` §14.3) |
| `auth.admin_lockout_window_min` | system | 15 | |
| `email.transport` | system | `gmail_smtp` | Active transport; alternatives are adapters, not rewrites |
| `email.max_per_dispatch` | system | 25 | Sized to stay inside the function timeout |
| `email.max_per_day` | system | 450 | Gmail free-account quota guard, counted in `concert.timezone` days (`email.md` §11.1) |
| `email.inter_message_delay_ms` | system | 400 | |
| `email.max_attempts` | system | 3 | |
| `email.merge_attachments_above` | system | 8 | Merge into one PDF past this many tickets |
| `email.max_attachment_mb` | system | 20 | Gmail's ceiling is 25MB; leave headroom |
| `ticket.default_template_id` | concert | seeded | |
| `checkin.manifest_ttl_hours` | system | 12 | Offline manifest lifetime after show start |
| `checkin.scan_debounce_ms` | system | 1500 | |
| `import.fuzzy_match_threshold` | system | 0.85 | Below this, a player match needs confirmation |
| `keepalive.enabled` | system | true | Daily DB ping that defeats the Supabase idle pause (`platform.md` §17.1) |
| `email.receipt_hold_minutes` | concert | 10 | V3. Hold before a receipt is due; repeat submissions inside it collapse (`v3.md` §25.3) |
| `review.auto_approve_clean` | segment | false | V3. Approve a party with no flags at submit (`v3.md` §25.4). Segment level is `show_segments.auto_approve_clean` |
| `review.duplicate_name_similarity` | system | 0.8 | V3. `pg_trgm` similarity at which names are a duplicate candidate (`v3.md` §25.5) |
| `delivery.review_single_party` | system | false | V3. Whether a one-party resend must pass the wizard's review steps (`v3.md` §24.1) |
| `admin.typed_confirm_above` | system | 20 | V3. Rows above which an irreversible command needs a typed phrase (`v3.md` §23.3) |
| `scheduler.tick_minutes` | system | 10 | V3. `pg_cron` interval for the tick, 1–59 (`v3.md` §27.2) |
| `scheduler.history_days` | system | 7 | V3. Retention for `pg_cron` and `pg_net` history (`v3.md` §27.2) |
| `inbox.match_fallback_days` | system | 30 | V3. Window for matching a reply by sender alone (`v3.md` §26.4) |
| `inbox.sync_budget_seconds` | system | 20 | V3. Share of the tick's time budget spent on inbox sync (`v3.md` §26.3) |

### 6.1 Time

All timestamps are stored as `timestamptz` in UTC. Every user-facing time renders in
`concert.timezone`. Never render a show time in the viewer's local zone — an audience member travelling
must see the time at the venue, not at home. Never store a naive timestamp.
