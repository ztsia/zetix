# Zetix

Orchestra concert ticketing. Free admission, unreserved seating, no payments.

**Read `CLAUDE.md` first**, then `spec.md` (the contract), `context.md` (this
concert's data), `ref.md` (background).

## Setup

```bash
pnpm install
cp .env.example .env.local     # fill in — see spec.md Appendix B
```

### Database

Two connection strings, not one — Supabase's direct host is IPv6-only on the
free plan and Vercel is IPv4, so both go through the pooler (`spec.md` §16.2):

| Variable | Port | Mode | Used by |
|---|---|---|---|
| `DATABASE_URL` | 6543 | transaction | the app (`prepare: false`) |
| `DIRECT_URL` | 5432 | session | `drizzle-kit` |

Development runs against a **local Postgres 16**, not Supabase — the allocation
engine needs only `citext`, `pg_trgm` and `pgcrypto` (`spec.md` §16.4):

```bash
pnpm db:local                  # start (idempotent); prints the DATABASE_URL
pnpm db:local:reset            # wipe and recreate
./scripts/local-db.sh psql     # a shell on it
```

## Working in the Claude Code cloud environment

Facts established by trying them, so they need not be rediscovered:

- **A local Postgres 16 is installed and runs**, with `citext`, `pg_trgm` and `pgcrypto`. `pnpm db:local`
  starts it; a SessionStart hook does so automatically. This is the whole development database.
- **Postgres is not reachable over the network from the container.** Supabase's direct host is
  IPv6-only and the container is IPv4, so `db.<ref>.supabase.co:5432` fails with *"Address family not
  supported"*. Generate migrations here, apply them from a machine that can reach the pooler.
  Consequently this environment never needs the production DB password or the service-role key.
- **There is no Docker daemon**, so the Supabase CLI's local stack is unavailable. The local Postgres
  above replaces it for everything except Auth, Storage and RLS, which are exercised on a Vercel
  preview.
- **Node's built-in `fetch` ignores `HTTPS_PROXY`.** Tools that use it — `shadcn` among them — need
  `NODE_USE_ENV_PROXY=1` prefixed, or they fail with an unhelpful "Request was cancelled".

## Commands

```bash
pnpm dev
pnpm test          # claim_seats tests must pass before anything ships
pnpm typecheck
pnpm db:generate   # drizzle migration from schema changes
pnpm db:migrate    # applies to DIRECT_URL
```

## Deployment

Vercel Hobby + Supabase Free + Gmail SMTP. Two cron jobs are configured
(`vercel.json`) and that is the Hobby allowance; a third keep-alive runs as a
GitHub Action, because the failure mode of a broken keep-alive is silent and
the database pauses after 7 days idle (`spec.md` §17.1).

Repo secrets needed for that workflow: `APP_URL`, `CRON_SECRET`.

> `APP_URL` is baked into every QR at issue time and cannot be recalled. It must
> be the Vercel **production alias**, never a deployment URL and never derived
> from `VERCEL_URL`. Do not rename or transfer the Vercel project once tickets
> have rendered — the project name is the hostname (`spec.md` §10.1).
