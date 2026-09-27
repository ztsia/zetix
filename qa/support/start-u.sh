#!/usr/bin/env bash
# Seeds zetix_qa for module U (admin committee@example.test / qa-admin-pass, viewer mei@example.test / qa-viewer-pass,
# operator wei-ling@operators.invalid / qa-op-code), starts the SMTP sink, a real IMAP server (hoodiecrow),
# the stub GoTrue and `next dev` on :3100 with IMAP pointed at the local server.
set -euo pipefail
cd "$(dirname "$0")/../.."

export QA_DATABASE_URL="${QA_DATABASE_URL:-postgresql://postgres@localhost:55432/zetix_qa}"
export QA_ADMIN_EMAIL="committee@example.test"
export STUB_PORT="${STUB_PORT:-54321}"

SEED_JSON="$(QA_DATABASE_URL="$QA_DATABASE_URL" QA_ADMIN_EMAIL="$QA_ADMIN_EMAIL" node qa/support/seed-u.mjs)"
echo "$SEED_JSON" > /tmp/qa-u-seed.json
echo "seed: $SEED_JSON"
ALICE_ID="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("/tmp/qa-u-seed.json","utf8")).alice)')"

export STUB_USERS='[
  {"id":"11111111-1111-4111-8111-111111111111","email":"committee@example.test","password":"qa-admin-pass"},
  {"id":"33333333-3333-4333-8333-333333333333","email":"mei@example.test","password":"qa-viewer-pass"},
  {"id":"22222222-2222-4222-8222-222222222222","email":"wei-ling@operators.invalid","password":"qa-op-code"}
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
export GMAIL_APP_PASSWORD="qa-app-password"
export IMAP_HOST="127.0.0.1"
export IMAP_PORT="${IMAP_PORT:-1143}"
export IMAP_SECURE="false"
export SMTP_SINK_LOG=/tmp/qa-u-sink.jsonl

pkill -f qa/support/smtp-sink.mjs || true; pkill -f qa/support/smtp-sink-u.mjs || true
pkill -f qa/support/imap-u.mjs || true
pkill -f qa/support/gotrue-stub.mjs || true
node qa/support/smtp-sink-u.mjs > /tmp/qa-u-sink.log 2>&1 &
QA_ALICE_ID="$ALICE_ID" node qa/support/imap-u.mjs > /tmp/qa-u-imap.log 2>&1 &
node qa/support/gotrue-stub.mjs > /tmp/qa-u-stub.log 2>&1 &
if ! curl -sf http://localhost:3100/login > /dev/null; then
  pnpm exec next dev --port 3100 > /tmp/qa-u-dev.log 2>&1 &
  echo "dev pid $!"
fi
until curl -sf http://localhost:3100/login > /dev/null; do sleep 2; done
echo "dev server up"
for p in /login /admin/concerts/1/inbox /admin/concerts/1/audience "/admin/concerts/1/audience/$ALICE_ID"; do
  curl -so /dev/null "http://localhost:3100$p" || true
done
echo "warmed"
