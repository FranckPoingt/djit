#!/usr/bin/env sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

find_mise() {
  if command -v mise >/dev/null 2>&1; then
    command -v mise
    return
  fi

  if [ -x "$HOME/.local/bin/mise" ]; then
    printf '%s\n' "$HOME/.local/bin/mise"
    return
  fi

  printf '%s\n' "mise is required but was not found on PATH or at ~/.local/bin/mise" >&2
  exit 1
}

MISE_BIN=$(find_mise)

mise_exec() {
  "$MISE_BIN" exec -- "$@"
}

bootstrap_repo() {
  cd "$REPO_ROOT"

  "$MISE_BIN" install >/dev/null

  mise_exec pnpm install --frozen-lockfile
  (cd "$REPO_ROOT/apps/server" && mise_exec uv sync --locked --python "$(mise_exec python -c 'import sys; print(sys.executable)')")
}
