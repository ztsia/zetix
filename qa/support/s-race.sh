#!/usr/bin/env bash
# QA module S, AC-41: real concurrency for the last seat, two processes.
set -uo pipefail
cd "$(dirname "$0")/../.."
export DATABASE_URL="${DATABASE_URL:-postgresql://postgres@localhost:55432/zetix_qa_sb}"
export RACE_STATE="${RACE_STATE:-/tmp/s-race-state.json}"
export RACE_COMMAND="${1:-audience.confirm_seats}"
V="pnpm vitest run --config qa/vitest.qa.config.ts qa/backend/s-race.test.ts"
RACE_ROLE=setup $V >/dev/null 2>&1 || { echo setup failed; exit 1; }
SHOW=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$RACE_STATE')).showId)")
# Hold the hall lock so both runs queue on it, then release together.
psql "$DATABASE_URL" -q -c "begin; select id from shows where id=$SHOW for update; select pg_sleep(8); commit;" >/dev/null &
sleep 1
RACE_ROLE=a $V 2>&1 | grep 'RACE ' &
RACE_ROLE=b $V 2>&1 | grep 'RACE ' &
( sleep 5; psql "$DATABASE_URL" -Atc "select 'waiting on lock: ' || count(*) from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()" ) &
wait
psql "$DATABASE_URL" -Atc "select 'confirmed in segment: ' || count(*) from attendees a join json_to_record('$(cat $RACE_STATE)'::json) s(seg int) on a.segment_id = s.seg where a.status='CONFIRMED' and a.deleted_at is null"
psql "$DATABASE_URL" -Atc "select 'capacity: ' || capacity from show_segments where id = (select (('$(cat $RACE_STATE)')::json->>'seg')::int)"
