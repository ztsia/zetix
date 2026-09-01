#!/usr/bin/env bash
# Local Postgres 16 for development (spec.md §16.4).
#
# The allocation engine needs a real Postgres, not a mock — claim_seats() holds
# a row lock across a read-then-write and the concurrency tests are the point.
# It does NOT need Supabase: citext, pg_trgm and pgcrypto are the only
# extensions in play. This means the dev environment never needs the production
# database password or the service-role key.
set -euo pipefail

PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PGDATA="${PGDATA:-${HOME}/.zetix-pgdata}"
PGPORT="${PGPORT:-55432}"
PGSOCK="${PGSOCK:-/tmp}"
DBNAME="${DBNAME:-zetix}"

start() {
  if [ ! -d "$PGDATA/base" ]; then
    echo "initdb -> $PGDATA"
    "$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust >/dev/null
  fi
  if "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
    echo "already running on :$PGPORT"
  else
    "$PGBIN/pg_ctl" -D "$PGDATA" -o "-p $PGPORT -k $PGSOCK" -l "$PGDATA/server.log" -w start
  fi
  "$PGBIN/createdb" -h "$PGSOCK" -p "$PGPORT" -U postgres "$DBNAME" 2>/dev/null || true
  psql -h "$PGSOCK" -p "$PGPORT" -U postgres -d "$DBNAME" -q \
    -f "$(dirname "$0")/db-extensions.sql"
  echo
  echo "  DATABASE_URL=postgresql://postgres@localhost:$PGPORT/$DBNAME"
}

case "${1:-start}" in
  start)  start ;;
  stop)   "$PGBIN/pg_ctl" -D "$PGDATA" -w stop ;;
  reset)  "$PGBIN/pg_ctl" -D "$PGDATA" -w stop 2>/dev/null || true; rm -rf "$PGDATA"; start ;;
  psql)   psql -h "$PGSOCK" -p "$PGPORT" -U postgres -d "$DBNAME" ;;
  *)      echo "usage: $0 {start|stop|reset|psql}" >&2; exit 1 ;;
esac
