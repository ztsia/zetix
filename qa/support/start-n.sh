#!/usr/bin/env bash
# Seeds zetix_qa for module N, starts the stub GoTrue and `next dev` on :3100.
set -euo pipefail
cd "$(dirname "$0")/../.."

export QA_DATABASE_URL="${QA_DATABASE_URL:-postgresql://postgres@localhost:55432/zetix_qa}"
export QA_ADMIN_EMAIL="committee@example.test"
export STUB_PORT="${STUB_PORT:-54321}"

mkdir -p qa-artifacts/n-portal/screens
SEED_JSON="$(QA_DATABASE_URL="$QA_DATABASE_URL" node qa/support/seed-n.mjs)"
echo "$SEED_JSON" > qa-artifacts/n-portal/seed.json
echo "seed written to qa-artifacts/n-portal/seed.json"

export STUB_USERS='[
  {"id":"11111111-1111-4111-8111-111111111111","email":"committee@example.test","password":"qa-admin-code"}
]'

export NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:${STUB_PORT}"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="qa-anon-key"
export SUPABASE_SERVICE_ROLE_KEY="qa-service-role-key"
export ADMIN_EMAIL="$QA_ADMIN_EMAIL"
export APP_URL="http://localhost:3100"
export CRON_SECRET="qa-cron-secret"
export DATABASE_URL="$QA_DATABASE_URL"
export DIRECT_URL="$QA_DATABASE_URL"
# The booklet and ticket-artwork stores share one backend; a local directory
# keeps both reachable with no Supabase route (spec/tickets.md, `assets.ts`).
export TICKET_ASSET_DIR="${TICKET_ASSET_DIR:-/tmp/zetix-qa-assets}"
mkdir -p "$TICKET_ASSET_DIR"

node qa/support/gotrue-stub.mjs > /tmp/qa-n-stub.log 2>&1 &
echo "stub pid $!"
pnpm exec next dev --port 3100 > /tmp/qa-n-dev.log 2>&1 &
echo "dev pid $!"

until curl -sf http://localhost:3100/login > /dev/null; do sleep 2; done
echo "dev server up on http://localhost:3100"
