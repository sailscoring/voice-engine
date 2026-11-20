#!/usr/bin/env bash
# Build a runtime inside its pinned container.
#
#   scripts/build.sh [runtime] [out]      default: sherpa-onnx, build/runtimes/<runtime>
#
# Uses $CONTAINER_ENGINE if set, else podman if it's there, else docker. The
# source tree the build checks out is kept in build/work/<runtime>, so a
# second run only rebuilds what changed.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
runtime=${1:-sherpa-onnx}
out=${2:-build/runtimes/$runtime}
# shellcheck disable=SC1090
source "$root/runtimes/$runtime/versions.env"

engine=${CONTAINER_ENGINE:-$(command -v podman || command -v docker || true)}
[[ -n $engine ]] || { echo "needs podman or docker" >&2; exit 1; }

mkdir -p "$root/build/work/$runtime" "$root/$out"
user=()
# Docker runs as root unless told otherwise; rootless podman maps root to us.
[[ $engine == *docker ]] && user=(--user "$(id -u):$(id -g)" -e HOME=/tmp)

"$engine" run --rm "${user[@]}" \
  -v "$root:/src:Z" -w /src \
  -e SHERPA_ONNX_WORK="/src/build/work/$runtime" \
  -e EM_CACHE="/src/build/work/em-cache" \
  "$EMSDK_IMAGE" \
  "runtimes/$runtime/build.sh" "$out"
