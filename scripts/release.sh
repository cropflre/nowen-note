#!/usr/bin/env bash
# Issue #329 release guard.
#
# The original release implementation is preserved in release-legacy.sh. This
# wrapper adds release-safety invariants without duplicating the 2,800-line flow:
#   1. clean the output directory selected for this run, preventing stale output
#      from winning the legacy candidate-order lookup;
#   2. stage new GitHub Releases as drafts;
#   3. download and verify remote updater metadata/assets before publishing;
#   4. normalize release-only native/Android toolchains to supported baselines.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LEGACY_SCRIPT="${SCRIPT_DIR}/release-legacy.sh"
VERIFY_SCRIPT="${SCRIPT_DIR}/verify-release-update-assets.mjs"
GITHUB_REPO_SLUG="cropflre/nowen-note"
ANDROID_NODE22_IMAGE="cimg/android:2025.10.1-node"

[ -f "$LEGACY_SCRIPT" ] || { echo "[release-guard] missing $LEGACY_SCRIPT" >&2; exit 1; }

ARGS=("$@")
DRY_RUN=0
BUILD_ONLY=0
USER_REQUESTED_DRAFT=0
HELP_ONLY=0
ASSUME_YES=0
TARGETS=""
TARGETS_EXPLICIT=0
ANDROID_DOCKER_REQUESTED=0
ANDROID_DOCKER_SYNC_REQUESTED=0
ANDROID_DOCKER_IMAGE_EXPLICIT=0

for ((i = 0; i < ${#ARGS[@]}; i += 1)); do
  arg="${ARGS[$i]}"
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --build-only) BUILD_ONLY=1 ;;
    --draft) USER_REQUESTED_DRAFT=1 ;;
    -h|--help) HELP_ONLY=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    --android-docker) ANDROID_DOCKER_REQUESTED=1 ;;
    --android-docker-sync) ANDROID_DOCKER_SYNC_REQUESTED=1 ;;
    --android-docker-image|--android-docker-image=*) ANDROID_DOCKER_IMAGE_EXPLICIT=1 ;;
    --target)
      if (( i + 1 < ${#ARGS[@]} )); then
        TARGETS="${ARGS[$((i + 1))]}"
        TARGETS_EXPLICIT=1
        i=$((i + 1))
      fi
      ;;
  esac
done

# Linux desktop release artifacts contain better-sqlite3, so their ABI must be
# built against the project's glibc 2.31 / GLIBCXX 3.4.28 compatibility
# baseline rather than whatever newer libc happens to be installed on the
# maintainer workstation (WSL/Ubuntu 24.04 is a common example).
#
# rebuild-native-entry.mjs only applies this flag when the actual target is
# Linux, so cross-building Windows/macOS from the same release run is unaffected.
# Keep an explicit caller override, and only auto-enable when Docker is usable;
# older Linux hosts without Docker can still use the native path and will be
# checked by builder.config.js before packaging.
if [ "$(uname -s 2>/dev/null || true)" = "Linux" ] && [ -z "${NOWEN_LINUX_PORTABLE+x}" ]; then
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    export NOWEN_LINUX_PORTABLE=1
    echo "[release-guard] Linux native modules: portable glibc 2.31 baseline enabled"
  else
    echo "[release-guard] Docker unavailable; Linux native modules will use the host toolchain and compatibility checks" >&2
  fi
fi

# Capacitor 8 requires Node.js >= 22. The maintainer workstation may still use
# Node 20 because Electron/backend tooling supports it, so do not force a global
# Node upgrade just to release Android. Instead, when the host runtime is older,
# route the Android web build + `cap sync` + Gradle build through a pinned CircleCI
# Android image whose default Node is 22.19.0. This keeps desktop release tooling
# untouched and makes the one-shot release deterministic.
if [ "$HELP_ONLY" = "0" ] && [ "$BUILD_ONLY" = "0" ]; then
  HOST_NODE_MAJOR=0
  HOST_NODE_VERSION="missing"
  if command -v node >/dev/null 2>&1; then
    HOST_NODE_VERSION="$(node -p 'process.versions.node' 2>/dev/null || echo unknown)"
    HOST_NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
  fi

  if [ "${HOST_NODE_MAJOR:-0}" -lt 22 ]; then
    if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
      if [ "$ANDROID_DOCKER_REQUESTED" = "0" ]; then
        ARGS+=("--android-docker")
      fi
      if [ "$ANDROID_DOCKER_SYNC_REQUESTED" = "0" ]; then
        ARGS+=("--android-docker-sync")
      fi
      if [ "$ANDROID_DOCKER_IMAGE_EXPLICIT" = "0" ]; then
        ARGS+=("--android-docker-image" "$ANDROID_NODE22_IMAGE")
      fi
      echo "[release-guard] host Node ${HOST_NODE_VERSION} < 22; Android build/sync will use Docker (${ANDROID_NODE22_IMAGE})"
    else
      echo "[release-guard] host Node ${HOST_NODE_VERSION} < 22 and Docker is unavailable; Capacitor 8 Android targets require Node.js >= 22" >&2
    fi
  fi
fi

clean_directory() {
  local directory="$1"
  [ -e "$directory" ] || return 0
  echo "[release-guard] cleaning stale build output: $directory"
  rm -rf -- "$directory"
}

if [ "$HELP_ONLY" = "0" ] && [ "$DRY_RUN" = "0" ] && [ "$BUILD_ONLY" = "0" ]; then
  CLEAN_FULL=0
  CLEAN_LITE=0
  if [ "$TARGETS_EXPLICIT" = "1" ]; then
    case ",${TARGETS}," in
      *,all,*|*,pc,*|*,linux-app,*) CLEAN_FULL=1 ;;
    esac
    case ",${TARGETS}," in
      *,all,*|*,lite,*) CLEAN_LITE=1 ;;
    esac
  elif [ "$ASSUME_YES" = "0" ]; then
    # The interactive wizard decides later; clean both desktop outputs so either
    # choice starts from a deterministic directory.
    CLEAN_FULL=1
    CLEAN_LITE=1
  fi

  TEMP_ROOT="$(node -e 'process.stdout.write(require("os").tmpdir())')"
  if [ "$CLEAN_FULL" = "1" ]; then
    clean_directory "${REPO_ROOT}/dist-electron"
    clean_directory "${TEMP_ROOT}/nowen-note-build"
  fi
  if [ "$CLEAN_LITE" = "1" ]; then
    clean_directory "${REPO_ROOT}/dist-electron-lite"
    clean_directory "${TEMP_ROOT}/nowen-note-lite-build"
  fi
fi

LEGACY_ARGS=("${ARGS[@]}")
if [ "$HELP_ONLY" = "0" ] && [ "$DRY_RUN" = "0" ] && [ "$BUILD_ONLY" = "0" ] && [ "$USER_REQUESTED_DRAFT" = "0" ]; then
  # New releases remain invisible until the remote metadata/asset verification
  # succeeds. Existing releases are moved to draft if a clobber verification fails.
  LEGACY_ARGS+=("--draft")
fi

if [ "$HELP_ONLY" = "1" ] || [ "$DRY_RUN" = "1" ] || [ "$BUILD_ONLY" = "1" ]; then
  exec bash "$LEGACY_SCRIPT" "${LEGACY_ARGS[@]}"
fi

LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/nowen-release-guard.XXXXXX.log")"
cleanup() { rm -f -- "$LOG_FILE"; }
trap cleanup EXIT

set +e
bash "$LEGACY_SCRIPT" "${LEGACY_ARGS[@]}" 2>&1 | tee "$LOG_FILE"
LEGACY_STATUS=${PIPESTATUS[0]}
set -e
if [ "$LEGACY_STATUS" -ne 0 ]; then
  exit "$LEGACY_STATUS"
fi

# Docker-only/local-only runs do not create a GitHub Release.
if ! grep -q "GitHub Release 已发布" "$LOG_FILE"; then
  exit 0
fi

command -v gh >/dev/null 2>&1 || { echo "[release-guard] gh is required for remote verification" >&2; exit 1; }
VERSION="$(cd "$REPO_ROOT" && node -p 'require("./package.json").version' 2>/dev/null || true)"
[ -n "$VERSION" ] || { echo "[release-guard] unable to read package.json version" >&2; exit 1; }
TAG="v${VERSION}"

echo
echo "==== 验证 GitHub Release 更新元数据与远端资产 ===="
if ! node "$VERIFY_SCRIPT" remote --repo "$GITHUB_REPO_SLUG" --tag "$TAG" --version "$VERSION"; then
  echo "[release-guard] remote update verification failed; keeping ${TAG} as draft" >&2
  gh release edit "$TAG" --repo "$GITHUB_REPO_SLUG" --draft=true >/dev/null 2>&1 || true
  exit 1
fi

if [ "$USER_REQUESTED_DRAFT" = "1" ]; then
  gh release edit "$TAG" --repo "$GITHUB_REPO_SLUG" --draft=true >/dev/null
  echo "[release-guard] verification passed; release remains draft by explicit request"
  exit 0
fi

IS_DRAFT="$(gh release view "$TAG" --repo "$GITHUB_REPO_SLUG" --json isDraft --jq '.isDraft' 2>/dev/null || echo false)"
if [ "$IS_DRAFT" = "true" ]; then
  gh release edit "$TAG" --repo "$GITHUB_REPO_SLUG" --draft=false >/dev/null
  echo "[release-guard] verification passed; ${TAG} published"
else
  echo "[release-guard] verification passed; existing ${TAG} remains published"
fi
