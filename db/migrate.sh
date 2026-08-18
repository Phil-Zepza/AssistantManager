#!/usr/bin/env sh
# db/migrate.sh — idempotent SQL migration runner (plain psql, no ORM).
#
# WHY psql: db/schema.sql is already applied by hand with `psql -f`, so this
# extends the repo's existing mechanism rather than introducing a new one. psql
# handles multi-statement files and per-file transactions natively, with no
# driver quirks, and runs identically in local dev and in the Railway image.
#
# WHAT it does:
#   1. ensures a `schema_migrations` tracking table (filename + applied_at),
#   2. applies every db/migrations/*.sql NOT yet recorded, in filename order,
#      each wrapped in ONE transaction (--single-transaction) with ON_ERROR_STOP,
#      recording the filename in the SAME transaction so apply+record is atomic,
#   3. is a no-op when nothing is pending (safe to run on every deploy),
#   4. reads the target from DATABASE_URL and prints host/db (never the password)
#      via psql's \conninfo before applying anything.
#
# CONVENTION: the runner owns each file's transaction, so migration files must
# NOT contain their own BEGIN/COMMIT, and must avoid statements that cannot run
# inside a transaction block (e.g. CREATE INDEX CONCURRENTLY). See db/README.md.
#
# Usage:
#   DATABASE_URL=postgres://... sh db/migrate.sh      # or: npm run migrate (from web/)
# Exit code is non-zero on any failure so a deploy step can gate on it.

set -eu

# Resolve paths relative to THIS script, so cwd doesn't matter (works from web/
# via `npm run migrate`, from the repo root, and from /app in the Railway image).
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
MIGRATIONS_DIR="$SCRIPT_DIR/migrations"

if [ "${DATABASE_URL:-}" = "" ]; then
  echo "migrate: ERROR — DATABASE_URL is not set." >&2
  exit 1
fi

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "migrate: ERROR — migrations dir not found: $MIGRATIONS_DIR" >&2
  exit 1
fi

# Print the target (host/db/user/port) WITHOUT the password, and validate that we
# can actually connect, before touching anything.
echo "migrate: target ->"
psql "$DATABASE_URL" -w -v ON_ERROR_STOP=1 -c '\conninfo'

# Ensure the tracking table exists (idempotent).
psql "$DATABASE_URL" -w -q -v ON_ERROR_STOP=1 -c \
  "create table if not exists schema_migrations (filename text primary key, applied_at timestamptz not null default now());"

# Snapshot the already-applied set.
applied=$(psql "$DATABASE_URL" -w -At -v ON_ERROR_STOP=1 -c "select filename from schema_migrations;")

pending_count=0
for path in "$MIGRATIONS_DIR"/*.sql; do
  [ -e "$path" ] || continue          # glob matched nothing -> skip
  filename=$(basename "$path")

  # Already recorded? skip.
  if printf '%s\n' "$applied" | grep -qxF "$filename"; then
    continue
  fi

  pending_count=$((pending_count + 1))
  printf 'migrate: applying %s ... ' "$filename"

  # Apply the file AND record it in a SINGLE transaction. --single-transaction
  # wraps the -f script and the -c insert together; ON_ERROR_STOP aborts (and
  # therefore rolls back, leaving nothing recorded) on the first error.
  if psql "$DATABASE_URL" -w -q -v ON_ERROR_STOP=1 --single-transaction \
       -f "$path" \
       -c "insert into schema_migrations (filename) values ('$filename');"; then
    echo "ok"
  else
    echo "FAILED"
    echo "migrate: '$filename' failed and was rolled back; no changes recorded." >&2
    exit 1
  fi
done

if [ "$pending_count" -eq 0 ]; then
  echo "migrate: up to date — nothing pending."
else
  echo "migrate: done — applied $pending_count migration(s)."
fi
