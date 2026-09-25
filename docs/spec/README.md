# Orchestra Concert Ticketing — System Specification

Status: draft v6

**This specification defines the system. It contains no concert-specific values.** Capacities, quotas,
player counts, dates and deadlines live in `../context.md` as data an admin enters, never as constants
in code. Any number appearing here is either a structural limit or an illustrative example explicitly
labelled as such.

It was one file until the V1 decomposition; it is now one file per module so that a session building
the scanner reads the scanner's spec rather than two thousand lines of everything.

Companion documents:

| File | Holds | Authority |
|---|---|---|
| `spec/` (this) | What the system does and how it behaves | The contract |
| `../context.md` | This orchestra's concert: real numbers, dates, delivery plan, open questions | The data |
| `../modules.md` | How V1 is cut into branches and what each owns | The work split |
| `../modules-v2.md` | The same for V2's six branches, `J`–`O` | The work split |
| `../modules-v3.md` | The same for V3's branches, `P`–`X` | The work split |
| `../ref.md` | Patterns distilled from Hi.Events, chiefly the door-scanner IA | Background |

---

## Contents

| File | Holds | Sections | Built by |
|---|---|---|---|
| `README.md` (this) | Context, principles, the build decision, scope, delivery | §1–§4, §18, Appendix C | everyone |
| `domain.md` | Data model, tables, keys, the configuration cascade | §5, §6 | F1 |
| `allocation.md` | Capacity, quotas, extras pool, `claim_seats()` | §7 | F1, B |
| `import.md` | Spreadsheet import and mapping profiles | §9 | C |
| `tickets.md` | Identifiers, the QR contract, template format, render | §10 | D, E |
| `email.md` | Transport, outbox, templates, blast idempotency | §11 | F |
| `checkin.md` | Scanner, offline tolerance, check-in dashboard | §12 | G, H |
| `admin.md` | Admin console structure, notes wall, roles | §14 | F2, A, H |
| `surfaces.md` | The four surfaces and their UI architecture | §15 | F2, all |
| `platform.md` | Stack, hosting, connection strings, env vars | §16, §17, Appendices A–B | F1, F2 |
| `v2.md` | Native forms, the portal and feedback — **specified, not built in V1** | §8, §13 | `J`–`O` |
| `v3.md` | One pipeline around the party: stages, queues, commands, send wizard, intake review, inbox, scheduler, roles — **specified, not built** | §20–§31 | `P`–`X` |
| `decisions.md` | Every settled decision and its reasoning | §19 | everyone |

**Section numbers are unchanged from the single-file spec** and are referenced throughout the
repository, so §7.3 is §7.3 wherever it now lives. `docs/modules.md` maps each build module to the
files above.

---

## 1. Context

Today registration runs on Google Forms. Each concert has several **shows**. Two audience models exist:

- **Player-invited** — every audience member is tied to a performing player. Players receive a base
  allocation of seats and may request extra seats with no per-player cap, granted first-come-first-served
  from a shared pool.
- **Public** — audience members register for themselves, with no player relationship.

**A show may carry both.** Audience mode belongs to a **segment** — a named slice of one show's
capacity — not to the show. A single evening in a single hall can hold a public block and a
player-invited block side by side, each with its own capacity, quota, deadline, policy and form. A
show with one audience simply has one segment. See `allocation.md` §7.1 and decision #5 in `decisions.md` §19.1.

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

## 2. Design principles

These govern every decision below. They are requirements, not style preferences.

### 2.1 Nothing operational is hardcoded

No capacity, quota, deadline, cap, or limit may appear as a literal in application code. Every one of
them is a stored, admin-editable value. Specifically forbidden as constants in code paths: hall
capacities, segment capacities, base quotas, player counts, party-size caps, batch sizes, rate limits,
and daily send caps.

The concrete values for a given concert live in `context.md` and are entered through the admin UI. If a
number from `context.md` appears anywhere in a `.ts` file, it is a bug.

The reference list of every configurable value lives in `domain.md` §6. If a new tunable is introduced, it goes in
that table and the cascade below — it does not go in a `const`.

### 2.2 Three-level configuration cascade

```
system_settings  →  concert.defaults  →  show.<field>  →  segment.<field>
   (global)          (per concert)        (per show)      (per segment, authoritative)
```

Every tunable is `NULL`-able at the concert, show and segment levels, resolving upward until a value
is found. The system level always has a value, so resolution can never fail. Reads go through one
resolver:

```ts
resolveSetting(key, { segmentId, showId, concertId })   // segment → show → concert → system
```

Allocation values (capacity, base quota, claim deadline, extras policy, party cap) are **segment**
values; the hall's own capacity is a **show** value. `domain.md` §6 states the level of every key.

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

1. **The door-scanner information architecture — genuinely worth copying.** See `surfaces.md` §15.4. It is the one
   piece of its UI that has been through real venue use.
2. **Domain modelling decisions** — dual identifiers, append-only check-ins, scoped operator access.
   Already extracted into this document; the file map is in `platform.md` Appendix B.
3. **Its admin IA — mostly not worth copying.** It is structured around products, orders, promo codes,
   organizers and payments. Our admin is a different, much smaller shape. Copying its navigation would
   import complexity we do not have.
4. **Its `TicketDesigner` — nothing to borrow.** Five files, a settings form with a live preview, not a
   canvas editor. Our `tickets.md` §10.3 is a different and more capable thing.

**Do not spend build-week hours browsing the repo.** `surfaces.md` §15 below gives the screen inventory directly,
which is faster than reverse-engineering it.

## 4. Scope

The system is delivered in two versions. **V1 is a complete, usable ticketing system on its own** — it
runs a real concert end to end. V2 adds the surfaces that assume registration has moved in-house.

The split follows one fact: registration is captured on Google Forms for both rounds of the first
concert, so every native-form feature can wait, while nothing in the ticket → email → door path can.

### 4.1 V1 — runs the concert

| Area | Included |
|---|---|
| Configuration | Concerts, shows, segments, the settings cascade (§2.2, `domain.md` §6) |
| People | Players (CRUD + CSV import), the shared admin account, operator accounts and show assignments |
| Allocation | The full engine: `claim_seats()`, base/extras, the extras review screen (`allocation.md` §7) |
| Intake | **Spreadsheet import** with mapping profiles (`import.md` §9), plus full manual registration CRUD (`allocation.md` §7.6) |
| Tickets | `ticket_code` / `qr_token`, canvas template editor, seeded defaults, PDF render (`tickets.md` §10) |
| Email | Outbox, draft-review-and-edit, Gmail SMTP, idempotent blasts, manual delivery marking (`email.md` §11) |
| Door | Offline-tolerant scanner, check-in dashboard, scan log with revert (`checkin.md` §12) |
| Ticket page | A **read-only status page at `/t/{qr_token}`** — name, show, date, doors, venue, QR |
| Admin | The console around all of the above, `DataTable`, exports, audit log (`admin.md` §14) |

The ticket status page is in V1 deliberately. Ticket holders scan their own QR out of curiosity, and
the URL is printed on something we told them is their ticket — a 404 there is a support call on concert
night. It is one read-only page reusing data the door already needs.

### 4.2 V2 — after the first concert

| Area | Included |
|---|---|
| Native registration | Three form kinds, the block-based builder, the JSON renderer, response limiting, editing (`v2.md` §8) |
| Public verification | Double opt-in, unverified-registration review (`v2.md` §8.1.4) |
| Full portal | Progressive disclosure on admission and after the show, e-booklet, practical info (`v2.md` §13) |
| Notes | Leaving notes, moderation, the wall, per-player grouping, digests (`v2.md` §13.4, `admin.md` §14.2) |
| Feedback | A post-show form, the admitted-only blast, show auto-completion (`v2.md` §13.5) |
| Rate limiting | Per-IP form and portal throttles (`v2.md` §8.3, `ref.md` §7) |

V2 features are specified in full below rather than deferred to a later document, because the V1 schema
must not need reshaping to accept them. Where a V1 table carries a column only V2 uses, it is marked.

That promise held for everything V1 shipped. It does **not** cover the refinement of 13 Sep, which
settled the form-builder shape, the feedback surface and show auto-completion and needs a schema delta
of its own — one migration, owned by module `J` and enumerated in `../modules-v2.md` §3. The V2 branch
map is `../modules-v2.md`; V1's is `../modules.md`.

### 4.4 V3 — one pipeline around one record

After the first concert the console was rebuilt around the party rather than around the modules that
built it. Scope, behaviour and the decisions it reverses are in `v3.md`; the branch map is
`../modules-v3.md`.

**Admin login rate limiting is V1**, not V2: it is the only credential guarding every attendee's name
and email (`admin.md` §14.3). The per-form and per-portal throttles wait because in V1 there are no public forms
and the portal is a single read-only page.

### 4.3 Out of scope entirely

Payments, pricing, refunds, seat selection or seat maps, waitlist auto-promotion emails, SMS, native
mobile apps, multi-organisation tenancy, i18n, public marketing pages.

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
- **A printed-ticket scan test blocks the first blast.** Render a real ticket, print it, and scan it
  with an actual usher phone — off paper and off a screen, in low light, with the phone offline
  (`tickets.md` §10.1). Everything downstream of the QR is unrecoverable once tickets are in inboxes, so this is a
  gate, not a checklist item.

## Appendix C — Hi.Events reference map

**Superseded by `ref.md`**, which writes out everything worth taking in enough detail that the source
is not needed. The table below is the file map behind those notes; do not vendor or copy from it.

| Topic | Path | Worth |
|---|---|---|
| **Scanner IA — bottom nav, tabs, detail sheet** | `frontend/src/components/layouts/CheckIn/` | **High** — copy the structure (`surfaces.md` §15.4) |
| Attendee identifiers (`short_id` + `public_id`) | `backend/app/DomainObjects/Generated/AttendeeDomainObjectAbstract.php` | Medium |
| Check-in as an append-only log | `backend/app/DomainObjects/Generated/AttendeeCheckInDomainObjectAbstract.php` | Medium |
| Scoped door-operator access | `backend/app/Http/Actions/CheckInLists/Public/` | Medium |
| Multi-date shows | `backend/app/Services/Domain/EventOccurrence/` | Low |
| Capacity assignment modelling | `backend/app/Services/Domain/CapacityAssignment/` | Medium |
| Email templating + token context | `backend/app/Services/Domain/Email/EmailTokenContextBuilder.php` | Medium |
| Waitlist handling | `backend/app/Services/Domain/Waitlist/` | Low |
| Ticket designer | `frontend/src/components/routes/event/TicketDesigner/` | **None** — a settings form, not a canvas editor |
