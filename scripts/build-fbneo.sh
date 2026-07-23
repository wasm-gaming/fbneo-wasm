#!/usr/bin/env bash
set -euo pipefail

# Build FBNeo (FinalBurn Neo) WASM artifacts and write them to dist/fbneo/.
#
# FBNeo's SDL2 burner is driven from the repo-root `makefile.sdl2` (NAME=fbneo).
# We compile it with the Emscripten toolchain (emmake) and post-process the output
# into the two artifacts the SDK loader expects:
#   dist/fbneo/fbneo.js    (Emscripten module loader)
#   dist/fbneo/fbneo.wasm  (compiled runtime)
#
# NOTE: upstream FBNeo has no official Emscripten target. `makefile.sdl2` assumes a
# native desktop build (desktop OpenGL via vid_sdl2opengl, `sdl2-config`, pthreads,
# an SDL2 GUI). This script points the build at the correct makefile and splits the
# host/target compilers, but a fully working .wasm still needs upstream porting
# (GLES/WebGL video path, dropping sdl2-config, an ASYNCIFY-friendly main loop).

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="${WORK_DIR:-$PROJECT_DIR/.tmp/fbneo-build}"
TARGET_DIR="${TARGET_DIR:-$PROJECT_DIR/dist/fbneo}"
FBNEO_REPO="${FBNEO_REPO:-https://github.com/finalburnneo/FBNeo.git}"
FBNEO_REF="${FBNEO_REF:-master}"

ensure_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: required command '$1' is not available" >&2
    exit 1
  fi
}

echo "Setting up workspace..."
ensure_cmd git
ensure_cmd emmake
ensure_cmd emcc
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR" "$TARGET_DIR"

echo "Cloning FBNeo ($FBNEO_REF)..."
git clone --depth 1 --branch "$FBNEO_REF" "$FBNEO_REPO" "$WORK_DIR"

# The SDL2 burner is driven from the repo root makefile `makefile.sdl2`
# (NAME=fbneo). There is no `src/burner/sdl/makefile.burn`.
cd "$WORK_DIR"
test -f makefile.sdl2 || {
  echo "error: FBNeo makefile.sdl2 not found — upstream layout changed" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Emscripten porting patches for makefile.sdl2
#
# makefile.sdl2 targets a native desktop build; patch it for the emsdk toolchain:
#   1. It hardcodes `CC = gcc` (with `=`, so emmake's env cannot override it).
#      Point CC/CXX/LD at emcc/em++.
#   2. `sdl2-config` does not exist in emsdk — SDL2/SDL2_image ship as ports
#      enabled via `-sUSE_SDL=2 -sUSE_SDL_IMAGE=2`. Swap the backticked calls.
#   3. Drop desktop-only link libs (-lGL / -lopengl32 / -lSDL2_image / -lpthread);
#      Emscripten provides GL (WebGL) and SDL_image itself.
# ---------------------------------------------------------------------------
echo "Patching makefile.sdl2 for Emscripten..."
sed -i 's/^\(\s*\)CC\s*=\s*gcc/\1CC = emcc/' makefile.sdl2
sed -i 's/^CXX\s*=\s*\$(CC)/CXX = em++/' makefile.sdl2
sed -i 's/^LD\s*=\s*\$(CC)/LD = em++/' makefile.sdl2
sed -i 's/`sdl2-config --cflags`/-sUSE_SDL=2 -sUSE_SDL_IMAGE=2/g' makefile.sdl2
sed -i 's/`sdl2-config --libs`/-sUSE_SDL=2 -sUSE_SDL_IMAGE=2/g' makefile.sdl2
sed -i 's/-lGL //g; s/-lopengl32 //g; s/-lSDL2_image //g; s/-lpthread//g' makefile.sdl2
# 4. Emscripten infers output type from the suffix; the link recipe links to the
#    bare `$(NAME)` (fbneo). Emit `.js` so we get fbneo.js + fbneo.wasm. (Keep NAME
#    itself as `fbneo` — it also derives an object name, so overriding it breaks
#    the compile with a spurious `fbneo.js.o` target.)
sed -i 's/-o $@ $^ $(lib)/-o $@.js $^ $(lib)/g' makefile.sdl2

# Emscripten link flags: modularize under createFbneoModule, export FS/callMain so
# the SDK can write ROM zips into MEMFS and boot a driver by name. LEGACY_GL_EMULATION
# lets the desktop-GL video path (vid_sdl2opengl) resolve against WebGL; ASYNCIFY
# lets FBNeo's blocking SDL2 main loop cooperate with the browser event loop.
EM_LDFLAGS="${EM_LDFLAGS:-\
  -sMODULARIZE=1 \
  -sEXPORT_NAME=createFbneoModule \
  -sEXPORTED_RUNTIME_METHODS=FS,callMain \
  -sFORCE_FILESYSTEM=1 \
  -sINVOKE_RUN=0 \
  -sEXIT_RUNTIME=0 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=268435456 \
  -sUSE_SDL=2 \
  -sUSE_SDL_IMAGE=2 \
  -sLEGACY_GL_EMULATION=1 \
  -sASYNCIFY=1}"

# FBNeo is built through the ROOT makefile target `sdl2`, which runs
# `$(MAKE) -f makefile.sdl2`. That nesting is required: makefile.sdl2 uses
# MAKELEVEL to drive a multi-pass build (level 1 compiles + recurses, level 2
# links). Invoking `-f makefile.sdl2` directly starts at level 0 and never
# reaches the link rule (fails with a spurious `fbneo.o` no-input error).
#
# Overrides:
#   HOST_CC/HOST_CXX  native toolchain for code-generation host tools (m68kmake,
#                     the *.pl generators) — they must execute on the build host.
#   BUILD_X86_ASM / FASTCALL  x86-only; disabled for the wasm target.
#   RELEASEBUILD      drop -ggdb debug flags for a leaner build.
echo "Running emmake (this is a long compile)..."
emmake make sdl2 \
  HOST_CC="${HOST_CC:-cc}" HOST_CXX="${HOST_CXX:-c++}" \
  BUILD_X86_ASM= FASTCALL= RELEASEBUILD=1 \
  LDFLAGS="$EM_LDFLAGS"

# Locate the produced artifacts (upstream names the binary fbneo/fbarun; the
# link step above forces `-o fbneo.js`, which also emits fbneo.wasm alongside it).
JS_OUT="$(find "$WORK_DIR" -name 'fbneo.js' -print -quit)"
WASM_OUT="$(find "$WORK_DIR" -name 'fbneo.wasm' -print -quit)"
test -n "$JS_OUT" -a -f "$JS_OUT"
test -n "$WASM_OUT" -a -f "$WASM_OUT"

echo "Copying artifacts to $TARGET_DIR..."
cp "$JS_OUT" "$TARGET_DIR/fbneo.js"
cp "$WASM_OUT" "$TARGET_DIR/fbneo.wasm"

echo "-----------------------------------"
echo "FBNeo WASM artifacts available in $TARGET_DIR"
