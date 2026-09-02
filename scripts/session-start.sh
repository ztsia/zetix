#!/usr/bin/env bash
# Brings the local Postgres up so `pnpm test` works immediately in a fresh
# session (spec/platform.md §16.4). Never fails the session — a broken database should
# surface when a test runs, not as a startup error.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 0

[ -d node_modules ] || pnpm install --frozen-lockfile >/dev/null 2>&1

# Postgres refuses to run as root; use an unprivileged account when needed.
if [ "$(id -u)" -eq 0 ]; then
  id pgrunner >/dev/null 2>&1 || useradd -m pgrunner >/dev/null 2>&1
  cp -r scripts /home/pgrunner/ 2>/dev/null
  chown -R pgrunner:pgrunner /home/pgrunner/scripts 2>/dev/null
  su pgrunner -c "PATH=/usr/lib/postgresql/16/bin:\$PATH /home/pgrunner/scripts/local-db.sh start" >/dev/null 2>&1
else
  ./scripts/local-db.sh start >/dev/null 2>&1
fi

echo "local postgres: postgresql://postgres@localhost:55432/zetix"
exit 0
