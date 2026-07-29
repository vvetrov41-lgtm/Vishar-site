#!/usr/bin/env bash
#
# Runs the CRM pgTAP suite against a throwaway local PostgreSQL cluster.
#
# The canonical runner is `supabase test db`, which needs Docker. This script
# is the fallback for environments where Docker or the Supabase CLI is not
# available. It applies supabase/tests/_shim/00_supabase_shim.sql first, then
# every migration in order, then every test file.
#
# The cluster is created fresh, used, and destroyed. It never touches a hosted
# database and reads no credential.
#
# Requirements: PostgreSQL 16 server binaries (initdb, pg_ctl, psql) and the
# pgtap extension available to that server.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
DB_NAME="crm_test"
BOOTSTRAP="crm_bootstrap"
MIGRATOR="crm_migrator"

if [ ! -x "$PG_BIN/initdb" ]; then
  echo "FAIL: PostgreSQL server binaries not found at $PG_BIN" >&2
  echo "      Set PG_BIN, or run the canonical suite with: supabase test db" >&2
  exit 1
fi

# initdb refuses to run as root. When this script is invoked as root, drop to
# an unprivileged account for the whole cluster lifecycle. SQL files are read
# by this shell and piped in on stdin, so the unprivileged account never needs
# access to the repository itself.
RUN_AS=""
if [ "$(id -u)" -eq 0 ]; then
  if id postgres >/dev/null 2>&1; then
    RUN_AS="postgres"
  else
    echo "FAIL: running as root and no unprivileged 'postgres' account exists." >&2
    exit 1
  fi
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/crm-db-tests-XXXXXX")"
PGDATA="$WORK_DIR/data"
SOCKET_DIR="$WORK_DIR/socket"
LOG_FILE="$WORK_DIR/postgres.log"

as_user() {
  if [ -n "$RUN_AS" ]; then
    su "$RUN_AS" -s /bin/bash -c "$1"
  else
    bash -c "$1"
  fi
}

cleanup() {
  as_user "$PG_BIN/pg_ctl -D '$PGDATA' -m immediate stop" >/dev/null 2>&1 || true
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

mkdir -p "$PGDATA" "$SOCKET_DIR"
if [ -n "$RUN_AS" ]; then
  chmod 755 "$WORK_DIR"
  chown -R "$RUN_AS" "$WORK_DIR"
fi
chmod 700 "$PGDATA"

psql_base() { # psql_base <role>
  echo "PGOPTIONS='-c client_min_messages=warning' $PG_BIN/psql -h '$SOCKET_DIR' -U '$1' -X -q -v ON_ERROR_STOP=1"
}

psql_cmd() {   # psql_cmd <role> <database> <sql>
  as_user "$(psql_base "$1") -d '$2' -c \"$3\""
}

psql_file() {  # psql_file <role> <database> <path> — file is read here and piped in
  as_user "$(psql_base "$1") -d '$2'" < "$3"
}

psql_value() { # psql_value <role> <database> <sql>
  as_user "$(psql_base "$1") -d '$2' -t -A -c \"$3\""
}

echo "==> Initialising a throwaway PostgreSQL cluster"
as_user "$PG_BIN/initdb -D '$PGDATA' -U '$BOOTSTRAP' --auth=trust --encoding=UTF8 --locale=C" >/dev/null
as_user "$PG_BIN/pg_ctl -D '$PGDATA' -l '$LOG_FILE' -o \"-k '$SOCKET_DIR' -h '' -c fsync=off -c full_page_writes=off\" -w start" >/dev/null

# The migration owner is a separate role from the cluster bootstrap user,
# because PostgreSQL refuses to remove SUPERUSER from the bootstrap user and
# the whole point of this harness is to run migrations WITHOUT it.
psql_cmd "$BOOTSTRAP" postgres "create role $MIGRATOR login superuser" >/dev/null
psql_cmd "$BOOTSTRAP" postgres "create database $DB_NAME owner $MIGRATOR" >/dev/null

# The shim installs extensions, which needs superuser, so it runs while the
# migration role still has that attribute and therefore owns everything it
# creates.
echo "==> Applying the local Supabase shim"
psql_file "$MIGRATOR" "$DB_NAME" "$ROOT_DIR/supabase/tests/_shim/00_supabase_shim.sql" >/dev/null

# The migration owner must then NOT be a superuser and must NOT bypass RLS, so
# that FORCE ROW LEVEL SECURITY genuinely applies to SECURITY DEFINER
# functions. This makes the harness stricter than hosted Supabase, where
# `postgres` bypasses RLS.
psql_cmd "$BOOTSTRAP" postgres "alter role $MIGRATOR nosuperuser nobypassrls" >/dev/null

echo "==> Confirming the migration owner does not bypass row level security"
BYPASS="$(psql_value "$MIGRATOR" "$DB_NAME" "select rolbypassrls or rolsuper from pg_roles where rolname = current_user")"
if [ "$BYPASS" != "f" ]; then
  echo "FAIL: migration owner still bypasses RLS; the suite would not prove anything." >&2
  exit 1
fi

echo "==> Applying migrations"
for file in "$ROOT_DIR"/supabase/migrations/*.sql; do
  echo "    $(basename "$file")"
  psql_file "$MIGRATOR" "$DB_NAME" "$file" >/dev/null
done

echo "==> Running pgTAP tests"
FAILED=0
TEST_OUTPUT="$WORK_DIR/tap.out"
for file in ${CRM_TEST_FILES:-"$ROOT_DIR"/supabase/tests/*.sql}; do
  echo "--- $(basename "$file")"
  if ! psql_file "$MIGRATOR" "$DB_NAME" "$file" | tee "$TEST_OUTPUT"; then
    FAILED=1
  fi
  # finish(true) raises on failure, but a stray "not ok" must never slip past.
  if grep -qE '^[[:space:]]*not ok' "$TEST_OUTPUT"; then
    echo "FAIL: $(basename "$file") reported a failing assertion." >&2
    FAILED=1
  fi
done

if [ "$FAILED" -ne 0 ]; then
  echo "==> DATABASE TESTS FAILED" >&2
  exit 1
fi

echo "==> All CRM database tests passed (local shim harness)."
echo "    Note: this harness does not cover signed URLs, the Storage API, JWT"
echo "    issuance or PostgREST. Run 'supabase test db' for those."
