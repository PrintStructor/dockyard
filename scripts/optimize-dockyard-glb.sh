#!/usr/bin/env bash
set -euo pipefail

# Optimize and Meshopt-compress a raw .glb (from Fusion 360, Blender, or 3D Print Rig)
# for fast WebGL rendering in DOCKYARD while preserving live node/material tags
# (VORON_ACCENT, LED_LOGO, LED_NOZZLE_L, LED_NOZZLE_R, NOZZLE_TIP, FILAMENT_INLET).
#
# Usage:
#   ./scripts/optimize-dockyard-glb.sh <input.glb> [output.glb] [--preset toolhead|printer]

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

PRESET="printer"
RATIO=""
ERROR=""
POSITIONAL=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --preset)
      PRESET="${2:-printer}"
      shift 2
      ;;
    --ratio)
      RATIO="${2:-}"
      shift 2
      ;;
    --error)
      ERROR="${2:-}"
      shift 2
      ;;
    -h|--help)
      echo "Usage: $0 <input.glb> [output.glb] [--preset toolhead|printer] [--ratio 0.35] [--error 0.001]"
      exit 0
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done

if [[ ${#POSITIONAL[@]} -lt 1 ]]; then
  echo "Error: Input .glb path required." >&2
  echo "Usage: $0 <input.glb> [output.glb] [--preset toolhead|printer]" >&2
  exit 1
fi

INPUT="${POSITIONAL[0]}"
if [[ ! -f "${INPUT}" ]]; then
  echo "Error: File not found: ${INPUT}" >&2
  exit 1
fi

if [[ ${#POSITIONAL[@]} -ge 2 ]]; then
  OUTPUT="${POSITIONAL[1]}"
else
  OUTPUT="${INPUT%.glb}.opt.glb"
fi

if [[ -z "${RATIO}" || -z "${ERROR}" ]]; then
  case "${PRESET}" in
    toolhead)
      RATIO="${RATIO:-0.35}"
      ERROR="${ERROR:-0.001}"
      ;;
    printer)
      RATIO="${RATIO:-0.25}"
      ERROR="${ERROR:-0.0005}"
      ;;
    *)
      echo "Error: Unknown preset '${PRESET}' (expected toolhead or printer)." >&2
      exit 1
      ;;
  esac
fi

mkdir -p "$(dirname "${OUTPUT}")"

BEFORE_BYTES=$(wc -c < "${INPUT}" | tr -d ' ')
echo "==> Optimizing ${INPUT} (preset=${PRESET}, ratio=${RATIO}, error=${ERROR})..."

# --flatten false, --join false, --palette false, and --prune false preserve
# solid material colors, named live nodes & empty anchors (VORON_ACCENT, LED_*, NOZZLE_TIP, FILAMENT_INLET).
npx --yes @gltf-transform/cli@4.5.1 optimize "${INPUT}" "${OUTPUT}" \
  --compress meshopt \
  --flatten false \
  --join false \
  --palette false \
  --prune false \
  --simplify \
  --simplify-ratio "${RATIO}" \
  --simplify-error "${ERROR}"

AFTER_BYTES=$(wc -c < "${OUTPUT}" | tr -d ' ')
MAX_BYTES=$((25 * 1024 * 1024))

node -e "
  const b = Number(process.argv[1]), a = Number(process.argv[2]), max = Number(process.argv[3]);
  const fmt = n => n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : (n / 1024).toFixed(1) + ' KB';
  const pct = b > 0 ? ((1 - a / b) * 100).toFixed(1) : '0.0';
  console.log('    Result: ' + fmt(b) + ' -> ' + fmt(a) + ' (-' + pct + '%)');
  if (a > max) {
    console.error('WARNING: Output exceeds DOCKYARD 25 MB upload limit. Retry with e.g. --ratio 0.12 --error 0.002');
    process.exit(2);
  }
" "${BEFORE_BYTES}" "${AFTER_BYTES}" "${MAX_BYTES}"

echo "    Ready to upload in DOCKYARD Settings: ${OUTPUT}"
