# Platform: stack and hosting

*Stack, hosting, connection strings, and the environment variables.*

Part of the system specification — see [`README.md`](README.md) for the index, and
[`decisions.md`](decisions.md) before re-litigating anything here.

**Built by:** `F1` (§16.2, §16.4) and `F2`. **Read by:** anyone touching runtime or deploy.
See [`../modules.md`](../modules.md) for what each label owns and when it runs.

---

## 16. Tech stack

| Concern | Choice | Note |
|---|---|---|
| Framework | Next.js 16, App Router, TypeScript | Server Actions for mutations, RSC for admin tables |
| UI | shadcn/ui + Tailwind | |
| DB / Auth / Storage | **Supabase** | One service for all three; the idle pause is handled by a keep-alive cron (§17.1) |
| Data access | Drizzle + `postgres.js`, **and one `supabase-js` `.rpc()` call** | Typed migrations; allocation logic is a raw SQL function. Two connection URLs — §16.2. Drizzle is not the *only* data path: the check-in manifest goes through PostgREST so the show-scope check runs in the database as well as in the handler (decision 20b, `checkin.md` §12.3, `drizzle/0003_manifest_rls.sql`). That is the one exception, and it is deliberately one |
| Email | **`nodemailer` + Gmail SMTP** | Node runtime, `maxDuration = 60` (`email.md` §11.1) |
| Spreadsheet | `sheetjs` | Client preview and server commit |
| QR generate / scan | `qrcode` / `@zxing/browser` | `BarcodeDetector` as an optional fast path — §16.3 |
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

**Postgres functions are used where they earn it.** `claim_seats()` (`allocation.md` §7.8) lives in the database
because it needs a row lock held across a read-then-write, and correctness there is worth more than
keeping all logic in one language. Reporting aggregates are plain SQL views. Everything else is a
Route Handler.

**Portability is deliberate.** Standard Postgres wire protocol, an S3-compatible storage API, plain
Next.js, and SMTP behind an interface. If any free tier changes, the stack moves to a €3.29/month VPS
with no code changes.

### 16.2 Two database connection strings, not one

Supabase's direct database host is **IPv6-only** on the free plan, and Vercel's functions are IPv4.
Connecting to it from the deployed app simply does not work. Both runtime and migrations therefore go
through Supavisor, the connection pooler, on different ports and in different modes:

| Use | Connection | Mode | Note |
|---|---|---|---|
| App runtime (`DATABASE_URL`) | pooler host, port `6543` | Transaction | `postgres.js` **must** set `prepare: false`; transaction pooling does not support prepared statements, and the symptom is intermittent "prepared statement already exists" under concurrency |
| Migrations (`DIRECT_URL`) | pooler host, port `5432` | Session | Session mode holds one backend for the connection, which DDL and advisory locks need |

Serverless also means many short-lived connections: keep the runtime pool small (`max: 1` per function
instance) and let the pooler do the multiplexing.

### 16.3 Barcode decoding: `@zxing/browser`, with a native fast path

`@zxing/browser` is a JavaScript port of the ZXing barcode library. It pulls frames from a `<video>`
element and decodes them in JS — it works in every browser, which is the property that matters.

Browsers now also ship a native `BarcodeDetector`, hardware-accelerated and faster. It is **not
available in Safari on iOS**, and iPhones will be at the door, so it cannot be the only implementation.

Build ZXing first, then feature-detect:

```ts
const decoder = 'BarcodeDetector' in globalThis ? nativeDecoder() : zxingDecoder();
```

Both feed the same token-extraction and manifest-lookup path (`tickets.md` §10.1), so the decoder is swappable and
the fallback is never a different code path with different bugs. Test on the actual usher phones
regardless — decoding speed on a mid-range Android is the thing that decides whether a queue forms.

### 16.4 Local development without Supabase

The allocation engine — `claim_seats()`, the `allocation.md` §7.3 worked example, concurrent-claim tests — needs a real
Postgres, not a mock, and it does **not** need Supabase. A plain local PostgreSQL 16 with `citext`,
`pg_trgm` and `pgcrypto` runs the entire schema, every migration, and the whole test suite offline.

That is the inner loop: generate migrations, apply them locally, run the tests. Supabase is only needed
for what is genuinely Supabase — Auth flows, Storage, and RLS policies — which are exercised against a
deployed preview rather than locally.

A useful consequence: the development environment never needs the production database password or the
service-role key.

### 16.5 Version facts that cost an hour each

The libraries here are recent enough that their published documentation, and most training data,
describes a previous major. Each of these was found the expensive way while building `F2`.

| Fact | Why it bites |
|---|---|
| **`middleware.ts` is `proxy.ts` in Next 16.** Same behaviour, new file and export name. | The old name is silently inert — no error, no route protection. |
| **These are Base UI components, not Radix.** `Checkbox` takes a separate `indeterminate` prop, not `checked="indeterminate"`. Triggers take `render={<Button/>}` where Radix took `asChild`. | A three-state checkbox renders as plain unchecked. |
| **`DropdownMenuLabel` is Base UI's `Menu.GroupLabel` and throws unless wrapped in a `DropdownMenuGroup`.** | The whole menu renders empty, with the error only in the browser console — it looks like a click that does nothing. |
| **TanStack Table is v9, not the v8 the shadcn docs describe.** Features, row models and sort/filter functions are composed statically via `tableFeatures({…})`; `getState()` is gone — read `table.state`. A `/legacy` shim exists; do not reach for it. | v8 examples typecheck-fail in confusing ways, or compile and do nothing. |
| **A `'use server'` file may export only async functions.** A plain constant beside the actions fails the build, pointing at the wrong line. | Costs a build cycle to locate. |
| **`server-only` throws under Vitest**, which does not select the `react-server` condition. It is aliased to a stub in `vitest.config.ts`. It also throws under `tsx`, so a script importing a guarded module cannot use it. | Every test importing a guarded server module fails at import. |
| **Drizzle's `asc()` cannot wrap `nulls last`** — it emits `order by … nulls last asc`, which Postgres rejects at runtime while typecheck and build both pass. Write the whole sort spec in `` sql`` ``. | A 500 that no static check catches. |
| **A browser download needs its anchor in the document.** A detached `<a download>` click is ignored by Chromium: no file, no error. | An export button that appears to do nothing. |
| **Read `cookies()` before asserting on the environment** in any module a page reaches during render. Reading it is what marks the render dynamic; throwing first aborts `next build`'s prerender pass instead of bailing out to dynamic. | The build fails wherever Supabase variables are absent — CI among them. |
| **Postgres grants `execute` on a new function to `PUBLIC` by default.** A `security definer` function is callable by `anon` — the publishable key — until you `revoke all … from public`. | The function *is* the security boundary, and it ships open. |
| **`sha256()` is core Postgres; `digest()` is pgcrypto, and on Supabase pgcrypto lives in the `extensions` schema.** A function with `search_path` pinned to `public, pg_temp` cannot see `digest()` there, though it works locally where the extension landed in `public`. | Passes every local test, fails only in production. |

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

- **Vercel Hobby crons run only on Production deployments**, fire within roughly an hour of the
  scheduled time, and are limited in both number and frequency (daily). Both timing points are
  irrelevant at daily-versus-weekly margins, but the **budget is not**: the keep-alive and the outbox
  safety net (`email.md` §11.2) consume the allowance between them. Confirm the current Hobby limit before adding
  a third scheduled job — and note that the GitHub Actions cron below is therefore not only a
  redundancy, it is also the route to any further scheduled work.
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

## Appendix B — Environment variables

| Variable | Used by | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | client + server | |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | client | RLS-protected access only. Newer dashboards label this the **publishable key** (`sb_publishable_…`); it is the same thing and is public by design — it ships in the browser bundle |
| `SUPABASE_SERVICE_ROLE_KEY` | server only | **Never expose to the client.** Bypasses RLS. Newer dashboards label this the **secret key** (`sb_secret_…`). Never paste it into a chat, an issue, or a commit |
| `DATABASE_URL` | server | App runtime. Supabase **pooler**, port `6543`, transaction mode, `prepare: false` (§16.2) |
| `DIRECT_URL` | migrations | Supabase **pooler**, port `5432`, session mode. Used by `drizzle-kit` only (§16.2) |
| `GMAIL_USER` | server | Sending address |
| `GMAIL_APP_PASSWORD` | server | App password, not the account password; requires 2FA |
| `APP_URL` | server | Absolute base for QR URLs and email links; must be the production origin |
| `CRON_SECRET` | server | Shared secret checked by `/api/health` and dispatch routes so they are not openly callable |
| `ADMIN_EMAIL` | server | Constant address behind the code-only admin login (`admin.md` §14.3) |
| `BOOTSTRAP_ADMIN_PASSWORD` | script | The initial shared admin code; rotate from the UI afterwards |

`APP_URL` deserves care: it is baked into every QR code at issue time and cannot be recalled. Set it
before the first render, not before the first send.

This project uses the Vercel **production alias** `<project>.vercel.app` rather than a custom domain
(`tickets.md` §10.1). Two consequences follow, and both are absolute:

- **Never derive it from `VERCEL_URL`.** That variable holds the per-deployment hostname, which is dead
  within days. `APP_URL` is a hardcoded environment variable in the Production environment.
- **Never rename or transfer the Vercel project** once tickets have rendered. The project name *is* the
  hostname.

If it is nevertheless wrong, admission still works: the scanner treats the QR as opaque data and never
resolves the URL (`tickets.md` §10.1). Only the ticket status page breaks.
