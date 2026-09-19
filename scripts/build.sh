#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/lib.sh"

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "Desktop packaging currently supports Apple Silicon macOS only." >&2
  exit 1
fi

bootstrap_repo

cd "$REPO_ROOT"
mise_exec pnpm --filter web build
rm -rf apps/server/djit/static
cp -R apps/web/dist apps/server/djit/static
cd "$REPO_ROOT/apps/server"
mise_exec uv run pyinstaller --noconfirm --clean djit.spec

cd "$REPO_ROOT"
BACKEND_BUILD_ID=$(
  find apps/server/dist/djit-server -type f ! -name .build-id -print0 \
    | xargs -0 shasum -a 256 \
    | LC_ALL=C sort \
    | shasum -a 256 \
    | cut -c1-16
)
printf '%s\n' "$BACKEND_BUILD_ID" > apps/server/dist/djit-server/.build-id
mkdir -p dist
# Build into a fresh bundle so old sealed resources cannot survive a rebuild.
rm -rf dist/DJ-IT.app
mise_exec deno desktop \
  --allow-all \
  --output dist/DJ-IT.app \
  apps/desktop/main.ts
rm -rf dist/DJ-IT.app/Contents/Resources/djit-server
cp -R apps/server/dist/djit-server dist/DJ-IT.app/Contents/Resources/djit-server
plutil -replace NSRemovableVolumesUsageDescription \
  -string "DJ-IT needs access to the external drives you choose for your music library." \
  dist/DJ-IT.app/Contents/Info.plist
cp LICENSE THIRD_PARTY_NOTICES.md dist/DJ-IT.app/Contents/Resources/
# Deno 2.9 writes this deterministic startup acknowledgement on launch.
# Seal it now so first launch does not add an unsealed bundle resource.
printf 'ok' > dist/DJ-IT.app/Contents/MacOS/DJ-IT.dylib.update-ok
codesign --force --sign - dist/DJ-IT.app
codesign --verify --deep --strict --verbose=2 dist/DJ-IT.app
