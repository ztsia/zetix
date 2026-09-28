#!/usr/bin/env bash
# QA module V, AC-33: real concurrency on the form's submit, two processes.
#   qa/support/v-race.sh same-email [hold]    two submissions from one address
#   qa/support/v-race.sh last-seat  [hold]    two parties for the last seat
# With `hold`, a third session holds the show row first so both submits queue
# on lockShowForClaim() and are released together.
set -uo pipefail
cd "$(dirname "$0")/../.."
export DATABASE_URL="${DATABASE_URL:-postgresql://postgres@localhost:55432/zetix_qa}"
export RACE_STATE="${RACE_STATE:-/tmp/v-race-state.json}"
export RACE_CASE="${1:-same-email}"
HOLD="${2:-}"
V="pnpm -s vitest run --config qa/vitest.qa.config.ts qa/backend/v-race.test.ts --silent=false"
RACE_ROLE=setup $V >/dev/null 2>&1 || { echo setup failed; exit 1; }
SHOW=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$RACE_STATE')).showId)")
SEG=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$RACE_STATE')).seg)")
if [ -n "$HOLD" ]; then
  psql "$DATABASE_URL" -q -c "begin; select id from shows where id=$SHOW for update; select pg_sleep(12); commit;" >/dev/null &
  sleep 1
fi
rm -f "$RACE_STATE".a "$RACE_STATE".b
RACE_ROLE=a $V >/dev/null 2>&1 &
RACE_ROLE=b $V >/dev/null 2>&1 &
if [ -n "$HOLD" ]; then
  ( sleep 9; psql "$DATABASE_URL" -Atc "select 'sessions waiting on a lock: ' || count(*) from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()" ) &
fi
wait
cat "$RACE_STATE".a "$RACE_STATE".b 2>/dev/null
psql "$DATABASE_URL" -Atc "select 'parties: ' || count(*) || '  live seats: ' || (select count(*) from attendees where segment_id = $SEG and deleted_at is null and status <> 'CANCELLED') || '  confirmed: ' || (select count(*) from attendees where segment_id = $SEG and deleted_at is null and status = 'CONFIRMED') || '  capacity: ' || (select capacity from show_segments where id = $SEG) || '  pending receipts: ' || (select count(*) from email_outbox where purpose = 'RECEIPT' and status in ('DRAFT','QUEUED')) from registrations where segment_id = $SEG and deleted_at is null"
