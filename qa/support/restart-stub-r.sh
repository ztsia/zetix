#!/usr/bin/env bash
# Restarts only the module-R stub GoTrue (its users live in memory).
set -euo pipefail
cd "$(dirname "$0")/../.."
pkill -f "node qa/support/gotrue-stub.mjs" || true
sleep 1
export QA_DATABASE_URL="${QA_DATABASE_URL:-postgresql://postgres@localhost:55432/zetix_qa}"
export STUB_USERS="$(sed -n "/^export STUB_USERS='/,/^]'/p" qa/support/start-r.sh | sed "1s/^export STUB_USERS='//; \$s/'\$//")"
nohup node qa/support/gotrue-stub.mjs > /tmp/qa-stub-r.log 2>&1 &
sleep 1; cat /tmp/qa-stub-r.log
