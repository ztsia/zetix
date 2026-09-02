#!/usr/bin/env bash
# Disposable QA database, on the same local Postgres 16 as development.
#
# QA deliberately fills segments to capacity, cancels registrations and presses
# Send twice. Doing that in the dev database destroys whatever fixtures the
# authoring session is working against, and makes the QA run unreproducible.
# A second database on the same server costs nothing and isolates both.
#
# This never touches Supabase. There is no network route from this container to
# it, and QA has no business needing one.
set -euo pipefail
cd "$(dirname "$0")/.."

PGPORT="${PGPORT:-55432}"
PGSOCK="${PGSOCK:-/tmp}"
QADB="${QADB:-zetix_qa}"
psql() { command psql -h "$PGSOCK" -p "$PGPORT" -U postgres "$@"; }

# The server runs as an unprivileged account, so never drive it with pg_ctl from
# here — go through the socket, and let the session-start hook own starting it.
if ! psql -d postgres -q -c 'select 1' >/dev/null 2>&1; then
  ./scripts/session-start.sh >/dev/null 2>&1 || true
fi
psql -d postgres -q -c 'select 1' >/dev/null

# Recreate from scratch so every run starts from the same known state. --force
# evicts the dev server if it is still holding a connection from a previous run.
psql -d postgres -q -c "drop database if exists \"$QADB\" with (force)"
psql -d postgres -q -c "create database \"$QADB\""
psql -d "$QADB" -q -f scripts/db-extensions.sql

echo "QA_DATABASE_URL=postgresql://postgres@localhost:$PGPORT/$QADB"
