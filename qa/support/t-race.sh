#!/usr/bin/env bash
# QA module T, AC-16: two processes press Send tickets over the same 20 parties at once.
# Usage: qa/support/t-race.sh [same|differ]
set -uo pipefail
cd "$(dirname "$0")/../.."
export DATABASE_URL="${DATABASE_URL:-postgresql://postgres@localhost:55432/zetix_qa_tb}"
export RACE_STATE="${RACE_STATE:-/tmp/t-race-state.json}"
export RACE_TEMPLATES="${1:-same}"
V="pnpm vitest run --config qa/vitest.qa.config.ts qa/backend/t-race.test.ts --silent=false"
RACE_ROLE=setup $V >/dev/null 2>&1 || { echo setup failed; exit 1; }
# Hold every party's row so both runs start, then queue on the same locks.
psql "$DATABASE_URL" -q -c "begin; select id from registrations for update; select pg_sleep(12); commit;" >/dev/null &
sleep 1
RACE_ROLE=a $V 2>&1 | grep 'RACE ' &
RACE_ROLE=b $V 2>&1 | grep 'RACE ' &
( sleep 9; psql "$DATABASE_URL" -Atc "select 'waiting on lock: ' || count(*) from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()" ) &
wait
psql "$DATABASE_URL" -Atc "select 'parties with pending TICKETS: ' || count(distinct registration_id) || ', pending rows: ' || count(*) from email_outbox where purpose='TICKETS' and status in ('DRAFT','QUEUED','SENDING')"
psql "$DATABASE_URL" -Atc "select 'max pending per party: ' || coalesce(max(n),0) from (select count(*) n from email_outbox where purpose='TICKETS' and status in ('DRAFT','QUEUED','SENDING') group by registration_id) x"
psql "$DATABASE_URL" -Atc "select 'superseded rows: ' || count(*) from email_outbox where superseded_by_id is not null"
psql "$DATABASE_URL" -Atc "select 'distinct qr tokens: ' || count(distinct qr_token) || ' of seats ' || count(*) from attendees where status='CONFIRMED'"
