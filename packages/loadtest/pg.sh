#!/usr/bin/env bash
# Throwaway local Postgres for the load harness. Listens on 127.0.0.1 only.
#
# Migrations go through psql on purpose, not the Prisma CLI: prisma.config.ts
# loads dotenv and prefers DIRECT_DATABASE_URL, so a stray .env could point
# `prisma migrate` at a remote database.
#
#   bash pg.sh up      create the cluster if needed, start it, reset the schema
#   bash pg.sh reset   drop and recreate the database
#   bash pg.sh down    stop the cluster
#   bash pg.sh destroy stop the cluster and delete its data directory
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PGDATA="$HERE/.pg"
PORT=55433
DB=linea_loadtest
MIGRATIONS="$HERE/../db/prisma/migrations"

find_bin() {
  if [ -n "${PG_BIN:-}" ]; then echo "$PG_BIN"; return; fi
  for v in 17 16 15; do
    if [ -x "/opt/homebrew/opt/postgresql@$v/bin/initdb" ]; then
      echo "/opt/homebrew/opt/postgresql@$v/bin"; return
    fi
    if [ -x "/usr/lib/postgresql/$v/bin/initdb" ]; then
      echo "/usr/lib/postgresql/$v/bin"; return
    fi
  done
  dirname "$(command -v initdb)"
}
BIN="$(find_bin)"
PSQL=("$BIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)

reset_db() {
  "${PSQL[@]}" -d postgres -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)"
  "${PSQL[@]}" -d postgres -c "CREATE DATABASE $DB"
  for f in "$MIGRATIONS"/*/migration.sql; do
    "${PSQL[@]}" -d "$DB" -f "$f" >/dev/null
  done
}

start_server() {
  if ! "$BIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
    # Durability settings stay at their defaults (fsync and synchronous_commit on).
    # PG_OPTS adds settings, e.g. PG_OPTS="-c wal_sync_method=fsync_writethrough".
    "$BIN/pg_ctl" -D "$PGDATA" -w -l "$PGDATA/server.log" \
      -o "-p $PORT -c listen_addresses=127.0.0.1 -c max_connections=200 -k '' ${PG_OPTS:-}" start >/dev/null
  fi
}

case "${1:-up}" in
  up)
    if [ ! -f "$PGDATA/PG_VERSION" ]; then
      "$BIN/initdb" -D "$PGDATA" -U postgres --auth=trust --encoding=UTF8 >/dev/null
    fi
    start_server
    reset_db
    "${PSQL[@]}" -d "$DB" -Atc "select 'local postgres ready: ' || version()"
    ;;
  reset) reset_db ;;
  # stop and start keep the data; the db-outage test uses them.
  stop) "$BIN/pg_ctl" -D "$PGDATA" -m immediate -w stop >/dev/null ;;
  start) start_server ;;
  down) "$BIN/pg_ctl" -D "$PGDATA" -m fast stop ;;
  destroy)
    "$BIN/pg_ctl" -D "$PGDATA" -m fast stop || true
    rm -rf "$PGDATA"
    ;;
  *) echo "usage: pg.sh up|reset|down|destroy" >&2; exit 2 ;;
esac
