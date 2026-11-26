#!/usr/bin/env bash
set -euo pipefail

# On-demand importer for ready-to-use 3D printer assemblies from Psych0h3ad/3d-print-rig.
# Downloads the selected machine's .glb.gz, verifies SHA-256 against APPROVED_DELIVERY.json,
# gunzips it, optimizes it via Meshopt (30-85 MB -> ~2-6 MB for Raspberry Pi), and
# optionally uploads it directly into a running DOCKYARD printer profile.
#
# Usage:
#   ./scripts/import-3d-print-rig.sh --list [query]
#   ./scripts/import-3d-print-rig.sh <machine-id> [--out <file.glb>] [--upload <dockyard-url> <printer-id>] [--slot printer|toolhead] [--no-optimize]

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST_URL="https://raw.githubusercontent.com/Psych0h3ad/3d-print-rig/main/site/APPROVED_DELIVERY.json"
MANIFEST_LOCAL=""
LIST_MODE=0
LIST_QUERY=""
MACHINE_ID=""
OUT_PATH=""
UPLOAD_URL=""
UPLOAD_PRINTER_ID=""
UPLOAD_SLOT="printer"
NO_OPTIMIZE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --list)
      LIST_MODE=1
      if [[ $# -ge 2 && "$2" != --* ]]; then
        LIST_QUERY="$2"
        shift 2
      else
        shift
      fi
      ;;
    --manifest)
      MANIFEST_LOCAL="${2:-}"
      shift 2
      ;;
    --out)
      OUT_PATH="${2:-}"
      shift 2
      ;;
    --upload)
      UPLOAD_URL="${2:-}"
      UPLOAD_PRINTER_ID="${3:-}"
      shift 3
      ;;
    --slot)
      UPLOAD_SLOT="${2:-printer}"
      shift 2
      ;;
    --no-optimize)
      NO_OPTIMIZE=1
      shift
      ;;
    -h|--help)
      echo "Usage:"
      echo "  $0 --list [query]"
      echo "  $0 <machine-id> [--out <file.glb>] [--upload <dockyard-url> <printer-id>] [--slot printer|toolhead] [--no-optimize]"
      exit 0
      ;;
    *)
      if [[ -z "${MACHINE_ID}" ]]; then
        MACHINE_ID="$1"
      else
        echo "Error: Unexpected argument: $1" >&2
        exit 1
      fi
      shift
      ;;
  esac
done

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

if [[ -n "${MANIFEST_LOCAL}" ]]; then
  MANIFEST_FILE="${MANIFEST_LOCAL}"
else
  MANIFEST_FILE="${TMP_DIR}/APPROVED_DELIVERY.json"
  curl -fsSL "${MANIFEST_URL}" -o "${MANIFEST_FILE}"
fi

if [[ "${LIST_MODE}" == "1" ]]; then
  python3 - "${MANIFEST_FILE}" "${LIST_QUERY}" <<'PY'
import json, sys

manifest_path, query = sys.argv[1], sys.argv[2].strip().lower()
data = json.load(open(manifest_path, "r", encoding="utf-8"))
files = data.get("files", [])

by_machine = {}
for f in files:
    p = f.get("path", "")
    if not p.endswith(".glb.gz"):
        continue
    parts = p.split("/")
    if len(parts) >= 3 and parts[0] == "machines" and parts[2] == "model.glb.gz":
        by_machine[parts[1]] = f
    elif len(parts) >= 4 and parts[0] == "community-machines-assets" and parts[-1] == "model.glb.gz":
        by_machine.setdefault(parts[1], f)

ids = sorted(set(data.get("machine_ids", [])) | set(by_machine.keys()))
matched = [mid for mid in ids if not query or query in mid.lower()]
print(f"Found {len(matched)} machines in 3D Print Rig catalog:")
for mid in matched:
    entry = by_machine.get(mid)
    size_mb = f"{entry['bytes'] / 1048576:5.1f} MB gz" if entry else "  (external)"
    print(f"  {mid:<38s} {size_mb}")
PY
  exit 0
fi

if [[ -z "${MACHINE_ID}" ]]; then
  echo "Error: Specify --list or a <machine-id> (e.g. voron_v24_350_printed)." >&2
  exit 1
fi

META_LINES="$(python3 - "${MANIFEST_FILE}" "${MACHINE_ID}" <<'PY'
import json, sys

manifest_path, target = sys.argv[1], sys.argv[2].strip()
data = json.load(open(manifest_path, "r", encoding="utf-8"))
files = data.get("files", [])

found = None
for f in files:
    p = f.get("path", "")
    if p == f"machines/{target}/model.glb.gz":
        found = f
        break
if not found:
    for f in files:
        p = f.get("path", "")
        if p.endswith("/model.glb.gz") and f"/{target}/" in f"/{p}":
            found = f
            break

if not found:
    sys.stderr.write(f"Error: Machine '{target}' not found in APPROVED_DELIVERY.json.\n")
    sys.stderr.write("Tip: Run --list to see available machine IDs.\n")
    sys.exit(1)

print(found["url"])
print(found.get("sha256", ""))
print(found.get("bytes", 0))
PY
)"

DL_URL="$(printf '%s\n' "${META_LINES}" | sed -n '1p')"
EXPECTED_SHA="$(printf '%s\n' "${META_LINES}" | sed -n '2p')"
DL_BYTES="$(printf '%s\n' "${META_LINES}" | sed -n '3p')"

GZ_FILE="${TMP_DIR}/${MACHINE_ID}.glb.gz"
RAW_GLB="${TMP_DIR}/${MACHINE_ID}.raw.glb"

echo "==> Downloading ${MACHINE_ID} ($(awk "BEGIN{printf \"%.1f\", ${DL_BYTES}/1048576}") MB gzipped) from 3D Print Rig..."
curl -fL --progress-bar "${DL_URL}" -o "${GZ_FILE}"

if [[ -n "${EXPECTED_SHA}" ]]; then
  if command -v shasum >/dev/null 2>&1; then
    ACTUAL_SHA="$(shasum -a 256 "${GZ_FILE}" | awk '{print $1}')"
  else
    ACTUAL_SHA="$(sha256sum "${GZ_FILE}" | awk '{print $1}')"
  fi
  if [[ "${ACTUAL_SHA}" != "${EXPECTED_SHA}" ]]; then
    echo "Error: SHA-256 mismatch for ${MACHINE_ID} (expected ${EXPECTED_SHA}, got ${ACTUAL_SHA})." >&2
    exit 1
  fi
  echo "    SHA-256 verified."
fi

gunzip -c "${GZ_FILE}" > "${RAW_GLB}"

if [[ -z "${OUT_PATH}" ]]; then
  OUT_DIR="${HOME}/Desktop/dockyard-exports"
  mkdir -p "${OUT_DIR}"
  OUT_PATH="${OUT_DIR}/${MACHINE_ID}.glb"
else
  mkdir -p "$(dirname "${OUT_PATH}")"
fi

if [[ "${NO_OPTIMIZE}" == "1" ]]; then
  cp "${RAW_GLB}" "${OUT_PATH}"
else
  "${SCRIPT_DIR}/optimize-dockyard-glb.sh" "${RAW_GLB}" "${OUT_PATH}" --preset printer
fi

echo "==> Saved: ${OUT_PATH}"

if [[ -n "${UPLOAD_URL}" && -n "${UPLOAD_PRINTER_ID}" ]]; then
  BASE_URL="${UPLOAD_URL%/}"
  FNAME="$(basename "${OUT_PATH}")"
  echo "==> Uploading ${FNAME} to ${BASE_URL}/api/models/${UPLOAD_PRINTER_ID}/${UPLOAD_SLOT} ..."
  curl -fsS -X POST "${BASE_URL}/api/models/${UPLOAD_PRINTER_ID}/${UPLOAD_SLOT}" \
    -H "Origin: ${BASE_URL}" \
    -H "X-Cockpit-Request: 1" \
    -H "X-Model-Filename: ${FNAME}" \
    -H "Content-Type: model/gltf-binary" \
    --data-binary "@${OUT_PATH}" >/dev/null
  echo "    Upload complete! Reload or view ${UPLOAD_PRINTER_ID} in DOCKYARD."
fi
