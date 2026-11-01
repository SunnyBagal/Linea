#!/usr/bin/env bash
# Interleaved comparison of a base server and the current source. Takes about 75 minutes.
#   BASE=<git ref> bash run-group-commit.sh
# Writes results/gc-{main,new}{,-delay5,-fullfsync}/ and puts the current source back after.
#   default sync: closed and 800/s offered, 5, 20 and 50 clients, 60 s
#   5 ms added to each database reply: same matrix, 30 s
#   fsync_writethrough: closed and 800/s offered, 20 clients, 30 s
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
ROOT="$(cd ../.. && pwd)"
SRC="$ROOT/apps/ws-backend/src/index.ts"
BASE="${BASE:?set BASE to the git ref to compare against}"
REPS="${REPS:-3}"

if [ -n "$(git -C "$ROOT" status --porcelain apps/ws-backend)" ]; then
  echo "apps/ws-backend has uncommitted changes" >&2
  exit 1
fi

use_server() {
  if [ "$1" = main ]; then
    git -C "$ROOT" show "$BASE:apps/ws-backend/src/index.ts" > "$SRC"
  else
    git -C "$ROOT" checkout -- apps/ws-backend/src/index.ts
  fi
  pnpm --filter ws-backend build >/dev/null
}

each_rep() {
  for rep in $(seq 1 "$REPS"); do
    for server in main new; do
      use_server "$server"
      "$@" "$server" "$((rep - 1))"
    done
  done
}

default_pass() {
  npx tsx src/throughput.ts --label "gc-$1" --clients 5,20,50 --modes closed,open:800 \
    --reps 1 --rep-offset "$2" --duration 60 --warmup 5
}
delay_pass() {
  npx tsx src/throughput.ts --label "gc-$1-delay5" --clients 5,20,50 --modes closed,open:800 \
    --reps 1 --rep-offset "$2" --duration 30 --warmup 5 --db-delay 5
}
fullfsync_pass() {
  npx tsx src/throughput.ts --label "gc-$1-fullfsync" --clients 20 --modes closed,open:800 \
    --reps 1 --rep-offset "$2" --duration 30 --warmup 5
}

bash pg.sh down >/dev/null 2>&1
bash pg.sh up
each_rep default_pass
each_rep delay_pass

bash pg.sh down >/dev/null
PG_OPTS="-c wal_sync_method=fsync_writethrough" bash pg.sh up
each_rep fullfsync_pass

git -C "$ROOT" checkout -- apps/ws-backend/src/index.ts
pnpm --filter ws-backend build >/dev/null
bash pg.sh down >/dev/null
echo "GROUP COMMIT COMPARISON DONE"
