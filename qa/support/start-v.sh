#!/usr/bin/env bash
# Seeds zetix_qa for module V (admin committee@example.test / qa-admin-pass, viewer mei@example.test / qa-viewer-pass), starts the stub GoTrue and `next dev` on :3100.
# Same shape as start-a.sh; the seed and the warmed routes are what differ.
set -euo pipefail
cd "$(dirname "$0")/../.."

export QA_DATABASE_URL="${QA_DATABASE_URL:-postgresql://postgres@localhost:55432/zetix_qa}"
export QA_ADMIN_EMAIL="committee@example.test"
export STUB_PORT="${STUB_PORT:-54321}"

export QA_SCHEMAS="${QA_SCHEMAS:-/tmp/qa-v-schemas.json}"
pnpm -s exec tsx -e "import {blankFormSchema} from './src/lib/forms/templates'; require('fs').writeFileSync(process.env.QA_SCHEMAS, JSON.stringify({PUBLIC: blankFormSchema('PUBLIC'), PLAYER: blankFormSchema('PLAYER')}))"
SEED_JSON="$(QA_SCHEMAS="$QA_SCHEMAS" QA_DATABASE_URL="$QA_DATABASE_URL" QA_ADMIN_EMAIL="$QA_ADMIN_EMAIL" node qa/support/seed-v.mjs)"
echo "$SEED_JSON" > /tmp/qa-v-seed.json
echo "seed: $SEED_JSON"

export STUB_USERS='[
  {"id":"11111111-1111-4111-8111-111111111111","email":"committee@example.test","password":"qa-admin-pass"},
  {"id":"33333333-3333-4333-8333-333333333333","email":"mei@example.test","password":"qa-viewer-pass"},
  {"id":"22222222-2222-4222-8222-222222222222","email":"wei-ling@operators.invalid","password":"qa-op-code"},
  {"id":"44444444-4444-4444-8444-444444444444","email":"bob@operators.invalid","password":"qa-op-code-2"}
]'

export NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:${STUB_PORT}"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="qa-anon-key"
export SUPABASE_SERVICE_ROLE_KEY="qa-service-role-key"
export ADMIN_EMAIL="$QA_ADMIN_EMAIL"
export APP_URL="http://localhost:3100"
export CRON_SECRET="qa-cron-secret"
export DATABASE_URL="$QA_DATABASE_URL"
export DIRECT_URL="$QA_DATABASE_URL"
export SMTP_HOST="127.0.0.1"
export SMTP_PORT="${SMTP_PORT:-2526}"
export SMTP_SECURE="false"
export GMAIL_USER="tickets@example.test"
export FORM_ASSET_DIR=/tmp/qa-v-form-assets
mkdir -p "$FORM_ASSET_DIR"
export SMTP_SINK_LOG=/tmp/qa-v-sink.jsonl
node qa/support/smtp-sink.mjs > /tmp/qa-v-sink.log 2>&1 &
echo "sink pid $!"

node qa/support/gotrue-stub.mjs > /tmp/qa-v-stub.log 2>&1 &
echo "stub pid $!"
pnpm exec next dev --port 3100 > /tmp/qa-v-dev.log 2>&1 &
echo "dev pid $!"

until curl -sf http://localhost:3100/login > /dev/null; do sleep 2; done
echo "dev server up"
for p in /login /admin/concerts /f/qa-autumn /f/qa-players /admin/concerts/3/forms /admin/concerts/3/import /admin/concerts/3/audience; do
  curl -so /dev/null "http://localhost:3100$p" || true
done
echo "warmed"
