#!/usr/bin/env bash
# Interleaved comparison of the original server (0f574e3) and the current source, so
# machine conditions affect both alike. Takes about 20 minutes.
#   bash run-ab.sh
# The current source is put back from git afterwards.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
ROOT="$(cd ../.. && pwd)"
SRC="$ROOT/apps/ws-backend/src/index.ts"
BASE=0f574e3
REPS="${REPS:-3}"

if [ -n "$(git -C "$ROOT" status --porcelain apps/ws-backend)" ]; then
  echo "apps/ws-backend has uncommitted changes" >&2
  exit 1
fi

use_server() {
  if [ "$1" = baseline ]; then
    git -C "$ROOT" show "$BASE:apps/ws-backend/src/index.ts" > "$SRC"
  else
    git -C "$ROOT" checkout -- apps/ws-backend/src/index.ts
  fi
  pnpm --filter ws-backend build >/dev/null
}

reconnect_run() {
  LOADTEST_LABEL="ab-$1-tmp" node --import tsx --test --test-reporter=dot test/reconnect.test.ts >/dev/null 2>&1
  mkdir -p "results/ab-$1/reconnect"
  mv "results/ab-$1-tmp/chaos/reconnect-mid-burst.json" "results/ab-$1/reconnect/run-$2.json"
  rm -rf "results/ab-$1-tmp"
}

bash pg.sh down >/dev/null 2>&1
bash pg.sh up

for rep in $(seq 1 "$REPS"); do
  for server in baseline fixed; do
    use_server "$server"
    npx tsx src/throughput.ts --label "ab-$server" --clients 5,50 --modes closed,open:800 \
      --reps 1 --rep-offset "$((rep - 1))" --duration 30 --warmup 5
  done
done

for run in 1 2 3 4 5 6 7 8; do
  for server in baseline fixed; do
    use_server "$server"
    reconnect_run "$server" "$run"
  done
done

git -C "$ROOT" checkout -- apps/ws-backend/src/index.ts
pnpm --filter ws-backend build >/dev/null
bash pg.sh down >/dev/null
echo "AB DONE"
