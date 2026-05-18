#!/usr/bin/env bash
# Copy each editor's built dist into apps/shell/public/{docx,sheets}/.
# Vite serves public/ at the root URL in both dev and prod builds,
# so editor windows can load /docx/index.html or /sheets/index.html.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(cd ../.. && pwd)"
PUBLIC="$(pwd)/public"

DOCX_DIST="$ROOT/docx/docx-editor/examples/vite/dist"
SHEETS_DIST="$ROOT/sheets/apps/web/dist"

if [[ ! -d "$DOCX_DIST" ]]; then
  echo "ERROR: docx dist missing at $DOCX_DIST" >&2
  echo "Run: pnpm build:docx (from repo root)" >&2
  exit 1
fi
if [[ ! -d "$SHEETS_DIST" ]]; then
  echo "ERROR: sheets dist missing at $SHEETS_DIST" >&2
  echo "Run: pnpm build:sheets (from repo root)" >&2
  exit 1
fi

mkdir -p "$PUBLIC"
rm -rf "$PUBLIC/docx" "$PUBLIC/sheets"
cp -R "$DOCX_DIST" "$PUBLIC/docx"
cp -R "$SHEETS_DIST" "$PUBLIC/sheets"

echo "Editors copied:"
echo "  $PUBLIC/docx (from $DOCX_DIST)"
echo "  $PUBLIC/sheets (from $SHEETS_DIST)"
