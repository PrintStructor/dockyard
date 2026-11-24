#!/bin/sh
set -eu
# Usage: sh scripts/optimize-cad.sh /absolute/path/to/raw-models
raw_dir=${1:?Provide the raw export directory containing printer.glb and tools.glb}
app_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
npx --yes @gltf-transform/cli@4.5.1 optimize "$raw_dir/printer.glb" "$app_dir/public/models/printer.glb" --compress meshopt --flatten false --instance false --join false --palette false --simplify-ratio 0.25 --simplify-error 0.0005 --texture-compress false
npx --yes @gltf-transform/cli@4.5.1 optimize "$raw_dir/tools.glb" "$app_dir/public/models/tools.glb" --compress meshopt --flatten false --instance false --join false --palette false --simplify-ratio 0.35 --simplify-error 0.001 --texture-compress false
