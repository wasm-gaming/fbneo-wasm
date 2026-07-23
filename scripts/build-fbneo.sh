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
mkdir -p "$TARGET_DIR"

# Dev fast-path: FBNEO_INCREMENTAL=1 reuses an already-cloned+patched+compiled
# tree and only re-links (drop the final artifacts so make regenerates them with
# any changed link flags). Off by default so CI always does a clean build.
if [ "${FBNEO_INCREMENTAL:-}" = "1" ] && [ -f "$WORK_DIR/makefile.sdl2" ]; then
  echo "Incremental build: reusing existing tree at $WORK_DIR"
  cd "$WORK_DIR"
  rm -f fbneo.js fbneo.wasm obj/drivers.o
else
  rm -rf "$WORK_DIR"
  mkdir -p "$WORK_DIR"

  echo "Cloning FBNeo ($FBNEO_REF)..."
  git clone --depth 1 --branch "$FBNEO_REF" "$FBNEO_REPO" "$WORK_DIR"

  # The SDL2 burner is driven from the repo root makefile `makefile.sdl2`
  # (NAME=fbneo). There is no `src/burner/sdl/makefile.burn`.
  cd "$WORK_DIR"
  test -f makefile.sdl2 || {
    echo "error: FBNeo makefile.sdl2 not found — upstream layout changed" >&2
    exit 1
  }
fi

if [ "${FBNEO_INCREMENTAL:-}" != "1" ] || ! grep -q 'CC = emcc' "$WORK_DIR/makefile.sdl2"; then

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
# 5. emsdk's libc++ defines std::byte (C++17) as templates; FBNeo pulls <cstddef>
#    in through an `extern "C"` block (the m68k core headers include driver.h),
#    which clang rejects as "templates must have C++ linkage" (libstdc++ tolerates
#    it, libc++ does not). Force <cstddef> to be included first — outside any
#    extern "C" — so the later include hits its guard and is a no-op. Keeps C++17.
sed -i 's/^CXXFLAGS = -O2/CXXFLAGS = -include cstddef -O2/' makefile.sdl2
# 6. Emscripten's musl libc does not implement the MSVC `%hs` (narrow-string)
#    printf specifier — it expands to nothing. FBNeo (a Windows-first codebase)
#    uses `%hs` to build ROM archive paths in the SDL loader, so under emscripten
#    the game name is silently dropped ("/usr/local/share/roms/.zip") and no ROM
#    is ever found (every file reports "not found"). TCHAR is `char` in this
#    build, so `%hs` is equivalent to `%s`; rewrite it across the SDL burner
#    (ROM paths, config, savestates, screenshots).
find src/burner/sdl -name '*.cpp' -exec sed -i 's/%hs/%s/g' {} +
# 7. samples.cpp only compiles the dr_mp3 decoder implementation on Win32/libretro
#    (`INCLUDE_FLACMP3_SUPPORT`), but msu1_backend.cpp (SNES MSU1) references
#    drmp3_* unconditionally, so the link fails with undefined drmp3_* symbols.
#    Enable the FLAC/MP3 implementation for the emscripten target too.
sed -i 's/#if defined(BUILD_WIN32) || defined(__LIBRETRO__)/#if defined(BUILD_WIN32) || defined(__LIBRETRO__) || defined(__EMSCRIPTEN__)/' src/burn/snd/samples.cpp
# 8. RunMessageLoop() is a blocking `while (!quit)` loop; in the browser it never
#    returns control, so the tab hangs. With ASYNCIFY we yield each frame — and
#    pace to FBNeo's exact driver refresh rate (nBurnFPS, frames*100) using the
#    real-time clock (emscripten_get_now), so the emulation runs at native speed
#    independent of the monitor's refresh rate (30/60/144Hz). Also, the SDL2 loop
#    pauses the game on FOCUS_LOST — the canvas has no keyboard focus at boot, so
#    the game would start stuck on "PAUSE"; skip that auto-pause under emscripten.
python3 - <<'PYEOF'
p = 'src/burner/sdl/run.cpp'
s = open(p).read()
if '#include <emscripten.h>' not in s:
    s = s.replace('#include "burner.h"',
                  '#include "burner.h"\n#ifdef __EMSCRIPTEN__\n#include <emscripten.h>\n#endif', 1)
pace = (
    '\t\tRunIdle();\n'
    '#ifdef __EMSCRIPTEN__\n'
    '\t\t{\n'
    '\t\t\textern INT32 nBurnFPS;\n'
    '\t\t\tstatic double nextFrameMs = 0.0;\n'
    '\t\t\tdouble nowMs = emscripten_get_now();\n'
    '\t\t\tdouble frameMs = (nBurnFPS > 0) ? (100000.0 / (double)nBurnFPS) : (1000.0 / 60.0);\n'
    '\t\t\tif (nextFrameMs <= 0.0 || (nextFrameMs - nowMs) > 1000.0) nextFrameMs = nowMs;\n'
    '\t\t\tnextFrameMs += frameMs;\n'
    '\t\t\tdouble delayMs = nextFrameMs - nowMs;\n'
    '\t\t\tif (delayMs < 0.0) { delayMs = 0.0; nextFrameMs = nowMs; }\n'
    '\t\t\temscripten_sleep((unsigned)(delayMs + 0.5));\n'
    '\t\t}\n'
    '#endif\n\n\t}'
)
s = s.replace('\t\tRunIdle();\n\n\t}', pace, 1)
s = s.replace(
'''					case SDL_WINDOWEVENT_MINIMIZED:
					case SDL_WINDOWEVENT_FOCUS_LOST:
						pause_game();
						break;''',
'''					case SDL_WINDOWEVENT_MINIMIZED:
					case SDL_WINDOWEVENT_FOCUS_LOST:
#ifndef __EMSCRIPTEN__
						pause_game();
#endif
						break;''', 1)
# 9. GetTime() returns MICROSECONDS, but RunIdle()'s frame-pacing formula
#    (nCount = nTime * nAppVirtualFps / 100000) expects MILLISECONDS. On native
#    builds this path is dead (audio-sync drives timing), so the bug is dormant;
#    in the browser the audio-sync path isn't used, so the game runs ~100x too
#    fast (nCount saturates at the 100-frame cap). Return ms under emscripten.
s = s.replace(
    '\tticks = (now.tv_sec - start.tv_sec) * 1000000 + now.tv_usec - start.tv_usec;',
    '#ifdef __EMSCRIPTEN__\n'
    '\tticks = (now.tv_sec - start.tv_sec) * 1000 + (now.tv_usec - start.tv_usec) / 1000;\n'
    '#else\n'
    '\tticks = (now.tv_sec - start.tv_sec) * 1000000 + now.tv_usec - start.tv_usec;\n'
    '#endif', 1)
open(p, 'w').write(s)
PYEOF

# 10. Audio: the browser AudioContext is natively 32-bit float at (typically)
#     48000Hz, but FBNeo requests S16/44100. SDL either (a) hands the callback an
#     F32 buffer while our ring buffer is S16 — the play position then advances by
#     F32-sized byte counts over an S16 buffer, ~2x too fast — or (b) with a forced
#     S16 device the emscripten backend outputs silence. Fix: default the core to
#     48000Hz and produce AUDIO_F32 directly, converting the S16 ring buffer to
#     float in the callback and advancing the play position in S16 units. Then
#     consumption matches production and the audio-driven frame pacer runs at the
#     correct ~59.18fps, with real sound.
python3 - <<'PYEOF2'
# a) default core sample rate to 48000 under emscripten
p = 'src/intf/audio/aud_interface.cpp'
s = open(p).read()
s = s.replace(
    'INT32 nAudSampleRate[8] = { 44100, 44100, 22050, 22050, 22050, 22050, 22050, 22050 };',
    '#ifdef __EMSCRIPTEN__\n'
    'INT32 nAudSampleRate[8] = { 48000, 48000, 22050, 22050, 22050, 22050, 22050, 22050 };\n'
    '#else\n'
    'INT32 nAudSampleRate[8] = { 44100, 44100, 22050, 22050, 22050, 22050, 22050, 22050 };\n'
    '#endif', 1)
open(p, 'w').write(s)

# b) request AUDIO_F32, open via SDL_OpenAudioDevice with allowed_changes=0 (so a
#    non-48000 device is resampled by SDL to match the core), and convert the S16
#    ring buffer -> float in the callback
p = 'src/intf/audio/sdl/aud_sdl.cpp'
s = open(p).read()
s = s.replace(
    'static int nAudLoopLen;',
    'static int nAudLoopLen;\n#ifdef __EMSCRIPTEN__\nstatic SDL_AudioDeviceID nAudDevice = 0;\n#endif', 1)
s = s.replace(
    '''	if (SDL_OpenAudio(&audiospec_req, &audiospec))
	{
		fprintf(stderr, "Couldn't open audio: %s\\n", SDL_GetError());
		return 1;
	}''',
    '''#ifdef __EMSCRIPTEN__
	nAudDevice = SDL_OpenAudioDevice(NULL, 0, &audiospec_req, &audiospec, 0);
	if (nAudDevice == 0)
#else
	if (SDL_OpenAudio(&audiospec_req, &audiospec))
#endif
	{
		fprintf(stderr, "Couldn't open audio: %s\\n", SDL_GetError());
		return 1;
	}''', 1)
s = s.replace('\tSDL_PauseAudio(0);',
    '#ifdef __EMSCRIPTEN__\n\tSDL_PauseAudioDevice(nAudDevice, 0);\n#else\n\tSDL_PauseAudio(0);\n#endif', 1)
s = s.replace('\tSDL_PauseAudio(1);',
    '#ifdef __EMSCRIPTEN__\n\tSDL_PauseAudioDevice(nAudDevice, 1);\n#else\n\tSDL_PauseAudio(1);\n#endif', 1)
s = s.replace('\tSDL_CloseAudio();',
    '#ifdef __EMSCRIPTEN__\n\tif (nAudDevice) SDL_CloseAudioDevice(nAudDevice);\n#else\n\tSDL_CloseAudio();\n#endif', 1)
s = s.replace(
    '\taudiospec_req.format = AUDIO_S16;',
    '#ifdef __EMSCRIPTEN__\n'
    '\taudiospec_req.format = AUDIO_F32;   // Web Audio is natively 32-bit float\n'
    '#else\n'
    '\taudiospec_req.format = AUDIO_S16;\n'
    '#endif', 1)
s = s.replace(
'''void audiospec_callback(void* /* data */, Uint8* stream, int len)
{
#ifdef BUILD_SDL2
	SDL_memset(stream, 0, len);
#endif
	int end = nSDLPlayPos + len;''',
'''void audiospec_callback(void* /* data */, Uint8* stream, int len)
{
#ifdef __EMSCRIPTEN__
	// The browser AudioContext is 32-bit float; our ring buffer is S16. Convert
	// on the fly and advance the (S16-indexed) play position by one short per
	// output float, so consumption stays in sync with the S16 buffer -> the
	// audio-driven frame pacer runs at the correct rate.
	float* out = (float*)stream;
	int nFloats = len / (int)sizeof(float);
	float vol = (float)nSDLVolume / (float)SDL_MIX_MAXVOLUME;
	for (int i = 0; i < nFloats; i++) {
		if (nSDLPlayPos >= nAudLoopLen) nSDLPlayPos = 0;
		short sm = *(short*)((Uint8*)SDLAudBuffer + nSDLPlayPos);
		out[i] = (sm * (1.0f / 32768.0f)) * vol;
		nSDLPlayPos += (int)sizeof(short);
	}
	return;
#endif
#ifdef BUILD_SDL2
	SDL_memset(stream, 0, len);
#endif
	int end = nSDLPlayPos + len;''')
open(p, 'w').write(s)
PYEOF2
fi  # end patch block (skipped when reusing an already-patched incremental tree)

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
  -sALLOW_MEMORY_GROWTH=0 \
  -sINITIAL_MEMORY=536870912 \
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
# When this script is itself launched from a make recipe (e.g. `make
# build-wasm-ci` in CI), make exports MAKELEVEL=1 into our environment. FBNeo's
# makefile.sdl2 keys its multi-pass build on MAKELEVEL (1 = init+compile,
# 2 = link), so the leaked value skips the init/compile pass and jumps straight
# to the link-only pass — failing with "cannot open output file obj/..." because
# `init` never created the obj directories. Reset it so the pass sequence starts
# from the top regardless of how this script was invoked.
unset MAKELEVEL

echo "Running emmake (this is a long compile)..."
emmake make sdl2 \
  HOST_CC="${HOST_CC:-cc}" HOST_CXX="${HOST_CXX:-c++}" \
  BUILD_X86_ASM= FASTCALL= RELEASEBUILD=1 SKIPDEPEND=1 \
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
