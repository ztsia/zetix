*The admin console: structure, the notes wall, roles and accounts.*

Part of the system specification — see [`README.md`](README.md) for the index, and
[`decisions.md`](decisions.md) before re-litigating anything here.

**Built by:** `F2` (shell and auth), `A` (config screens) and `H` (operators, §14.3).
See [`../modules.md`](../modules.md) for what each label owns and when it runs.

---

# 14. Admin

## 14.1 Structure

```
/admin
  /concerts                    list, create, archive
  /concerts/{id}
    /overview                  capacity across all shows, at-a-glance status
    /shows                     CRUD; capacity, quota, deadline, policy, portal mode per show
    /players                   CRUD, CSV import, invite links, resend/rotate tokens
    /forms                     block builder, preview, open/close, responses, export (`v2.md` §8.2)
    /registrations             searchable table + full manual CRUD (`allocation.md` §7.5)
    /extras-review             the batch grant screen, per segment (`allocation.md` §7.5)
    /import                    upload → map → validate → commit
    /tickets                   template editor, bulk regenerate, preview
    /email                     templates, outbox, blast (with round dedup, `email.md` §11.4), send log
    /checkin                   live dashboard, scan log
    /operators                 provision operators, assign shows, reset codes, deactivate
    /portal                    booklet upload, practical info, unlock mode, per-section flags
    /notes                     wall + per-player grouping (§14.2)
    /feedback                  post-show form, responses, blast (`v2.md` §13.5)
    /exports                   CSV/XLSX of any table view
  /settings                    users, roles, system defaults, SMTP test, audit log
```

## 14.2 Notes wall

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

## 14.3 Roles and accounts

Two populations, deliberately asymmetric.

| | `ADMIN` | `OPERATOR` |
|---|---|---|
| How many | **Exactly one, shared** | One per usher |
| Sign-in | A single secret code | Display name + access code |
| Created by | `bootstrap-admin` script, once | The admin, from `/admin/operators` |
| Scope | Everything, all shows | Only assigned shows |
| Can | All admin functions | Sign in, select an assigned show, scan, check in, search attendees within that show |
| Cannot | — | Edit any data, export, view PII beyond name and ticket status, or reach an unassigned show |

Players and audience members never have accounts — they hold unguessable tokens (`v2.md` §8.1, `v2.md` §13).

### The shared admin account

> **Superseded in V3** by named `ADMIN` and `VIEWER` accounts with email and password
> (`v3.md` §28, decision 50). This section describes V1 and V2.

The committee shares one login. This removes admin user management entirely, at two costs worth stating
plainly:

- **`audit_log` records what and when, but not who.** Every override, capacity change and manual
  registration is attributed to the one admin account. The schema already supports individual admin
  accounts if attribution is ever wanted — add rows with `role = ADMIN` and nothing else changes.
- **The code is the entire security boundary** for every attendee's name and email. So: generate a long
  random passphrase rather than choosing a memorable one, rate-limit the login route hard
  (`auth.admin_max_attempts` per IP per `auth.admin_lockout_window_min`, then a growing lockout), and
  rotate it after each concert and whenever someone leaves the committee. Rotation is a one-field
  change on the admin account.

**Login UX.** The form asks for the code only. The admin email is a constant held server-side, so nobody
has to remember an address — but it is still a real Supabase Auth password sign-in underneath, not a
bespoke cookie. Do not invent a custom session mechanism for this.

### Supabase project settings this auth model depends on

Two dashboard settings are part of the security boundary, not preferences, and
neither is correct by default on a new project:

- **Disable public sign-ups** (Authentication → Sign In / Providers → *Allow new
  users to sign up* → off). Nobody in this system ever self-registers: there is
  exactly one `ADMIN`, created once by `scripts/bootstrap-admin.ts`, and every
  `OPERATOR` is provisioned by the admin (§14.3). The publishable key is public
  by design — it ships in the browser bundle — so leaving sign-ups on means
  anyone who views source can create an account in the project. Turn it off
  before the first deploy and keep it off.
- **Email confirmation stays on**, which is why operator users must be created
  through the Supabase admin API with `email_confirm: true`. Their addresses are
  synthetic (`<slug>@operators.invalid`) and can never receive a confirmation
  mail, so an operator created any other way can never sign in (`checkin.md` §12.1).

### Why not anonymous sign-in, or our own id/password pair

Both look simpler than a synthetic address and both cost more.

**Supabase anonymous sign-in** issues a session without authenticating anyone — `signInAnonymously()`
succeeds for any caller. The secret code would therefore have to be checked by *us*: our hashing, our
comparison, our rate limiting, our lockout, and finally our code assigning `role = 'OPERATOR'`. A bug
anywhere in that path is privilege escalation onto the full attendee roster. It also requires anonymous
sign-in enabled project-wide, so anyone holding the publishable key — which ships in the browser
bundle — can mint auth rows without limit.

**A bare id/password pair of our own** means hand-writing password hashing, session issuance, refresh,
revocation and lockout, on the one surface guarding every attendee's name and email, for a login screen
the operator cannot tell apart from this one.

The property worth keeping is the split: **Supabase decides authentication, we decide only
authorisation.** A synthetic email is what buys it, and it costs one line to construct and one field to
create.

**Disabling email confirmation project-wide changes nothing here**, because public sign-ups are off
(above). Client-side `signUp()` is blocked, so operators are created through the admin API either way —
and that is where `email_confirm: true` lives. Leaving confirmation on costs one field and means a
future sign-up misconfiguration cannot immediately mint usable accounts.

### Provisioning operators

`/admin/operators` lists operators with their assigned shows, check-in counts and last sign-in. Creating
one generates a display name slug and a random access code, shown **once** on screen for the admin to
pass on. Codes can be regenerated; operators can be deactivated, which invalidates their session at the
next request.

**There is no delete, and the list defaults to hiding deactivated accounts.** Deactivation is the
retirement path: `check_ins.operator_id` is `on delete set null`, so removing the row would anonymise
every scan that usher recorded, and Supabase Auth would keep the address either way — blocking the
name for anyone provisioned after them. Accounts are also global rather than per concert, so the list
only grows. A status filter next to the search box carries the count of each group, defaults to
**Active**, and offers Deactivated and All; reactivating is a row action, not a database task.

Assignment is a checkbox grid of shows per operator, editable at any time. Revoking an assignment takes
effect immediately on the server, including for a device that is currently offline — its queued scans
are rejected on sync and surfaced to the admin rather than silently dropped.
