#!/usr/bin/env bash
# Copy src/templates to dist/templates after TypeScript compilation
set -euo pipefail

SRC="src/templates"
DEST="dist/templates"

if [ ! -d "$SRC" ]; then
  echo "[build] No src/templates directory found, skipping copy."
  exit 0
fi

mkdir -p "$DEST"
cp -R "$SRC"/* "$DEST"/
echo "[build] copied $SRC -> $DEST"
