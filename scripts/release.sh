#!/usr/bin/env bash
# Issue #329 release guard.
#
# The original release implementation is preserved in release-legacy.sh. This
# wrapper adds three invariants without duplicating the 2,800-line build flow:
#   1. clean the output directory selected for this run, preventing stale output
#      from winning the legacy candidate-order lookup;
#   2. stage new GitHub Releases as drafts;
#   3. download and verify remote updater metadata/assets before publishing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LEGACY_SCRIPT="${SCRIPT_DIR}/release-legacy.sh"
VERIFY_SCRIPT="${SCRIPT_DIR}/verify-release-update-assets.mjs"
GITHUB_REPO_SLUG="cropflre/nowen-note"

[ -f "$LEGACY_SCRIPT" ] || { echo "[release-guard] missing $LEGACY_SCRIPT" >&2; exit 1; }

ARGS=("$@")
DRY_RUN=0
BUILD_ONLY=0
USER_REQUESTED_DRAFT=0
HELP_ONLY=0
ASSUME_YES=0
TARGETS=""
TARGETS_EXPLICIT=0

for ((i = 0; i < ${#ARGS[@]}; i += 1)); do
  arg="${ARGS[$i]}"
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --build-only) BUILD_ONLY=1 ;;
    --draft) USER_REQUESTED_DRAFT=1 ;;
    -h|--help) HELP_ONLY=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    --target)
      if (( i + 1 < ${#ARGS[@]} )); then
        TARGETS="${ARGS[$((i + 1))]}"
        TARGETS_EXPLICIT=1
        i=$((i + 1))
      fi
      ;;
  esac
done

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
