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
