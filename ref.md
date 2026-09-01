# Reference notes — distilled from Hi.Events

**Read this instead of the Hi.Events source.** Everything worth taking from that codebase is written
out below in enough detail to build from. The source is a 93k-LOC Laravel + 94k-LOC Vite/React
application; reading it costs context and yields patterns expressed in a stack we are not using.

This is a companion to `spec.md`. `spec.md` is authoritative for what to build; this file explains a
handful of design decisions that were validated by a mature product, so we do not re-derive them.

**Licence note.** Hi.Events is AGPL-3.0. These are described patterns and architectural decisions, not
copied code. Do not vendor, clone, or paste from that repository into this one.

---

## 1. The door scanner — take this whole shape

The one piece of Hi.Events' UI that has been through real venue use. Build our scanner to this shape.

### 1.1 Layout

A full-height mobile app shell with **bottom tab navigation**, three tabs. No hamburger, no top nav —
everything the usher touches is in the bottom third of the screen, reachable one-handed while holding a
phone and a stack of programmes.

```
┌─────────────────────────────┐
│  [Show: Sat Evening ▾]      │  ← persistent show pill, always visible
├─────────────────────────────┤
│                             │
│      camera viewfinder      │  ← full-bleed, minimal chrome
│      (or tab content)       │
│                             │
├─────────────────────────────┤
│   Scan  │  Search  │  Stats │  ← bottom tabs
└─────────────────────────────┘
```

### 1.2 The three tabs

**Scan** — full-bleed camera viewfinder. The scan result appears as an overlay on top of the camera,
not as a navigation event, so the camera never stops. Overlay auto-dismisses after ~2s on success, and
stays until dismissed on amber/red so the usher can read it.

**Search** — name and ticket-code lookup, for when a QR will not read (cracked screen, printed too
small, dead phone battery). This tab is not optional. At a real door, several people per hundred cannot
present a scannable code, and without this tab the queue stops. Searching runs against the same local
manifest as scanning, so it works offline.

**Stats** — checked in / expected / remaining for the selected show, live. The person running the door
needs this to decide when to stop holding seats.

### 1.3 The show pill

A persistent control in the header showing which show the usher is admitting to, tappable to change.
Not buried in settings. With three shows in a weekend, an usher on the wrong show silently rejects every
valid ticket, and the pill is what makes that mistake visible before it happens.

### 1.4 Attendee detail as a bottom sheet

When the usher taps a result, detail opens in a **bottom sheet** — not a modal, not a route change. The
camera stays mounted behind it. Re-initialising a camera stream costs 1–3 seconds on mid-range Android,
which at a door with 400 people arriving in 20 minutes is the difference between a queue and a crowd.

This is the single most valuable detail in this document. Do not use a route change here.

### 1.5 What Hi.Events does *not* do that we must

- No offline manifest — it assumes venue connectivity. Ours does not (`spec.md` §12.3).
- No sound or haptic feedback — colour only. Ours adds both (`spec.md` §12.2).
- Its check-in is per check-in-list with product filtering; ours is simply per show.

---

## 2. Identifier pattern — two IDs, different jobs

Hi.Events carries **both** a `short_id` and a `public_id` on attendees, and the split is correct.

| | Purpose | Properties |
|---|---|---|
| `short_id` | Spoken aloud, printed, typed into a search box | Short, human-readable, unambiguous alphabet |
| `public_id` | Embedded in URLs that grant access | Long, high-entropy, unguessable |

The mistake this avoids: using one identifier for both. A code short enough to read over the phone is
short enough to enumerate, and an ID long enough to be unguessable is unusable at a door.

Our equivalents are `ticket_code` and `qr_token` (`spec.md` §10.1). The QR carries only `qr_token`; the
printed ticket shows `ticket_code` for the Search tab.

---

## 3. Check-in as an append-only log

Hi.Events models check-in as rows in `attendee_check_ins`, not a boolean on the attendee. The table
carries `attendee_id`, `check_in_list_id`, `event_id`, `ip_address`, timestamps, and a soft-delete
column.

Why this is right:

- **A scan log falls out for free.** Who admitted whom, when, from which device.
- **Reversal is non-destructive.** An accidental check-in is undone by marking the row, not by flipping
  a boolean back and losing the fact that it happened.
- **Double scans become visible data** rather than a silently ignored no-op. With two ushers scanning
  offline on separate phones, the duplicate is the thing you want recorded, not suppressed.
- **Re-entry is expressible** without schema change (interval, stepping outside) — just another row.

Our `check_ins` table follows this, adding `device_id`, `source` (ONLINE / OFFLINE_SYNC / MANUAL), and
`override_reason` for the admit-anyway path.

---

## 4. Scoped operator access

Hi.Events exposes check-in through a separate public, token-scoped surface
(`CheckInLists/Public/…`) rather than giving door staff an admin login. The operator credential grants
scanning and nothing else.

Take the principle: **a volunteer usher's phone should not be able to read the attendee list, export
data, or edit a registration.** Our `OPERATOR` role sees name and ticket status, and nothing more
(`spec.md` §14.3). Assume at least one usher phone will be left unlocked on a table.

---

## 5. Capacity as a separate assignable concept

Hi.Events keeps capacity in its own entity that can apply across several ticket types, rather than as a
column on the ticket. That generality is more than we need — our capacity is per show — but one idea
carries over: **capacity is evaluated at claim time against a live count, never cached on a row.**

Our `claim_seats()` (`spec.md` §7.8) recomputes `confirmed`, `unclaimed_base` and `extras_pool` inside a
row lock on every claim. Do not denormalise a `seats_remaining` counter onto `shows`. It will drift, and
the drift only surfaces as an oversell on the night.

---

## 6. Email token context

Hi.Events builds a documented context object per template (`EmailTokenContextBuilder`) and exposes the
available tokens in the admin UI beside the editor, with a preview endpoint that renders a template
against real data.

Two things worth copying:

- **The token list is enumerated and shown to the admin.** Not documented in a wiki, not guessed —
  rendered next to the field they are editing.
- **Preview renders against a real record**, not a lorem-ipsum stub. Template bugs are almost always
  data-shape bugs (a null player on a public registration, a 40-character name), and only real data
  surfaces them.

Same principle applies to our ticket template bindings (`spec.md` §10.2): bindings are picked from an
enumerated list, never free-typed, and preview runs against a real attendee — including a "longest name
in this show" mode.

---

## 7. Public self-service by token, without accounts

Hi.Events lets an order holder view and edit their order through
`/{entity}/{id}/{short_id}` URLs with no login, rate-limited per route.

This is the right call for an audience-facing surface: accounts are friction, and for a
once-a-year concert nobody will remember a password. Possession of an unguessable token is the
credential.

What comes with it, and what we must also do:

- Rate limit every tokenised route (Hi.Events uses per-route throttles as tight as 5/min on
  self-service edit and email-resend paths).
- `noindex` on every tokenised page.
- Never expose PII beyond the holder's own record.
- Make tokens rotatable, so a leaked link can be killed.

---

## 8. Things Hi.Events does that we should *not* copy

| Pattern | Why not |
|---|---|
| Its admin information architecture | Built around products, orders, promo codes, organizers, payouts. Our admin has none of those. Copying its nav imports complexity we do not have. |
| `TicketDesigner` | Five files: a settings form with a live preview. Not a canvas editor. Our §10.3 is a different and more capable thing — there is nothing to take. |
| Order → OrderItem → Attendee chain | A pricing/payment structure. Ours is `registration → attendee`, and the middle layer would be dead weight. |
| Domain-object code generation | Solves a problem Laravel has. Drizzle already gives us typed schema inference. |
| Its queue-worker-dependent side effects | Assumes an always-on worker. We are serverless; our outbox is admin-dispatched (`spec.md` §11.2). |
| Multi-tenant SaaS mode, application fees, Stripe Connect | Irrelevant to a free concert, and load-bearing in its order lifecycle. |

---

## 9. If you genuinely need to look at the source

You should not need to. If something in §1 is ambiguous, the paths are below — read the file, do not
copy it. Nothing here is a licence to vendor AGPL code into this repository.

| Topic | Path in HiEventsDev/hi.events |
|---|---|
| Scanner shell, tabs, bottom sheet, show pill | `frontend/src/components/layouts/CheckIn/` |
| Attendee identifiers | `backend/app/DomainObjects/Generated/AttendeeDomainObjectAbstract.php` |
| Check-in log | `backend/app/DomainObjects/Generated/AttendeeCheckInDomainObjectAbstract.php` |
| Scoped operator endpoints | `backend/app/Http/Actions/CheckInLists/Public/` |
| Capacity assignment | `backend/app/Services/Domain/CapacityAssignment/` |
| Email token context | `backend/app/Services/Domain/Email/EmailTokenContextBuilder.php` |