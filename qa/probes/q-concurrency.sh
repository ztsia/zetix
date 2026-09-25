#!/usr/bin/env bash
# QA (module Q): real two-session races against the command runner.
# Usage: DB=zetix_qa_be qa/probes/q-concurrency.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
DB="${DB:-zetix_qa_be}"
URL="postgresql://postgres@localhost:55432/$DB"
P() { psql -h /tmp -p 55432 -U postgres -d "$DB" -qAtX "$@"; }
W() { DATABASE_URL="$URL" pnpm exec tsx --conditions=react-server qa/probes/q-worker.ts "$@"; }

P -c "truncate concerts, shows, show_segments, registrations, attendees, players, command_runs, command_run_items, audit_log restart identity cascade" >/dev/null
CONCERT=$(P -c "insert into concerts (name, slug, status, timezone) values ('Race','race','ACTIVE','Asia/Singapore') returning id" | head -1)
SHOW=$(P -c "insert into shows (concert_id, name, status, capacity, starts_at) values ($CONCERT,'S','OPEN',1000, now()+interval '30 days') returning id" | head -1)

echo "== C1: restore(party A, 2 seats) vs claim_seats(party C, 2 seats) for the last 2 seats, x8"
for i in 1 2 3 4 5 6 7 8; do
  SHOW=$(P -c "insert into shows (concert_id, name, status, capacity, starts_at) values ($CONCERT,'S$i','OPEN',1000, now()+interval '30 days') returning id" | head -1)
  SEG=$(P -c "insert into show_segments (show_id, name, audience_mode, capacity, extras_policy, allow_partial_grant) values ($SHOW,'seg$i','PUBLIC',4,'AUTO_FCFS',false) returning id" | head -1)
  mk() { P -c "insert into registrations (show_id, segment_id, source, contact_name, contact_email, status, requested_at) values ($SHOW,$SEG,'ADMIN','$1','x@example.test','CONFIRMED', clock_timestamp()) returning id" | head -1; }
  A=$(mk A$i); B=$(mk B$i); C=$(mk C$i)
  for R in $A $B; do P -c "select claim_seats($SEG,$R,'[{\"full_name\":\"a\",\"allocation_type\":\"COMP\"},{\"full_name\":\"b\",\"allocation_type\":\"COMP\"}]'::jsonb,false)" >/dev/null; done
  P -c "begin; update attendees set deleted_at=now() where registration_id=$A; update registrations set deleted_at=now() where id=$A; commit;" >/dev/null
  # Hold the hall lock so both contenders queue on it, then release.
  ( P -c "begin; select 1 from shows where id=$SHOW for update; select pg_sleep(4); commit;" >/dev/null ) &
  HOLD=$!
  sleep 0.5
  W restore-party $CONCERT $A > /tmp/qc-restore-$i.json 2>&1 &
  WR=$!
  if [ $((i % 2)) -eq 1 ]; then sleep 1.5; else sleep 0.1; fi
  ( P -c "select claim_seats($SEG,$C,'[{\"full_name\":\"c\",\"allocation_type\":\"COMP\"},{\"full_name\":\"d\",\"allocation_type\":\"COMP\"}]'::jsonb,false)" > /tmp/qc-claim-$i.json 2>&1 ) &
  WC=$!
  wait $HOLD $WR $WC
  RES=$(P -c "select string_agg(r.contact_name||':'||coalesce((select string_agg(a.status::text,',' order by a.id) from attendees a where a.registration_id=r.id and a.deleted_at is null),'-'),' ') || ' confirmed=' || (select count(*) from attendees a join registrations r2 on r2.id=a.registration_id where a.segment_id=$SEG and a.status='CONFIRMED' and a.deleted_at is null and r2.deleted_at is null) from registrations r where r.segment_id=$SEG")
  echo "  iter $i: $RES | restore=$(tail -1 /tmp/qc-restore-$i.json | cut -c1-160)"
done

echo "== C2: two workers + the dialog continue one paused run of 40 rows"
P -c "insert into players (concert_id, full_name, email, invite_token, is_active, deleted_at) select $CONCERT, 'P'||g, 'p'||g||'@example.test', 'tok'||g, true, now() from generate_series(1,40) g" >/dev/null
IDS=$(P -c "select string_agg(id::text, ',' order by id) from players where concert_id=$CONCERT")
RUN=$(P -c "insert into command_runs (concert_id, command, selection, params, status, total) values ($CONCERT,'trash.restore.player', jsonb_build_object('ids', '[$IDS]'::jsonb), '{}'::jsonb, 'RUNNING', 40) returning id" | head -1)
P -c "insert into command_run_items (run_id, entity_type, entity_id, status) select $RUN, 'player', id, 'PENDING' from players where concert_id=$CONCERT order by id" >/dev/null
W continue > /tmp/qc-w1.json 2>&1 & A1=$!
W continue > /tmp/qc-w2.json 2>&1 & A2=$!
W continue-run $CONCERT $RUN > /tmp/qc-w3.json 2>&1 & A3=$!
wait $A1 $A2 $A3
echo "  workers: $(tail -1 /tmp/qc-w1.json) $(tail -1 /tmp/qc-w2.json) $(tail -1 /tmp/qc-w3.json)"
P -c "select 'run status='||status||' done='||done||' skipped='||skipped||' failed='||failed from command_runs where id=$RUN"
P -c "select 'audit player.restored rows='||count(*)||' distinct entities='||count(distinct entity_id) from audit_log where action='player.restored' and command_run_id=$RUN"
P -c "select 'players still deleted='||count(*) from players where concert_id=$CONCERT and deleted_at is not null"

echo "== C3: two concurrent restores of the same party"
SHOW=$(P -c "insert into shows (concert_id, name, status, capacity, starts_at) values ($CONCERT,'S-dup','OPEN',1000, now()+interval '30 days') returning id" | head -1)
SEG=$(P -c "insert into show_segments (show_id, name, audience_mode, capacity, extras_policy, allow_partial_grant) values ($SHOW,'dup','PUBLIC',10,'AUTO_FCFS',false) returning id" | head -1)
D=$(P -c "insert into registrations (show_id, segment_id, source, contact_name, contact_email, status, requested_at) values ($SHOW,$SEG,'ADMIN','Dup','x@example.test','CONFIRMED', now()) returning id" | head -1)
P -c "select claim_seats($SEG,$D,'[{\"full_name\":\"a\",\"allocation_type\":\"COMP\"}]'::jsonb,false)" >/dev/null
P -c "begin; update attendees set deleted_at=now() where registration_id=$D; update registrations set deleted_at=now() where id=$D; commit;" >/dev/null
W restore-party $CONCERT $D > /tmp/qc-d1.json 2>&1 & D1=$!
W restore-party $CONCERT $D > /tmp/qc-d2.json 2>&1 & D2=$!
wait $D1 $D2
echo "  r1: $(tail -1 /tmp/qc-d1.json)"
echo "  r2: $(tail -1 /tmp/qc-d2.json)"
P -c "select 'registration.restored audit rows for $D = '||count(*) from audit_log where action='registration.restored' and entity_id='$D'"
