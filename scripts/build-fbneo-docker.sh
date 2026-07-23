#!/usr/bin/env bash
set -euo pipefail

# Local wrapper: run the FBNeo WASM build inside Docker (emscripten/emsdk).

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_SCRIPT="/workspace/scripts/build-fbneo.sh"

echo "Building FBNeo WASM via Docker..."
docker run --rm \
    -v "$PROJECT_DIR:/workspace" \
    -w /workspace \
    emscripten/emsdk:latest \
    bash -c "
      set -euo pipefail
      echo 'Installing build tools...'
      apt-get update -qq && apt-get install -y git make wget tar build-essential -qq
      test -x $BUILD_SCRIPT || chmod +x $BUILD_SCRIPT
      $BUILD_SCRIPT
    "
