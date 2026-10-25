#!/usr/bin/env bash
# Issue #329 release guard.
#
# The original release implementation is preserved in release-legacy.sh. This
# wrapper adds release-safety invariants without duplicating the 2,800-line flow:
#   1. clean the output directory selected for this run, preventing stale output
#      from winning the legacy candidate-order lookup;
#   2. stage new GitHub Releases as drafts;
#   3. dispatch same-tag CI asset collection and remote verification inside GitHub;
#   4. check the CI receipt against the current Release asset inventory;
#   5. publish only after the successful CI collection/verification run;
#   6. normalize release-only native/Android toolchains to supported baselines.
set -euo pipefail

if [[ "${NODE_OPTIONS:-}" != *--max-old-space-size* && "${NODE_OPTIONS:-}" != *--max_old_space_size* ]]; then
  export NODE_OPTIONS="${NODE_OPTIONS:+${NODE_OPTIONS} }--max-old-space-size=4096"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LEGACY_SCRIPT="${SCRIPT_DIR}/release-legacy.sh"
CI_ASSETS_SCRIPT="${SCRIPT_DIR}/release-ci-assets.mjs"
GITHUB_REPO_SLUG="cropflre/nowen-note"
ANDROID_NODE22_IMAGE="cimg/android:2025.10.1-node"

[ -f "$LEGACY_SCRIPT" ] || { echo "[release-guard] missing $LEGACY_SCRIPT" >&2; exit 1; }

ARGS=("$@")
DRY_RUN=0
BUILD_ONLY=0
USER_REQUESTED_DRAFT=0
HELP_ONLY=0
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
    --android-docker) ANDROID_DOCKER_REQUESTED=1 ;;
    --android-docker-sync) ANDROID_DOCKER_SYNC_REQUESTED=1 ;;
    --android-docker-image|--android-docker-image=*) ANDROID_DOCKER_IMAGE_EXPLICIT=1 ;;
  esac
done

if [ "$(uname -s 2>/dev/null || true)" = "Linux" ] && [ -z "${NOWEN_LINUX_PORTABLE+x}" ]; then
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    export NOWEN_LINUX_PORTABLE=1
    echo "[release-guard] Linux native modules: portable glibc 2.31 baseline enabled"
  else
    echo "[release-guard] Docker unavailable; Linux native modules will use the host toolchain and compatibility checks" >&2
  fi
fi

if [ "$HELP_ONLY" = "0" ] && [ "$BUILD_ONLY" = "0" ]; then
  HOST_NODE_MAJOR=0
  HOST_NODE_VERSION="missing"
  if command -v node >/dev/null 2>&1; then
    HOST_NODE_VERSION="$(node -p 'process.versions.node' 2>/dev/null || echo unknown)"
    HOST_NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
  fi

  if [ "${HOST_NODE_MAJOR:-0}" -lt 22 ]; then
    if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
      if [ "$ANDROID_DOCKER_REQUESTED" = "0" ]; then ARGS+=("--android-docker"); fi
      if [ "$ANDROID_DOCKER_SYNC_REQUESTED" = "0" ]; then ARGS+=("--android-docker-sync"); fi
      if [ "$ANDROID_DOCKER_IMAGE_EXPLICIT" = "0" ]; then ARGS+=("--android-docker-image" "$ANDROID_NODE22_IMAGE"); fi
      echo "[release-guard] host Node ${HOST_NODE_VERSION} < 22; Android build/sync will use Docker (${ANDROID_NODE22_IMAGE})"
    else
      echo "[release-guard] host Node ${HOST_NODE_VERSION} < 22 and Docker is unavailable; Capacitor 8 Android targets require Node.js >= 22" >&2
    fi
  fi
fi

LEGACY_ARGS=("${ARGS[@]}")
if [ "$HELP_ONLY" = "0" ] && [ "$DRY_RUN" = "0" ] && [ "$BUILD_ONLY" = "0" ] && [ "$USER_REQUESTED_DRAFT" = "0" ]; then
  LEGACY_ARGS+=("--draft")
fi

if [ "$HELP_ONLY" = "1" ] || [ "$BUILD_ONLY" = "1" ]; then
  exec bash "$LEGACY_SCRIPT" "${LEGACY_ARGS[@]}"
fi
if [ "$DRY_RUN" = "1" ]; then
  NOWEN_RELEASE_GUARDED=1 exec bash "$LEGACY_SCRIPT" "${LEGACY_ARGS[@]}"
fi

LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/nowen-release-guard.XXXXXX.log")"
cleanup() {
  rm -f -- "$LOG_FILE"
}
trap cleanup EXIT

set +e
NOWEN_RELEASE_GUARDED=1 bash "$LEGACY_SCRIPT" "${LEGACY_ARGS[@]}" 2>&1 | tee "$LOG_FILE"
LEGACY_STATUS=${PIPESTATUS[0]}
set -e
if [ "$LEGACY_STATUS" -ne 0 ]; then exit "$LEGACY_STATUS"; fi

if ! grep -q "GitHub Release 产物已上传" "$LOG_FILE"; then exit 0; fi

command -v gh >/dev/null 2>&1 || { echo "[release-guard] gh is required for remote verification" >&2; exit 1; }
VERSION="$(cd "$REPO_ROOT" && node -p 'require("./package.json").version' 2>/dev/null || true)"
[ -n "$VERSION" ] || { echo "[release-guard] unable to read package.json version" >&2; exit 1; }
TAG="v${VERSION}"
RELEASE_ASSET_NAMES="$(gh release view "$TAG" --repo "$GITHUB_REPO_SLUG" --json assets --jq '.assets[].name')"

release_contains_windows_candidates() {
  printf '%s\n' "$RELEASE_ASSET_NAMES" \
    | grep -Eq "^Nowen-Note(-Lite)?-${VERSION}-(setup|portable)\\.exe$"
}

ensure_desktop_platform_notes() {
  local body
  local marker="### 桌面端支持"
  body="$(gh release view "$TAG" --repo "$GITHUB_REPO_SLUG" --json body --jq '.body // ""' 2>/dev/null || true)"
  if printf '%s\n' "$body" | grep -Fq "$marker"; then return 0; fi

  local platform_notes
  platform_notes=$'### 桌面端支持\n- Windows x64（GitHub 直接下载，安装包当前未提供代码签名）\n- macOS Intel x64\n- macOS Apple Silicon arm64\n- Linux x64'
  local updated_body="$platform_notes"
  if [ -n "$body" ]; then updated_body="${body}"$'\n\n'"${platform_notes}"; fi

  gh release edit "$TAG" --repo "$GITHUB_REPO_SLUG" --notes "$updated_body" >/dev/null
}

wait_for_tag_workflow_run() {
  local tag_sha="$1"
  local deadline="$2"
  local run_id=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    run_id="$(gh run list \
      --repo "$GITHUB_REPO_SLUG" \
      --workflow release.yml \
      --event push \
      --commit "$tag_sha" \
      --branch "$TAG" \
      --limit 10 \
      --json databaseId,createdAt \
      --jq 'sort_by(.createdAt) | last | .databaseId // empty')" || return 1
    if [ -n "$run_id" ]; then printf '%s' "$run_id"; return 0; fi
    echo "[release-guard] waiting for same-tag build workflow: ${TAG}" >&2
    sleep 5
  done
  return 1
}

# Local publication only transfers status, the small CI receipt and asset inventory.
# Desktop binaries and remote verification stay inside GitHub's network.
COLLECT_DESKTOP=false
COLLECT_WINDOWS=false
COLLECT_LINUX=false
if grep -q "PC 产物" "$LOG_FILE"; then
  COLLECT_DESKTOP=true
  ensure_desktop_platform_notes
fi
if grep -Eq "PC 产物|Lite 版产物" "$LOG_FILE" && release_contains_windows_candidates; then COLLECT_WINDOWS=true; fi
CI_PLATFORMS="$(sed -n 's/^NOWEN_RELEASE_CI_PLATFORMS=//p' "$LOG_FILE" | tail -n 1)"
if [ -n "$CI_PLATFORMS" ]; then
  case ",${CI_PLATFORMS}," in *,mac,*) COLLECT_DESKTOP=true ;; esac
  case ",${CI_PLATFORMS}," in *,win,*) COLLECT_WINDOWS=true ;; esac
  case ",${CI_PLATFORMS}," in *,linux,*) COLLECT_LINUX=true ;; esac
  if [ "$COLLECT_DESKTOP" = "true" ] && [ "$COLLECT_WINDOWS" = "true" ] && [ "$COLLECT_LINUX" = "true" ]; then
    ensure_desktop_platform_notes
  fi
fi

TAG_SHA="$(git -C "$REPO_ROOT" rev-list -n 1 "$TAG")"
TIMEOUT_SECONDS="${NOWEN_RELEASE_CI_ARTIFACT_TIMEOUT_SECONDS:-10800}"
[[ "$TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || { echo "[release-guard] invalid CI timeout" >&2; exit 1; }
DEADLINE=$((SECONDS + TIMEOUT_SECONDS))
SOURCE_RUN_ID="$(wait_for_tag_workflow_run "$TAG_SHA" "$DEADLINE")" || {
  echo "[release-guard] same-tag build workflow not found; ${TAG} remains Draft" >&2
  exit 1
}
REQUEST_ID="$(node -e 'console.log(require("node:crypto").randomUUID())')"
echo "==== GitHub 内汇总产物并校验 Draft ===="
gh workflow run release.yml --repo "$GITHUB_REPO_SLUG" --ref "$TAG" \
  -f mode=release-assets -f source_run_id="$SOURCE_RUN_ID" -f request_id="$REQUEST_ID" \
  -F desktop="$COLLECT_DESKTOP" -F windows="$COLLECT_WINDOWS" -F linux="$COLLECT_LINUX"

CI_RUN_ID=""
while [ "$SECONDS" -lt "$DEADLINE" ]; do
  CI_RUN_ID="$(gh run list --repo "$GITHUB_REPO_SLUG" --workflow release.yml \
    --event workflow_dispatch --branch "$TAG" --commit "$TAG_SHA" --limit 20 \
    --json databaseId,displayTitle --jq ".[] | select(.displayTitle == \"Release assets ${REQUEST_ID}\") | .databaseId")"
  if [ -n "$CI_RUN_ID" ]; then break; fi
  echo "[release-guard] waiting for CI collection run (${REQUEST_ID})"
  sleep 10
done
[ -n "$CI_RUN_ID" ] || { echo "[release-guard] CI collection run not found; ${TAG} remains Draft" >&2; exit 1; }
echo "[release-guard] https://github.com/${GITHUB_REPO_SLUG}/actions/runs/${CI_RUN_ID}"
while [ "$SECONDS" -lt "$DEADLINE" ]; do
  CI_STATE="$(gh run view "$CI_RUN_ID" --repo "$GITHUB_REPO_SLUG" --json status,conclusion \
    --jq '[.status, (.conclusion // "")] | join(":")')"
  echo "[release-guard] CI collection/verification: ${CI_STATE}"
  if [[ "$CI_STATE" == completed:* ]]; then break; fi
  sleep 30
done
if [ "${CI_STATE:-}" != "completed:success" ]; then
  echo "[release-guard] CI collection/verification failed or timed out; ${TAG} remains Draft" >&2
  exit 1
fi
node "$CI_ASSETS_SCRIPT" check --tag "$TAG" --sha "$TAG_SHA" \
  --source-run "$SOURCE_RUN_ID" --run "$CI_RUN_ID" --request "$REQUEST_ID" \
  --desktop "$COLLECT_DESKTOP" --windows "$COLLECT_WINDOWS" --linux "$COLLECT_LINUX"

if [ "$USER_REQUESTED_DRAFT" = "1" ]; then
  gh release edit "$TAG" --repo "$GITHUB_REPO_SLUG" --draft=true >/dev/null
  echo "[release-guard] verification passed; release remains draft by explicit request"
  exit 0
fi

IS_DRAFT="$(gh release view "$TAG" --repo "$GITHUB_REPO_SLUG" --json isDraft --jq '.isDraft')"
if [ "$IS_DRAFT" = "true" ]; then
  gh release edit "$TAG" --repo "$GITHUB_REPO_SLUG" --draft=false >/dev/null
  echo "[release-guard] verification passed; ${TAG} published"
else
  echo "[release-guard] verification passed; existing ${TAG} remains published"
fi

echo "[release-guard] 发布成功：https://github.com/${GITHUB_REPO_SLUG}/releases/tag/${TAG}"
