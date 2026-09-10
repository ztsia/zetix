#!/usr/bin/env bash
# Seeds zetix_qa for module H, starts the stub GoTrue and `next dev` on :3100.
set -euo pipefail
cd "$(dirname "$0")/../.."

export QA_DATABASE_URL="${QA_DATABASE_URL:-postgresql://postgres@localhost:55432/zetix_qa}"
export QA_ADMIN_EMAIL="committee@example.test"
export STUB_PORT="${STUB_PORT:-54321}"

mkdir -p qa-artifacts/H-checkin-dashboard/screens
SEED_JSON="$(QA_DATABASE_URL="$QA_DATABASE_URL" QA_ADMIN_EMAIL="$QA_ADMIN_EMAIL" node qa/support/seed-h.mjs)"
echo "$SEED_JSON" > qa-artifacts/H-checkin-dashboard/seed.json
echo "seed: $SEED_JSON"

export STUB_USERS='[
  {"id":"11111111-1111-4111-8111-111111111111","email":"committee@example.test","password":"qa-admin-code"},
  {"id":"22222222-2222-4222-8222-222222222222","email":"wei-ling@operators.invalid","password":"qa-op-code"},
  {"id":"33333333-3333-4333-8333-333333333333","email":"no-shows@operators.invalid","password":"qa-op-code"}
]'

export NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:${STUB_PORT}"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="qa-anon-key"
# The stub accepts any key; provisioning needs the variable to be present at all.
export SUPABASE_SERVICE_ROLE_KEY="qa-service-role-key"
export ADMIN_EMAIL="$QA_ADMIN_EMAIL"
export APP_URL="http://localhost:3100"
export CRON_SECRET="qa-cron-secret"
export DATABASE_URL="$QA_DATABASE_URL"
export DIRECT_URL="$QA_DATABASE_URL"

node qa/support/gotrue-stub.mjs > /tmp/qa-h-stub.log 2>&1 &
echo "stub pid $!"
pnpm exec next dev --port 3100 > /tmp/qa-h-dev.log 2>&1 &
echo "dev pid $!"

until curl -sf http://localhost:3100/login > /dev/null; do sleep 2; done
echo "dev server up"
for p in /login /scan/login /admin/concerts; do curl -so /dev/null "http://localhost:3100$p" || true; done
echo "warmed"
