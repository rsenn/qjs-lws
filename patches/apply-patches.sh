#!/bin/sh
# Applies patches/000*.patch to the libwebsockets submodule checkout,
# skipping any patch that's already present (so re-running this against an
# already-patched tree - e.g. a local dev checkout that got these changes
# applied by hand before the patch existed - is a no-op, not a failure).
set -e

SRC_DIR="$1"
PATCH_DIR="$2"

if [ -z "$SRC_DIR" ] || [ -z "$PATCH_DIR" ]; then
  echo "usage: $0 <libwebsockets-source-dir> <patch-dir>" >&2
  exit 1
fi

cd "$SRC_DIR"

for p in "$PATCH_DIR"/000*.patch; do
  [ -e "$p" ] || continue
  name=$(basename "$p")

  if git apply --check "$p" >/dev/null 2>&1; then
    git apply "$p"
    echo "libwebsockets patch: applied $name"
  elif git apply --reverse --check "$p" >/dev/null 2>&1; then
    echo "libwebsockets patch: $name already applied, skipping"
  else
    echo "libwebsockets patch: $name does not apply and isn't already applied - aborting" >&2
    exit 1
  fi
done
