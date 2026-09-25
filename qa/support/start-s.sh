#!/usr/bin/env bash
# Seeds zetix_qa for module S, starts the stub GoTrue and `next dev` on :3100.
# Same shape as start-a.sh; the seed and the warmed routes are what differ.
set -euo pipefail
cd "$(dirname "$0")/../.."

export QA_DATABASE_URL="${QA_DATABASE_URL:-postgresql://postgres@localhost:55432/zetix_qa}"
export QA_ADMIN_EMAIL="committee@example.test"
export STUB_PORT="${STUB_PORT:-54321}"

SEED_JSON="$(QA_DATABASE_URL="$QA_DATABASE_URL" QA_ADMIN_EMAIL="$QA_ADMIN_EMAIL" node qa/support/seed-s.mjs)"
echo "seed: $SEED_JSON"

export STUB_USERS='[
  {"id":"11111111-1111-4111-8111-111111111111","email":"committee@example.test","password":"qa-admin-code"},
  {"id":"22222222-2222-4222-8222-222222222222","email":"wei-ling@operators.invalid","password":"qa-op-code"}
]'

export NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:${STUB_PORT}"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="qa-anon-key"
export ADMIN_EMAIL="$QA_ADMIN_EMAIL"
export APP_URL="http://localhost:3100"
export CRON_SECRET="qa-cron-secret"
export DATABASE_URL="$QA_DATABASE_URL"
export DIRECT_URL="$QA_DATABASE_URL"

node qa/support/gotrue-stub.mjs > /tmp/qa-stub.log 2>&1 &
echo "stub pid $!"
pnpm exec next dev --port 3100 > /tmp/qa-dev.log 2>&1 &
echo "dev pid $!"

until curl -sf http://localhost:3100/login > /dev/null; do sleep 2; done
echo "dev server up"
for p in /login /admin/concerts /admin/concerts/1/audience /admin/concerts/1/audience/1; do
  curl -so /dev/null "http://localhost:3100$p" || true
done
echo "warmed"
