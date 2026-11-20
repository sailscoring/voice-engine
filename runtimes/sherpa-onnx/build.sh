#!/usr/bin/env bash
# Build sherpa-onnx's streaming recogniser as WebAssembly, into <out>.
#
#   runtimes/sherpa-onnx/build.sh <out>
#
# Runs where Emscripten is active: inside the pinned image (scripts/build.sh
# starts it), or anywhere `emcc` is the pinned version. Needs git, cmake and
# make. About ten minutes and 3 GB of disk.
#
# The cmake options are sherpa-onnx's own browser build
# (build-wasm-simd-asr.sh at the pinned commit), run here directly so the
# patches and the parallelism are ours to set. The patches are in patches/.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=versions.env
source "$here/versions.env"

out=${1:?usage: build.sh <out dir>}
mkdir -p "$out"
out=$(cd "$out" && pwd)
work=${SHERPA_ONNX_WORK:-$(mktemp -d)}

command -v emcc > /dev/null || { echo "emcc not found: run inside the pinned image (scripts/build.sh)" >&2; exit 1; }
emcc_version=$(emcc --version | head -1)
[[ $emcc_version == *" $EMSDK_VERSION "* ]] || { echo "emcc is not $EMSDK_VERSION: $emcc_version" >&2; exit 1; }

src=$work/sherpa-onnx
if [[ ! -d $src/.git ]]; then
  git init -q "$src"
  git -C "$src" remote add origin https://github.com/k2-fsa/sherpa-onnx.git
fi
git -C "$src" fetch -q --depth 1 origin "$SHERPA_ONNX_COMMIT"
git -C "$src" checkout -q --force FETCH_HEAD
git -C "$src" clean -q -fdx -e build
for p in "$here"/patches/*.patch; do
  git -C "$src" apply "$p"
done

build=$src/build
mkdir -p "$build"
cd "$build"
export SHERPA_ONNX_IS_USING_BUILD_WASM_SH=ON
cmake \
  -DCMAKE_INSTALL_PREFIX=./install \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_TOOLCHAIN_FILE="$EMSDK/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake" \
  -DSHERPA_ONNX_ENABLE_PYTHON=OFF \
  -DSHERPA_ONNX_ENABLE_TESTS=OFF \
  -DSHERPA_ONNX_ENABLE_CHECK=OFF \
  -DBUILD_SHARED_LIBS=OFF \
  -DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF \
  -DSHERPA_ONNX_ENABLE_JNI=OFF \
  -DSHERPA_ONNX_ENABLE_C_API=ON \
  -DSHERPA_ONNX_ENABLE_TTS=OFF \
  -DSHERPA_ONNX_ENABLE_WEBSOCKET=OFF \
  -DSHERPA_ONNX_ENABLE_GPU=OFF \
  -DSHERPA_ONNX_ENABLE_WASM=ON \
  -DSHERPA_ONNX_ENABLE_WASM_ASR=ON \
  -DSHERPA_ONNX_ENABLE_BINARY=OFF \
  -DSHERPA_ONNX_LINK_LIBSTDCPP_STATICALLY=OFF \
  .. > "$work/cmake.log"
make -j"$(nproc)" > "$work/make.log"
make install > /dev/null

bin=$build/install/bin/wasm/asr
cp "$bin/sherpa-onnx-wasm-main-asr.js" "$bin/sherpa-onnx-wasm-main-asr.wasm" "$bin/sherpa-onnx-asr.js" "$out/"

# The licences of what is compiled in: sherpa-onnx, what its CMake fetched,
# Emscripten's runtime, and ONNX Runtime (a prebuilt library that carries no
# licence file of its own).
lic=$out/licences
mkdir -p "$lic"
cp "$src/LICENSE" "$lic/sherpa-onnx.txt"
for dep in "$build"/_deps/*-src; do
  name=$(basename "$dep" -src)
  for f in "$dep"/LICENSE* "$dep"/COPYING*; do
    [[ -f $f ]] || continue
    suffix=$(basename "$f" | sed -E 's/^(LICENSE|COPYING)//')
    cp "$f" "$lic/$name${suffix}.txt"
  done
  # Some keep their licence texts in a directory of their own (kissfft's
  # COPYING only points there). nlohmann/json's also holds the GPL that
  # covers some of its tooling, none of which is compiled in: leave it out.
  if [[ -d $dep/LICENSES ]]; then
    for f in "$dep"/LICENSES/*; do
      [[ $(basename "$f") == *GPL* ]] && continue
      cp "$f" "$lic/$name.$(basename "$f" .txt).txt"
    done
  fi
done
cp "$EMSDK/upstream/emscripten/LICENSE" "$lic/emscripten.txt"
cp "$here/third-party/onnxruntime-LICENSE.txt" "$lic/onnxruntime.txt"

# What this was built from, for the release's manifest.
cat > "$out/build.json" <<EOF
{
  "sherpaOnnx": { "tag": "$SHERPA_ONNX_TAG", "commit": "$SHERPA_ONNX_COMMIT" },
  "emscripten": "$emcc_version",
  "patches": [$(cd "$here/patches" && ls *.patch | sed 's/.*/"&"/' | paste -sd,)]
}
EOF
ls -l "$out"
