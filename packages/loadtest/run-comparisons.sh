#!/usr/bin/env bash
# Extra measurements beside the main matrix. Takes about 8 minutes.
#   bash run-comparisons.sh
# - Per-room queue (F6) cost with 5 ms added to each database reply, using the server
#   from just before the queue (bf88949, without F6, F9 and F10) and the current one.
# - F7 overload behaviour with the queue, at offered 800/s on fsync_writethrough.
# The old server is restored from git and the current source is put back afterwards.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
ROOT="$(cd ../.. && pwd)"
SRC="$ROOT/apps/ws-backend/src/index.ts"

if [ -n "$(git -C "$ROOT" status --porcelain apps/ws-backend)" ]; then
  echo "apps/ws-backend has uncommitted changes" >&2
  exit 1
fi
build() { pnpm --filter ws-backend build >/dev/null; }
delay_run() {
  npx tsx src/throughput.ts --label "$1" --clients 20 --modes closed --reps 3 --duration 30 --warmup 5 --db-delay 5
}

bash pg.sh down >/dev/null 2>&1
bash pg.sh up
build
delay_run after-dbdelay5

git -C "$ROOT" show bf88949:apps/ws-backend/src/index.ts > "$SRC"
build
delay_run before-f6-dbdelay5
git -C "$ROOT" checkout -- apps/ws-backend/src/index.ts
build

bash pg.sh down >/dev/null
PG_OPTS="-c wal_sync_method=fsync_writethrough" bash pg.sh up
npx tsx src/throughput.ts --label after-fullfsync-overload --clients 20 --modes open:800 --reps 3

bash pg.sh down >/dev/null
echo "COMPARISONS DONE"
