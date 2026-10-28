#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCH="${TARGET_ARCH:-${npm_config_target_arch:-$(uname -m)}}"
case "$ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  aarch64) ARCH="arm64" ;;
esac

if [[ "$ARCH" != "x64" && "$ARCH" != "arm64" ]]; then
  echo "[linux-native] unsupported architecture: $ARCH" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "[linux-native] Docker is required to build against the glibc 2.31 baseline." >&2
  exit 1
fi

cd "$ROOT"
IMAGE="nowen-note-linux-native:node24.22.1-bullseye"
docker build -f scripts/Dockerfile.linux-native -t "$IMAGE" .
echo "[linux-native] rebuilding better-sqlite3 with Node 24.22.1 on glibc 2.31 for linux-$ARCH"
# GCC 12 cannot combine V8's deprecation and visibility attributes. Disable only
# those annotations; static C++ runtimes keep the existing GLIBCXX baseline.
docker run --rm \
  -e HOME=/tmp/nowen-home \
  -e npm_config_cache=/tmp/nowen-npm-cache \
  -e CXXFLAGS=-UV8_DEPRECATION_WARNINGS \
  -e 'LDFLAGS=-static-libstdc++ -static-libgcc' \
  -e NOWEN_LINUX_BASELINE_CONTAINER=1 \
  -v "$ROOT:/workspace" \
  -w /workspace \
  "$IMAGE" \
  bash -lc "node scripts/rebuild-native.mjs --target-platform=linux --target-arch=$ARCH"

if command -v sudo >/dev/null 2>&1; then
  sudo chown -R "$(id -u):$(id -g)" backend/node_modules/better-sqlite3
else
  chown -R "$(id -u):$(id -g)" backend/node_modules/better-sqlite3 2>/dev/null || true
fi

TARGET_ARCH="$ARCH" npm run check:linux-native
TARGET_ARCH="$ARCH" npm run smoke:linux-native
