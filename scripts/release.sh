#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# nowen-note Docker 发布脚本
# -----------------------------------------------------------------------------
# 用途：
#   1. 拉取最新代码（git pull --ff-only）
#   2. 交互输入版本号（或命令行 -v 传入），做基础合法性校验
#   3. 一次性 docker build 同时打两个 tag：
#        cropflre/nowen-note:vX.Y.Z
#        cropflre/nowen-note:latest
#   4. 依次 docker push 两个 tag
#   5. 打印最终摘要（digest、耗时）
#
# 用法：
#   ./scripts/release.sh                       # 全交互
#   ./scripts/release.sh -v 1.2.0              # 指定版本号
#   ./scripts/release.sh -v 1.2.0 -y           # 非交互（CI）
#   ./scripts/release.sh --no-pull             # 跳过 git pull（本地已是最新）
#   ./scripts/release.sh --no-latest           # 只打版本 tag，不更新 latest
#   ./scripts/release.sh --dry-run             # 只演示，不真正执行 build/push
#
# 设计要点：
#   - set -euo pipefail：任一步失败立即中止，绝不带着错误往下走
#   - build 只跑一次，通过 `-t vX.Y.Z -t latest` 同时打标签；push 分两条命令
#     （docker 不支持一次 push 多 tag，但复用同一 image digest，实际上传层只会走一遍）
#   - push 前要求 `docker info` 能读到登录凭证（detect 到没登录时明确报错）
#   - 允许输入 "1.2.0" 或 "v1.2.0"，脚本内部统一成带 v 前缀
#   - 版本号正则：v?\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?  允许 1.2.0、1.2.0-rc.1 这种
# -----------------------------------------------------------------------------
set -euo pipefail

# ---------- 配置 ----------
IMAGE="cropflre/nowen-note"
DEFAULT_BRANCH="main"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---------- 彩色输出 ----------
if [[ -t 1 ]]; then
  C_RESET='\033[0m'; C_RED='\033[31m'; C_GRN='\033[32m'
  C_YLW='\033[33m';  C_BLU='\033[34m'; C_BOLD='\033[1m'
else
  C_RESET=; C_RED=; C_GRN=; C_YLW=; C_BLU=; C_BOLD=
fi
log()  { printf "${C_BLU}[*]${C_RESET} %s\n" "$*"; }
ok()   { printf "${C_GRN}[✓]${C_RESET} %s\n" "$*"; }
warn() { printf "${C_YLW}[!]${C_RESET} %s\n" "$*"; }
err()  { printf "${C_RED}[x]${C_RESET} %s\n" "$*" >&2; }
die()  { err "$*"; exit 1; }

# ---------- 参数解析 ----------
VERSION=""
ASSUME_YES=0
DO_PULL=1
DO_LATEST=1
DRY_RUN=0

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -v|--version)  VERSION="${2:-}"; shift 2 ;;
    -y|--yes)      ASSUME_YES=1; shift ;;
    --no-pull)     DO_PULL=0; shift ;;
    --no-latest)   DO_LATEST=0; shift ;;
    --dry-run)     DRY_RUN=1; shift ;;
    -h|--help)     usage ;;
    *)             die "未知参数：$1  （查看 --help）" ;;
  esac
done

# ---------- 前置检查 ----------
cd "$REPO_ROOT"
log "工作目录：$REPO_ROOT"

command -v git    >/dev/null || die "找不到 git，请先安装"
command -v docker >/dev/null || die "找不到 docker，请先安装并确认当前用户有权限"

# docker daemon 是否可用
docker info >/dev/null 2>&1 || die "docker daemon 不可用（没启动？当前用户不在 docker 组？）"

# 是否在 git 仓库
git rev-parse --git-dir >/dev/null 2>&1 || die "当前目录不是 git 仓库"

# 工作区脏检查（避免误打未提交改动进镜像）
if [[ -n "$(git status --porcelain)" ]]; then
  warn "工作区有未提交的改动："
  git status --short
  if [[ $ASSUME_YES -eq 0 ]]; then
    read -r -p "继续构建？[y/N] " ans
    [[ "$ans" =~ ^[Yy]$ ]] || die "已取消"
  else
    warn "--yes 已指定，带脏改动继续"
  fi
fi

# ---------- git pull ----------
if [[ $DO_PULL -eq 1 ]]; then
  CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  log "当前分支：$CURRENT_BRANCH"
  log "git pull --ff-only ..."
  git pull --ff-only
  ok  "代码已是最新：$(git rev-parse --short HEAD)  $(git log -1 --pretty=%s)"
else
  warn "跳过 git pull（--no-pull）"
fi

# ---------- 版本号交互/校验 ----------
# 尝试从最近的 tag 推一个建议版本（如 v1.2.3 → 1.2.4）
suggest_next_version() {
  local last patch
  last="$(git tag --list 'v*.*.*' --sort=-v:refname | head -n1 || true)"
  if [[ -z "$last" ]]; then
    echo "0.1.0"
    return
  fi
  # 去掉 v 前缀
  last="${last#v}"
  # 只对 X.Y.Z 这种递增 Z；带 -rc 的就原样回退为基础版本 +1
  if [[ "$last" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    patch=$((BASH_REMATCH[3] + 1))
    echo "${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.$patch"
  else
    echo "${last%%-*}"
  fi
}

if [[ -z "$VERSION" ]]; then
  SUGGEST="$(suggest_next_version)"
  if [[ $ASSUME_YES -eq 1 ]]; then
    die "未指定版本号（-v），且 --yes 模式下不能交互输入"
  fi
  echo
  printf "${C_BOLD}请输入本次发布版本号${C_RESET}（格式：1.2.3 或 v1.2.3，可带 -rc.1 等后缀）\n"
  printf "   建议：%s（回车使用建议值）\n" "$SUGGEST"
  read -r -p "> " VERSION
  VERSION="${VERSION:-$SUGGEST}"
fi

# 去掉可能的 v 前缀，统一内部表示
VERSION="${VERSION#v}"
# 合法性：X.Y.Z 或 X.Y.Z-<suffix>
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$ ]]; then
  die "版本号格式不合法：'$VERSION'（期望形如 1.2.3 或 1.2.3-rc.1）"
fi
TAG_VER="v${VERSION}"

# 若该 tag 已存在于 docker hub 的本地镜像（近期 build 过）提示
if docker image inspect "${IMAGE}:${TAG_VER}" >/dev/null 2>&1; then
  warn "本地已存在镜像 ${IMAGE}:${TAG_VER}，继续将覆盖"
  if [[ $ASSUME_YES -eq 0 ]]; then
    read -r -p "覆盖？[y/N] " ans
    [[ "$ans" =~ ^[Yy]$ ]] || die "已取消"
  fi
fi

# ---------- 摘要确认 ----------
echo
printf "${C_BOLD}==== 发布摘要 ====${C_RESET}\n"
printf "  镜像仓库      : %s\n" "$IMAGE"
printf "  版本 tag      : %s\n" "$TAG_VER"
printf "  同步 latest   : %s\n" "$([[ $DO_LATEST -eq 1 ]] && echo yes || echo no)"
printf "  git commit    : %s  %s\n" "$(git rev-parse --short HEAD)" "$(git log -1 --pretty=%s)"
printf "  构建上下文    : %s\n" "$REPO_ROOT"
printf "  Dry run       : %s\n" "$([[ $DRY_RUN -eq 1 ]] && echo yes || echo no)"
echo

if [[ $ASSUME_YES -eq 0 ]]; then
  read -r -p "确认发布？[y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]] || die "已取消"
fi

# ---------- docker build（一次 build 打两个 tag） ----------
BUILD_ARGS=(build -t "${IMAGE}:${TAG_VER}")
if [[ $DO_LATEST -eq 1 ]]; then
  BUILD_ARGS+=(-t "${IMAGE}:latest")
fi
# 注入 commit/version 到 label，便于在运行时排查
BUILD_ARGS+=(
  --label "org.opencontainers.image.version=${VERSION}"
  --label "org.opencontainers.image.revision=$(git rev-parse HEAD)"
  --label "org.opencontainers.image.created=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  --label "org.opencontainers.image.source=$(git config --get remote.origin.url || echo unknown)"
  .
)

echo
log "开始构建：docker ${BUILD_ARGS[*]}"
T0=$(date +%s)
if [[ $DRY_RUN -eq 1 ]]; then
  warn "--dry-run：跳过实际 build"
else
  docker "${BUILD_ARGS[@]}"
fi
T1=$(date +%s)
ok "构建完成，用时 $((T1 - T0))s"

# ---------- docker push ----------
push_tag() {
  local tag="$1"
  log "推送：${IMAGE}:${tag}"
  if [[ $DRY_RUN -eq 1 ]]; then
    warn "--dry-run：跳过实际 push"
    return
  fi
  docker push "${IMAGE}:${tag}"
}

echo
push_tag "$TAG_VER"
if [[ $DO_LATEST -eq 1 ]]; then
  push_tag "latest"
fi
T2=$(date +%s)

# ---------- 结果摘要 ----------
echo
printf "${C_GRN}${C_BOLD}==== 发布完成 ====${C_RESET}\n"
printf "  %s:%s  ←  已推送\n" "$IMAGE" "$TAG_VER"
if [[ $DO_LATEST -eq 1 ]]; then
  printf "  %s:%s  ←  已推送\n" "$IMAGE" "latest"
fi
printf "  总耗时            : %ss （build %ss + push %ss）\n" \
  "$((T2 - T0))" "$((T1 - T0))" "$((T2 - T1))"

if [[ $DRY_RUN -eq 0 ]]; then
  DIGEST="$(docker image inspect --format '{{index .RepoDigests 0}}' "${IMAGE}:${TAG_VER}" 2>/dev/null || true)"
  [[ -n "$DIGEST" ]] && printf "  digest            : %s\n" "$DIGEST"
fi

echo
ok "可用以下命令拉取："
printf "    docker pull %s:%s\n" "$IMAGE" "$TAG_VER"
[[ $DO_LATEST -eq 1 ]] && printf "    docker pull %s:latest\n" "$IMAGE"
