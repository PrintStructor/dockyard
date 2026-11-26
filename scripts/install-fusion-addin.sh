#!/usr/bin/env bash
set -euo pipefail

# Install or update the DOCKYARD Export Add-In for Autodesk Fusion 360 Desktop (macOS).
#
# Usage:
#   ./scripts/install-fusion-addin.sh
#   FUSION_ADDINS_DIR=/custom/path ./scripts/install-fusion-addin.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SRC_DIR="${ROOT_DIR}/fusion-addin/DockyardExport"

DEFAULT_ADDINS_DIR="${HOME}/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns"
TARGET_BASE="${FUSION_ADDINS_DIR:-${DEFAULT_ADDINS_DIR}}"
TARGET_DIR="${TARGET_BASE}/DockyardExport"

if [[ ! -f "${SRC_DIR}/DockyardExport.py" || ! -f "${SRC_DIR}/DockyardExport.manifest" ]]; then
  echo "Fehler: Add-In-Quellen unter ${SRC_DIR} unvollständig." >&2
  exit 1
fi

mkdir -p "${TARGET_BASE}"
TMP_DIR="$(mktemp -d "${TARGET_BASE}/.DockyardExport.tmp.XXXXXX")"
trap 'rm -rf "${TMP_DIR}"' EXIT

cp -R "${SRC_DIR}/." "${TMP_DIR}/"
rm -rf "${TMP_DIR}/__pycache__"
chmod 755 "${TMP_DIR}"

rm -rf "${TARGET_DIR}"
mv "${TMP_DIR}" "${TARGET_DIR}"
trap - EXIT

echo "DOCKYARD Fusion-360-Add-In installiert:"
echo "  ${TARGET_DIR}"
echo ""
echo "In Fusion 360 Desktop:"
echo "  1. Falls Fusion bereits läuft: Shift+S -> Zusatzmodule -> 'DockyardExport' -> Ausführen"
echo "     (oder Fusion einmal neu starten — 'Beim Start ausführen' ist bereits aktiv)."
echo "  2. Danach erscheint der grüne Button 'DOCKYARD Export' in der Toolbar unter"
echo "     Konstruktion -> Dienstprogramme -> Zusatzmodule."
