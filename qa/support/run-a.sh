#!/usr/bin/env bash
# QA harness for module A: stub GoTrue + seeded zetix_qa + playwright on :3100.
#
# Nothing under src/ is touched. Only NEXT_PUBLIC_SUPABASE_URL is repointed at
# the local stand-in, because a cloud container has no service-role key and no
# route to Supabase (docs/local.md §7).
set -euo pipefail
cd "$(dirname "$0")/../.."

export QA_DATABASE_URL="${QA_DATABASE_URL:-postgresql://postgres@localhost:55432/zetix_qa}"
export QA_ADMIN_EMAIL="committee@example.test"
export STUB_PORT="${STUB_PORT:-54321}"

SEED_JSON="$(QA_DATABASE_URL="$QA_DATABASE_URL" QA_ADMIN_EMAIL="$QA_ADMIN_EMAIL" node qa/support/seed-a.mjs)"
echo "seed: $SEED_JSON"
echo "$SEED_JSON" > qa-artifacts/A-config-and-people/seed.json

export STUB_USERS="$(node -e '
const u = [
  { id: "11111111-1111-4111-8111-111111111111", email: process.env.QA_ADMIN_EMAIL, password: "qa-admin-code" },
  { id: "22222222-2222-4222-8222-222222222222", email: "wei-ling@operators.invalid", password: "qa-op-code" },
  { id: "33333333-3333-4333-8333-333333333333", email: "no-shows@operators.invalid", password: "qa-op-code" },
];
console.log(JSON.stringify(u));
')"

node qa/support/gotrue-stub.mjs &
STUB_PID=$!
trap 'kill $STUB_PID 2>/dev/null || true; kill %2 2>/dev/null || true' EXIT
sleep 1

export NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:${STUB_PORT}"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="qa-anon-key"
export ADMIN_EMAIL="$QA_ADMIN_EMAIL"
export APP_URL="http://localhost:3100"
export CRON_SECRET="qa-cron-secret"
export DATABASE_URL="$QA_DATABASE_URL"
export DIRECT_URL="$QA_DATABASE_URL"

pnpm exec playwright test "$@"
