#!/usr/bin/env bash
# Re-seed zetix_qa for module Q without restarting the dev server.
set -euo pipefail
cd "$(dirname "$0")/../.."
QA_DATABASE_URL="${QA_DATABASE_URL:-postgresql://postgres@localhost:55432/zetix_qa}" QA_ADMIN_EMAIL=committee@example.test node qa/support/seed-q.mjs
psql -h /tmp -p 55432 -U postgres -d zetix_qa -qc "delete from concerts where slug='other-q'"
