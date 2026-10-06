#!/usr/bin/env bash
# Issue #329 release guard.
#
# The original release implementation is preserved in release-legacy.sh. This
# wrapper adds release-safety invariants without duplicating the 2,800-line flow:
#   1. clean the output directory selected for this run, preventing stale output
#      from winning the legacy candidate-order lookup;
#   2. stage new GitHub Releases as drafts;
#   3. replace local Windows candidates with SignPath-signed CI artifacts;
#   4. collect CI-only macOS artifacts into that draft without letting Actions publish;
#   5. download and verify remote updater metadata/assets before publishing;
#   6. normalize release-only native/Android toolchains to supported baselines.
set -euo pipefail

if [[ "${NODE_OPTIONS:-}" != *--max-old-space-size* && "${NODE_OPTIONS:-}" != *--max_old_space_size* ]]; then
  export NODE_OPTIONS="${NODE_OPTIONS:+${NODE_OPTIONS} }--max-old-space-size=4096"
fi

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
    case ",${TARGETS}," in *,all,*|*,pc,*|*,linux-app,*) CLEAN_FULL=1 ;; esac
    case ",${TARGETS}," in *,all,*|*,lite,*) CLEAN_LITE=1 ;; esac
  elif [ "$ASSUME_YES" = "0" ]; then
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
  LEGACY_ARGS+=("--draft")
fi

if [ "$HELP_ONLY" = "1" ] || [ "$DRY_RUN" = "1" ] || [ "$BUILD_ONLY" = "1" ]; then
  exec bash "$LEGACY_SCRIPT" "${LEGACY_ARGS[@]}"
fi

LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/nowen-release-guard.XXXXXX.log")"
CI_ARTIFACT_DIR=""
cleanup() {
  rm -f -- "$LOG_FILE"
  if [ -n "$CI_ARTIFACT_DIR" ]; then rm -rf -- "$CI_ARTIFACT_DIR"; fi
}
trap cleanup EXIT

set +e
bash "$LEGACY_SCRIPT" "${LEGACY_ARGS[@]}" 2>&1 | tee "$LOG_FILE"
LEGACY_STATUS=${PIPESTATUS[0]}
set -e
if [ "$LEGACY_STATUS" -ne 0 ]; then exit "$LEGACY_STATUS"; fi

if ! grep -q "GitHub Release 已发布" "$LOG_FILE"; then exit 0; fi

command -v gh >/dev/null 2>&1 || { echo "[release-guard] gh is required for remote verification" >&2; exit 1; }
VERSION="$(cd "$REPO_ROOT" && node -p 'require("./package.json").version' 2>/dev/null || true)"
[ -n "$VERSION" ] || { echo "[release-guard] unable to read package.json version" >&2; exit 1; }
TAG="v${VERSION}"

required_mac_asset_names() {
  cat <<EOF
Nowen-Note-${VERSION}-x64.dmg
Nowen-Note-${VERSION}-arm64.dmg
Nowen-Note-${VERSION}-x64.zip
Nowen-Note-${VERSION}-arm64.zip
latest-mac.yml
EOF
}

required_windows_asset_names() {
  cat <<EOF
Nowen-Note-${VERSION}-setup.exe
Nowen-Note-${VERSION}-portable.exe
Nowen-Note-${VERSION}-setup.exe.blockmap
latest.yml
Nowen-Note-Lite-${VERSION}-setup.exe
Nowen-Note-Lite-${VERSION}-portable.exe
Nowen-Note-Lite-${VERSION}-setup.exe.blockmap
latest-lite.yml
EOF
}

release_has_complete_mac_assets() {
  local asset_names
  asset_names="$(gh release view "$TAG" --repo "$GITHUB_REPO_SLUG" --json assets --jq '.assets[].name' 2>/dev/null || true)"
  local required
  while IFS= read -r required; do
    [ -n "$required" ] || continue
    if ! printf '%s\n' "$asset_names" | grep -Fxq "$required"; then return 1; fi
  done < <(required_mac_asset_names)
  return 0
}

release_contains_windows_candidates() {
  gh release view "$TAG" --repo "$GITHUB_REPO_SLUG" --json assets --jq '.assets[].name' 2>/dev/null \
    | grep -Eq "^Nowen-Note(-Lite)?-${VERSION}-(setup|portable)\\.exe$"
}

ensure_desktop_platform_notes() {
  local body
  local marker="### 桌面端支持"
  body="$(gh release view "$TAG" --repo "$GITHUB_REPO_SLUG" --json body --jq '.body // ""' 2>/dev/null || true)"
  if printf '%s\n' "$body" | grep -Fq "$marker"; then return 0; fi

  local platform_notes
  platform_notes=$'### 桌面端支持\n- Windows x64（SignPath 签名）\n- macOS Intel x64\n- macOS Apple Silicon arm64\n- Linux x64'
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
      --limit 10 \
      --json databaseId,createdAt \
      --jq 'sort_by(.createdAt) | last | .databaseId // empty' 2>/dev/null || true)"
    if [ -n "$run_id" ]; then printf '%s' "$run_id"; return 0; fi
    sleep 5
  done
  return 1
}

wait_for_workflow_artifact() {
  local run_id="$1"
  local artifact_name="$2"
  local deadline="$3"
  local artifact_id=""
  local run_state=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    artifact_id="$(gh api \
      "repos/${GITHUB_REPO_SLUG}/actions/runs/${run_id}/artifacts?per_page=100" \
      --jq ".artifacts[] | select(.name == \"${artifact_name}\" and .expired == false) | .id" \
      2>/dev/null | head -n1 || true)"
    if [ -n "$artifact_id" ]; then printf '%s' "$artifact_id"; return 0; fi

    run_state="$(gh run view "$run_id" --repo "$GITHUB_REPO_SLUG" --json status,conclusion \
      --jq '[.status, (.conclusion // "")] | join(":")' 2>/dev/null || true)"
    if [[ "$run_state" == completed:* ]]; then
      echo "[release-guard] ${artifact_name} missing after workflow completed (${run_state})" >&2
      return 1
    fi
    sleep 10
  done
  return 1
}

collect_ci_signed_windows_assets() {
  local timeout_seconds="${NOWEN_RELEASE_CI_ARTIFACT_TIMEOUT_SECONDS:-10800}"
  local deadline=$((SECONDS + timeout_seconds))
  local tag_sha run_id artifact_id temp_dir
  tag_sha="$(git -C "$REPO_ROOT" rev-list -n 1 "$TAG" 2>/dev/null || true)"
  [ -n "$tag_sha" ] || { echo "[release-guard] cannot resolve ${TAG} commit" >&2; return 1; }

  echo
  echo "==== 汇总 SignPath 已签名 Windows 构建产物 ===="
  if ! run_id="$(wait_for_tag_workflow_run "$tag_sha" "$deadline")"; then
    echo "[release-guard] tag workflow did not appear within ${timeout_seconds}s" >&2
    return 1
  fi
  echo "[release-guard] workflow run: ${run_id}"

  if ! artifact_id="$(wait_for_workflow_artifact "$run_id" "nowen-note-win-signed" "$deadline")"; then
    echo "[release-guard] timed out or failed waiting for SignPath-signed Windows artifact" >&2
    return 1
  fi
  [ -n "$artifact_id" ] || return 1

  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/nowen-release-win-signed.XXXXXX")"
  if ! gh run download "$run_id" --repo "$GITHUB_REPO_SLUG" --name nowen-note-win-signed --dir "$temp_dir"; then
    rm -rf -- "$temp_dir"
    return 1
  fi

  local required
  while IFS= read -r required; do
    [ -n "$required" ] || continue
    if ! find "$temp_dir" -type f -name "$required" -print -quit | grep -q .; then
      echo "[release-guard] signed Windows artifact is incomplete; missing ${required}" >&2
      rm -rf -- "$temp_dir"
      return 1
    fi
  done < <(required_windows_asset_names)

  local windows_assets=()
  while IFS= read -r file; do windows_assets+=("$file"); done < <(
    find "$temp_dir" -type f \( \
      -name "Nowen-Note-${VERSION}-*.exe" -o \
      -name "Nowen-Note-${VERSION}-*.exe.blockmap" -o \
      -name "Nowen-Note-Lite-${VERSION}-*.exe" -o \
      -name "Nowen-Note-Lite-${VERSION}-*.exe.blockmap" -o \
      -name "latest.yml" -o \
      -name "latest-lite.yml" \
    \) -print | sort
  )

  echo "[release-guard] replacing local Windows candidates with ${#windows_assets[@]} SignPath-verified assets"
  gh release upload "$TAG" --repo "$GITHUB_REPO_SLUG" --clobber "${windows_assets[@]}"
  rm -rf -- "$temp_dir"
}

collect_ci_mac_assets() {
  local timeout_seconds="${NOWEN_RELEASE_CI_ARTIFACT_TIMEOUT_SECONDS:-10800}"
  local deadline=$((SECONDS + timeout_seconds))
  local tag_sha run_id artifact_id

  tag_sha="$(git -C "$REPO_ROOT" rev-list -n 1 "$TAG" 2>/dev/null || true)"
  [ -n "$tag_sha" ] || { echo "[release-guard] cannot resolve ${TAG} commit" >&2; return 1; }

  echo
  echo "==== 汇总 GitHub Actions macOS 构建产物 ===="
  if ! run_id="$(wait_for_tag_workflow_run "$tag_sha" "$deadline")"; then
    echo "[release-guard] tag workflow did not appear within ${timeout_seconds}s" >&2
    return 1
  fi
  echo "[release-guard] workflow run: ${run_id}"

  if ! artifact_id="$(wait_for_workflow_artifact "$run_id" "nowen-note-mac" "$deadline")"; then
    echo "[release-guard] timed out or failed waiting for nowen-note-mac artifact" >&2
    return 1
  fi
  [ -n "$artifact_id" ] || return 1

  CI_ARTIFACT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/nowen-release-mac.XXXXXX")"
  gh run download "$run_id" --repo "$GITHUB_REPO_SLUG" --name nowen-note-mac --dir "$CI_ARTIFACT_DIR"

  local mac_assets=()
  while IFS= read -r file; do mac_assets+=("$file"); done < <(
    find "$CI_ARTIFACT_DIR" -type f \( \
      -name "Nowen-Note-${VERSION}-*.dmg" -o \
      -name "Nowen-Note-${VERSION}-*.dmg.blockmap" -o \
      -name "Nowen-Note-${VERSION}-*.zip" -o \
      -name "Nowen-Note-${VERSION}-*.zip.blockmap" -o \
      -name "latest-mac.yml" \
    \) -print | sort
  )

  if [ "${#mac_assets[@]}" -eq 0 ]; then
    echo "[release-guard] nowen-note-mac artifact contains no release assets for ${VERSION}" >&2
    return 1
  fi

  local required
  while IFS= read -r required; do
    [ -n "$required" ] || continue
    if ! find "$CI_ARTIFACT_DIR" -type f -name "$required" -print -quit | grep -q .; then
      echo "[release-guard] nowen-note-mac artifact is incomplete; missing ${required}" >&2
      return 1
    fi
  done < <(required_mac_asset_names)

  echo "[release-guard] uploading ${#mac_assets[@]} macOS assets through the single local publisher"
  gh release upload "$TAG" --repo "$GITHUB_REPO_SLUG" --clobber "${mac_assets[@]}"
}

# Any Windows EXE initially uploaded by the legacy local publisher is only a Draft candidate.
# Before publication it must be replaced by the artifact produced by the same tag workflow after
# SignPath release-signing, Authenticode/CN verification, blockmap rebuild and metadata refresh.
if release_contains_windows_candidates; then
  if ! collect_ci_signed_windows_assets; then
    echo "[release-guard] failed to collect SignPath-signed Windows assets; keeping ${TAG} as draft" >&2
    gh release edit "$TAG" --repo "$GITHUB_REPO_SLUG" --draft=true >/dev/null 2>&1 || true
    exit 1
  fi
fi

if grep -q "PC 产物" "$LOG_FILE"; then
  if ! release_has_complete_mac_assets; then
    if ! collect_ci_mac_assets; then
      echo "[release-guard] failed to collect complete CI macOS assets; keeping ${TAG} as draft" >&2
      gh release edit "$TAG" --repo "$GITHUB_REPO_SLUG" --draft=true >/dev/null 2>&1 || true
      exit 1
    fi
  fi

  if ! release_has_complete_mac_assets; then
    echo "[release-guard] macOS release assets are still incomplete after CI collection; keeping ${TAG} as draft" >&2
    gh release edit "$TAG" --repo "$GITHUB_REPO_SLUG" --draft=true >/dev/null 2>&1 || true
    exit 1
  fi

  if ! ensure_desktop_platform_notes; then
    echo "[release-guard] failed to update desktop platform notes; keeping ${TAG} as draft" >&2
    gh release edit "$TAG" --repo "$GITHUB_REPO_SLUG" --draft=true >/dev/null 2>&1 || true
    exit 1
  fi
fi

echo
echo "==== 验证 GitHub Release 更新元数据与远端资产 ===="
WINDOWS_PUBLISHER="$(gh variable get NOWEN_WINDOWS_PUBLISHER_NAME --repo "$GITHUB_REPO_SLUG" 2>/dev/null || true)"
if [ -z "${WINDOWS_PUBLISHER//[[:space:]]/}" ]; then
  echo "[release-guard] NOWEN_WINDOWS_PUBLISHER_NAME is unconfirmed; complete release-signing publisher bootstrap before publication; keeping ${TAG} as draft" >&2
  gh release edit "$TAG" --repo "$GITHUB_REPO_SLUG" --draft=true >/dev/null 2>&1 || true
  exit 1
fi
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
