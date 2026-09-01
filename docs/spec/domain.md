# Domain model and configuration

*Tables, columns, keys and the configuration cascade. Every module reads this one.*

Part of the system specification — see [`README.md`](README.md) for the index, and
[`decisions.md`](decisions.md) before re-litigating anything here.

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
`id`, `concert_id`, `name`, `starts_at` (timestamptz), `doors_open_at`, `venue_name`, `venue_address`,
`capacity`,
`portal_unlock_mode` (ON_ADMISSION | OPEN_TO_ALL | CLOSED),
`status` (DRAFT|OPEN|CLOSED|COMPLETED), `ticket_template_id` (nullable),
`created_at`, `updated_at`, `deleted_at`

`ticket_template_id` resolves like any other cascading value: **show → concert
(`ticket.default_template_id`) → the seeded global default**. It is nullable precisely so a concert can
set one template for all its shows and a single show can override it. Never read the column directly.

The show owns the **physical hall**: one capacity number and the door. It carries no audience mode —
see segments below.

**One capacity, not three.** There is no separate soft threshold and no `held_seats` column. Seats you
want to withhold — staff, press, guests of honour — are simply seats you do not give to any segment:
if the hall is 400 and the segments total 390, ten seats are held, and the overview screen shows them
as unallocated. One number is easier to reason about at 9pm on a concert night than three.

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
`id`, `segment_id`, `round_label` (e.g. "Round 1"), `title`, `description_md`, `slug` (unique),
`schema` (jsonb — `v2.md` §8.2), `opens_at`, `closes_at`, `max_responses`,
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
Unique: `(id, segment_id, show_id)` — for the composite foreign key in §5.2

**`attendees`** — one row per seat
`id`, `registration_id`, `show_id`, `segment_id`,
`full_name`, `name_source` (PROVIDED|PLACEHOLDER), `email` (citext, nullable),
`allocation_type` (BASE|EXTRA|HELD|COMP),
`ticket_code` (unique), `qr_token` (unique),
`status` (CONFIRMED|PENDING_REVIEW|WAITLIST|CANCELLED),
`ticket_issued_at`, `ticket_sent_at`, `ticket_sent_source` (EMAIL|MANUAL, nullable),
`needs_reissue` (bool — set when a bound field changes after sending, `tickets.md` §10.6),
`ticket_template_id`, `ticket_template_version` (pinned at issue time — see `tickets.md` §10.5),
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

**`import_batches`**
`id`, `show_id`, `segment_id`, `filename`, `mapping_profile_id`, `uploaded_by`,
`row_count`, `created_count`, `skipped_count`, `error_count`,
`report` (jsonb), `status` (DRY_RUN|COMMITTED), `created_at`

**`mapping_profiles`**
`id`, `name`, `show_id` (nullable), `audience`, `config` (jsonb — `import.md` §9.3), `created_at`, `updated_at`

**`email_outbox`** — one row per *message*, and every message is addressed to a registration
`id`, `registration_id` (not null), `template_key`,
`to_email`, `to_name`,
`subject`, `body_md`, `context` (jsonb — the merge values the body was rendered from),
`attachment_paths` (jsonb array, nullable),
`status` (DRAFT|QUEUED|SENDING|SENT|FAILED|CANCELLED),
`attempts`, `last_error`, `scheduled_for`, `sent_at`, `created_at`, `updated_at`
Index: `(status, scheduled_for)`, `(registration_id)`

```sql
create unique index outbox_no_duplicate_pending
  on email_outbox (registration_id, template_key)
  where status in ('DRAFT', 'QUEUED', 'SENDING');
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

*(V2 note: `player_notes_digest` is the one player-addressed email. It arrives with V2 and adds a
nullable `player_id` and its own partial unique index; nothing above changes.)*

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
| `portal.note_max_length` | system | 1000 | V2 |
| `form.rate_limit_per_ip_per_min` | system | 5 | V2 |
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

### 6.1 Time

All timestamps are stored as `timestamptz` in UTC. Every user-facing time renders in
`concert.timezone`. Never render a show time in the viewer's local zone — an audience member travelling
must see the time at the venue, not at home. Never store a naive timestamp.
