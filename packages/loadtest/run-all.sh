#!/usr/bin/env bash
# Full harness run. Takes about 50 minutes with the defaults.
#   bash run-all.sh <label>
# Writes results/<label>/ (default Postgres sync) and results/<label>-fullfsync/
# (wal_sync_method=fsync_writethrough, which on macOS really flushes the drive cache).
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
LABEL="${1:?usage: run-all.sh <label>}"
REPS="${REPS:-3}"

pnpm --filter ws-backend --filter http-backend build >/dev/null || exit 1

bash pg.sh down >/dev/null 2>&1
bash pg.sh up || exit 1
mkdir -p "results/$LABEL"
echo "== chaos"
LOADTEST_LABEL="$LABEL" node --import tsx --test --test-concurrency=1 --test-reporter=spec "test/*.test.ts" \
  2>&1 | tee "results/$LABEL/chaos-output.txt"

echo "== throughput, default sync"
bash pg.sh reset
npx tsx src/throughput.ts --label "$LABEL" --clients 5,20,50 --modes closed,open:800 --reps "$REPS"

echo "== throughput, fsync_writethrough"
bash pg.sh down >/dev/null
PG_OPTS="-c wal_sync_method=fsync_writethrough" bash pg.sh up
npx tsx src/throughput.ts --label "$LABEL-fullfsync" --clients 5,20,50 --modes closed,open:800 --reps "$REPS"

bash pg.sh down >/dev/null
echo "RUN-ALL DONE"
