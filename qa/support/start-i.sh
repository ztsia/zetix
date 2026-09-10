#!/usr/bin/env bash
# Seeds zetix_qa for module I and starts `next dev` on :3100.
#
# `/t/{token}` needs no auth at all — possession of the token is the credential
# (spec/v2.md §13.3) — so the GoTrue stub is started only so that the one flow
# that signs an ADMIN in has somewhere to sign in to.
set -euo pipefail
cd "$(dirname "$0")/../.."

export QA_DATABASE_URL="${QA_DATABASE_URL:-postgresql://postgres@localhost:55432/zetix_qa}"
export STUB_PORT="${STUB_PORT:-54321}"

mkdir -p qa-artifacts/I-ticket-status-page/screens
SEED_JSON="$(QA_DATABASE_URL="$QA_DATABASE_URL" node qa/support/seed-i.mjs)"
echo "$SEED_JSON" > qa-artifacts/I-ticket-status-page/seed.json
echo "seed: $SEED_JSON"

export STUB_USERS='[
  {"id":"11111111-1111-4111-8111-111111111111","email":"committee@example.test","password":"qa-admin-code"}
]'
export NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:${STUB_PORT}"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="qa-anon-key"
export SUPABASE_SERVICE_ROLE_KEY="qa-service-role-key"
export ADMIN_EMAIL="committee@example.test"
# The production alias, exactly as spec/tickets.md §10.1 Rule A requires — this
# is the origin the rendered QR must carry.
export APP_URL="https://zetix.vercel.app"
export CRON_SECRET="qa-cron-secret"
export DATABASE_URL="$QA_DATABASE_URL"
export DIRECT_URL="$QA_DATABASE_URL"

node qa/support/gotrue-stub.mjs > /tmp/qa-i-stub.log 2>&1 &
echo "stub pid $!"
pnpm exec next dev --port 3100 > /tmp/qa-i-dev.log 2>&1 &
echo "dev pid $!"

until curl -sf http://localhost:3100/api/health > /dev/null; do sleep 2; done
echo "dev server up"
curl -so /dev/null "http://localhost:3100/t/IssuedAAAAAAAAAAAAAA01" || true
echo "warmed"
