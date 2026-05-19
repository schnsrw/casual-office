#!/bin/sh
# Tauri 2.11's deb bundler generates `Exec=<binary>` without `%F`, so
# when the user opens a .docx via "Open With Casual Office" the OS
# launches the binary but doesn't pass the file path — Casual Office
# would just show the home screen instead of opening the file. Patch
# the installed .desktop file to add %F.
set -e

DESKTOP_FILE="/usr/share/applications/Casual Office.desktop"

if [ -f "$DESKTOP_FILE" ]; then
  # Append %F to the Exec line if it isn't already there.
  if ! grep -q '^Exec=.*%F' "$DESKTOP_FILE"; then
    sed -i 's|^Exec=deskapp-shell$|Exec=deskapp-shell %F|' "$DESKTOP_FILE"
  fi
  # Refresh the desktop database so file managers pick up the changes.
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database /usr/share/applications/ 2>/dev/null || true
  fi
  if command -v update-mime-database >/dev/null 2>&1; then
    update-mime-database /usr/share/mime 2>/dev/null || true
  fi
fi

exit 0
