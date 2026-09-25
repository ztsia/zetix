#!/usr/bin/env bash
# Seeds zetix_qa for module R, starts the stub GoTrue and `next dev` on :3100.
set -euo pipefail
cd "$(dirname "$0")/../.."
export QA_DATABASE_URL="${QA_DATABASE_URL:-postgresql://postgres@localhost:55432/zetix_qa}"
export QA_ADMIN_EMAIL="committee@example.test"
export STUB_PORT="${STUB_PORT:-54321}"
if [ "${SKIP_SEED:-}" != 1 ]; then node qa/support/seed-r.mjs; fi
export STUB_USERS='[
  {"id":"11111111-1111-4111-8111-111111111111","email":"committee@example.test","password":"qa-admin-pass"},
  {"id":"44444444-4444-4444-8444-444444444444","email":"ana@example.test","password":"qa-ana-pass"},
  {"id":"33333333-3333-4333-8333-333333333333","email":"mei@example.test","password":"qa-viewer-pass"},
  {"id":"22222222-2222-4222-8222-222222222222","email":"wei-ling@operators.invalid","password":"qa-op-code"}
]'
export NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:${STUB_PORT}"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="qa-anon-key"
export SUPABASE_SERVICE_ROLE_KEY="qa-service-role-key"
export APP_URL="http://localhost:3100"
export CRON_SECRET="qa-cron-secret"
export DATABASE_URL="$QA_DATABASE_URL"
export DIRECT_URL="$QA_DATABASE_URL"
node qa/support/gotrue-stub.mjs > /tmp/qa-stub-r.log 2>&1 &
echo "stub pid $!"
pnpm exec next dev --port 3100 > /tmp/qa-dev-r.log 2>&1 &
echo "dev pid $!"
until curl -sf http://localhost:3100/login > /dev/null; do sleep 2; done
echo "dev server up"
