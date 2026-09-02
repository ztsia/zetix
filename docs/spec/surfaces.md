*The four surfaces and the UI architecture that separates them.*

Part of the system specification — see [`README.md`](README.md) for the index, and
[`decisions.md`](decisions.md) before re-litigating anything here.

**Built by:** `F2` (the layouts). **Read by:** every module that ships a screen.
See [`../modules.md`](../modules.md) for what each label owns and when it runs.

---

# 15. Surfaces and UI architecture

Four surfaces, each with a different audience, device target, and auth model. They share a design
system and almost nothing else. Build them as separate route groups with separate layouts.

| # | Surface | Audience | Auth | Device target |
|---|---|---|---|---|
| 1 | **Admin console** | Committee | Supabase Auth, `ADMIN` | **Web-first**, responsive later |
| 2 | **Registration** | Players, public | Token in URL, or open | **Responsive** (most will be on phones) |
| 3 | **Door scanner** | Ushers | Supabase Auth, `OPERATOR` | **Mobile-first**, phone only |
| 4 | **Concert portal** | Admitted audience | Ticket token | **Mobile-first**, phone only |

## 15.1 Admin console (web-first)

Standard shadcn app shell: sidebar navigation, breadcrumb header, content area. Concert is selected
once and held in context, so every inner page is scoped to it.

Screens are listed in `admin.md` §14.1. The dominant pattern is **table + filters + row actions + a detail sheet**,
so build one good `DataTable` (TanStack Table + shadcn) with server-side pagination, column visibility,
and CSV export, then reuse it for registrations, attendees, players, notes, outbox and scan log. That
single component is most of the admin console.

Mobile responsiveness for admin is a nice-to-have. Tables degrade to cards below `md`; do not spend
build-week time on it.

## 15.2 Registration (responsive)

Single-column, no chrome, orchestra branding. One generic renderer drives both form types from the JSON
schema (`v2.md` §8.2) — do not build two forms.

Screens: form (with live seat indicator), confirmation, edit-existing-response, closed/full state,
public email-verification landing.

## 15.3 Concert portal (mobile-first)

Single column, large type, high contrast for a dark hall. Sections per `v2.md` §13.3, rendered by state.
Keep the payload small — this loads on venue wifi at the worst possible moment.

## 15.4 Door scanner (mobile-first) — borrow this IA from Hi.Events

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

Everything below the IA — the scanning library, offline manifest, feedback channels — is ours per `checkin.md` §12.
Read the structure, write the code fresh in shadcn.

## 15.5 Shared

One design system: shadcn/ui + Tailwind, one theme, one set of tokens, orchestra branding applied via
CSS variables so it can change per concert without code edits.
