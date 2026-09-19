#!/usr/bin/env sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/lib.sh"

DB_DIR="$REPO_ROOT/apps/server"

printf '%s\n' 'Resetting local database at apps/server/djit.db'
printf '%s\n' 'Stop the dev server first if it is currently running.'

cd "$DB_DIR"
rm -f djit.db djit.db-shm djit.db-wal
mise_exec uv run alembic upgrade head

printf '%s\n' 'Database reset complete.'