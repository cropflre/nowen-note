#!/usr/bin/env bash
# =============================================================================
# nowen-note 统一发布 / 构建脚本
#
# 两种工作模式：
#
#   [发布模式] 默认。面向 Docker Hub 正式发布：
#     1. 交互式输入版本号（带校验 + 自动建议下一版本）
#        自动建议版本会同时参考：本地 git tag / GitHub 远端 tag / Docker Hub 已有 tag，
#        取三者最大值 + patch+1，保证三端版本号严格单调递增；
#        --yes 模式下会直接采用建议版本，便于 CI 自动化。
#     2. git pull 前检查工作区 / 暂存区是否干净
#     3. 一次 docker build 同时打 :vX.Y.Z + :latest
#     4. 推送到 Docker Hub
#     5. 同步打 git tag 并推送到 GitHub（失败时给出 PAT / SSH 指引）
#
#   [构建模式] 加 --build-only 开关，面向本地 / 内网离线 / 自建 registry：
#     跳过 git pull / 版本号 / git tag / 强制 Docker Hub 推送
#     只做 docker 构建，产物可 --load 本机、--tar 导出、--push 自定义 registry
#     用来替代以前的 scripts/build-arm64.sh。
#
# 架构（--arch）：
#   amd64   默认。走原生 docker build，速度最快，适合大多数 x86 服务器/NAS。
#   arm64   走 docker buildx --platform linux/arm64（默认 --load；或 --tar / --push）
#           为 A311D / RK3566 / OES / OECT 等 ARM64 板子出产物。需要 QEMU。
#   multi   走 docker buildx --platform linux/amd64,linux/arm64 --push，
#           直接在 Docker Hub（或自定义 --image）生成多架构 manifest。
#           注意：multi 模式必然推送，不能 --load / --tar。
#
# 使用示例（发布模式）：
#   ./scripts/release.sh                            # 全交互（amd64）
#   ./scripts/release.sh -v 1.3.0 -y                # 指定版本 + 跳过确认
#   ./scripts/release.sh -v 1.3.0-rc.1 --no-latest  # 预发布，不动 latest
#   ./scripts/release.sh -v 1.3.0 --no-pull         # 不 git pull
#   ./scripts/release.sh -v 1.3.0 --no-git-tag      # 不打 git tag
#   ./scripts/release.sh -v 1.3.0 --dry-run         # 只打印命令不执行
#   ./scripts/release.sh -v 1.3.0 --arch arm64 -y   # 只发 arm64 镜像到 Docker Hub
#   ./scripts/release.sh -v 1.3.0 --arch multi -y   # 一次发 amd64+arm64 多架构
#
# 使用示例（构建模式，取代 build-arm64.sh）：
#   ./scripts/release.sh --build-only --arch arm64                             # 构建并 load 到本机
#   ./scripts/release.sh --build-only --arch arm64 --tar                       # 导出 arm64 tar（默认 nowen-note-arm64.tar）
#   ./scripts/release.sh --build-only --arch arm64 --tar --tar-out /tmp/x.tar  # 自定义 tar 路径
#   ./scripts/release.sh --build-only --arch arm64 --image registry.example.com/nowen-note:arm64 --push
#   ./scripts/release.sh --build-only --arch multi --image registry.example.com/nowen-note:multi
# =============================================================================

set -euo pipefail

# -------------------- 配置 --------------------
DEFAULT_IMAGE_NAME="cropflre/nowen-note"
DEFAULT_BRANCH="main"
GITHUB_REPO_URL="https://github.com/cropflre/nowen-note"
GITHUB_REPO_SLUG="cropflre/nowen-note"   # gh release create 需要的 "owner/repo"
BUILDX_BUILDER="nowen-note-builder"
DEFAULT_TAR_OUT="nowen-note-arm64.tar"

# -------------------- 彩色输出 --------------------
if [ -t 1 ] && command -v tput >/dev/null 2>&1 && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
    C_RED="$(tput setaf 1)"
    C_GREEN="$(tput setaf 2)"
    C_YELLOW="$(tput setaf 3)"
    C_BLUE="$(tput setaf 4)"
    C_CYAN="$(tput setaf 6)"
    C_BOLD="$(tput bold)"
    C_RESET="$(tput sgr0)"
else
    C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_CYAN=""; C_BOLD=""; C_RESET=""
fi

info()  { echo "${C_BLUE}[*]${C_RESET} $*"; }
ok()    { echo "${C_GREEN}[✓]${C_RESET} $*"; }
warn()  { echo "${C_YELLOW}[!]${C_RESET} $*" >&2; }
die()   { echo "${C_RED}[✗]${C_RESET} $*" >&2; exit 1; }
step()  { echo; echo "${C_BOLD}${C_CYAN}==== $* ====${C_RESET}"; }

# -------------------- 参数解析 --------------------
VERSION=""
ASSUME_YES=0
DO_PULL=1
DO_LATEST=1
DO_GIT_TAG=1
DRY_RUN=0
ARCH="amd64"           # amd64 | arm64 | multi
BUILD_ONLY=0           # 1 = 仅构建（取代 build-arm64.sh）
CUSTOM_IMAGE=""        # --image，仅在 build-only 下使用
DO_TAR=0               # --tar，仅在 build-only + arm64 下
TAR_OUT="$DEFAULT_TAR_OUT"
DO_PUSH_CUSTOM=0       # --push，仅在 build-only + 自定义 image 下

# ===== 多端发版（PC / Android / Docker / GitHub Releases） =====
# TARGETS 用逗号分隔的集合：docker / pc / android / all
# 默认 docker（向后兼容旧行为）；all = docker,pc,android
TARGETS="docker"
DO_GITHUB_RELEASE=0    # --github-release：把 PC/Android 产物上传到 GitHub Release（自动打 tag）
RELEASE_NOTES=""       # --notes "xxx" 或 --notes-file path
RELEASE_NOTES_FILE=""
RELEASE_DRAFT=0        # --draft
RELEASE_PRERELEASE=0   # --prerelease（版本号带 -rc 等预发布后缀时自动置 1）

# ===== PC 端平台选择（Linux 宿主跨平台打 Win/Linux/mac） =====
# 逗号分隔：win / linux / mac
# 默认值根据宿主 OS 决定：
#   Linux（Debian）:  win,linux  （需 wine+mono；mac 只能在 macOS 上打）
#   macOS:            mac,linux  （macOS 上也能打 Linux；Win 要 wine 比较折腾，默认不打）
#   Windows:          win        （原生打 Windows，通过 safe-build.mjs 做日志降噪）
PC_PLATFORMS=""        # --pc-platform，留空交给下面自动推断

# ===== Android 端 Docker 构建支持 =====
# 主机没装 JDK/Android SDK 时，用 docker 镜像挂载仓库跑 gradle。
ANDROID_USE_DOCKER=0                                     # --android-docker
ANDROID_DOCKER_IMAGE="cimg/android:2024.01.1-node"       # --android-docker-image NAME:TAG
ANDROID_DOCKER_SYNC=0                                    # --android-docker-sync：把 frontend build + cap sync 也挪进 Docker

# ===== PC 端打包后恢复 backend better-sqlite3 的 Node ABI =====
# rebuild:native 会把 backend/better-sqlite3 编成 Electron ABI，
# 这之后本机直接 `npm run dev:backend`（tsx 纯 Node）会报 ABI 不匹配。
# 加这个开关后：PC 打包完自动 `cd backend && npm rebuild better-sqlite3`，恢复 Node ABI。
RESTORE_BACKEND_ABI=0                                    # --restore-backend-abi

usage() {
    cat <<EOF
用法: $0 [选项]

通用选项:
  -h, --help               显示帮助
      --dry-run            仅打印命令，不真实执行
      --arch ARCH          构建架构：amd64(默认) / arm64 / multi （仅对 docker target 生效）
  -y, --yes                跳过所有确认（发布模式也可用于 CI）

发布模式（默认）:
  -v, --version VERSION    指定版本号（例: 1.3.0 或 v1.3.0）
      --no-pull            不执行 git pull
      --no-latest          不打 :latest tag（仅 docker）
      --no-git-tag         不打 git tag / 不推送到 GitHub

多端发版选项（可组合）:
      --target TARGETS     逗号分隔：docker / pc / android / all
                           默认 docker；示例：--target pc,android
      --pc-platform LIST   PC 端要打的平台，逗号分隔：win / linux / mac
                           默认：Linux 宿主 => win,linux；macOS => mac,linux；Windows => win
                           在 Debian 上打 Windows exe 需要 wine64 + mono（首次 apt install 一次）
      --android-docker     Android 用 Docker 镜像跑 gradle（主机无需装 JDK/Android SDK）
      --android-docker-image NAME:TAG
                           指定 Android 构建镜像（默认 cimg/android:2024.01.1-node）
      --android-docker-sync
                           连同 frontend build + npx cap sync android 也放进 Docker 里跑
                           （主机连 node 都不装也能打 APK，代价是首次镜像下载多走一遍）
      --restore-backend-abi
                           PC 打包完自动 rebuild backend 的 better-sqlite3 回 Node ABI
                           （避免一边打包一边 npm run dev:backend 时 ABI 不匹配）
      --github-release     把 pc/android 产物以 gh release create 上传到 GitHub Releases
                           需要 gh CLI 已登录（gh auth login），或设了 GH_TOKEN 环境变量
      --notes "TEXT"       Release 发布说明（简短文本）
      --notes-file PATH    Release 发布说明（从文件读，优先级高于 --notes）
      --draft              Release 作为草稿（可在网页上再发布）
      --prerelease         标记为 Pre-release（版本号带 -rc / -alpha 等后缀会自动置位）

构建模式（--build-only，取代 build-arm64.sh）:
      --build-only         仅构建 docker 镜像，不 git pull / 不版本号 / 不 git tag / 不 Docker Hub 推送
      --image NAME:TAG     自定义镜像名（默认 ${DEFAULT_IMAGE_NAME}:<arch>）
      --tar [PATH]         导出为 tar（仅 arch=arm64）；PATH 可用 --tar-out 指定
      --tar-out PATH       tar 输出路径（默认 ${DEFAULT_TAR_OUT}）
      --push               构建后推送到 --image 指定的 registry（arm64 / multi）

示例（多端一键发版）:
  # 只打 PC 端（Windows exe + portable），发到 GitHub Releases
  $0 -v 1.3.0 -y --target pc --github-release --no-latest

  # 在 Debian 上同时打 Win + Linux PC 产物 + Android APK（通过 Docker 构建 Android）
  $0 -v 1.3.0 -y --target pc,android --pc-platform win,linux \
      --android-docker --github-release

  # 极简 Debian：宿主仅装 wine+mono+docker（连 Android node_modules 都可以省）
  $0 -v 1.3.0 -y --target pc,android \
      --pc-platform win,linux \
      --android-docker --android-docker-sync \
      --restore-backend-abi \
      --github-release

  # 只打 Android APK，发到 GitHub Releases
  $0 -v 1.3.0 -y --target android --github-release

  # 三端同时发：Docker Hub + PC + Android + GitHub Release
  $0 -v 1.3.0 -y --target all --github-release --notes "修复若干 bug"

  # 预发布（自动置 prerelease）
  $0 -v 1.3.0-rc.1 -y --target all --github-release

环境变量（可选，供 CI 使用）:
  NOWEN_ANDROID_KEYSTORE_B64      Android keystore 的 base64；脚本会还原为文件并生成
                                  frontend/android/keystore.properties，构建后自动清理
  NOWEN_ANDROID_KEYSTORE_PASSWORD store 密码
  NOWEN_ANDROID_KEY_ALIAS         key alias（默认 nowen-release）
  NOWEN_ANDROID_KEY_PASSWORD      key 密码（未设则等同于 store 密码）
  NOWEN_SKIP_RCEDIT=1             跳过 electron-builder 的 rcedit（Windows exe 图标/版本注入）
                                  和代码签名；适合 Debian 首次打 Win 包时，避免等 winCodeSign
                                  约 60MB 从 GitHub 下载（国内网络容易卡）
  NOWEN_LINUX_MAINTAINER          Linux 包 maintainer 字段（默认 "Nowen <noreply@nowen.local>"）
  NOWEN_LINUX_VENDOR              Linux 包 vendor（默认 "Nowen"）
  NOWEN_LINUX_HOMEPAGE            homepage URL（默认项目 GitHub 仓库）

架构说明（仅 docker target 生效）:
  amd64   原生 docker build，最快；适合 x86 服务器/NAS。
  arm64   buildx --platform linux/arm64 --load（或 --tar / --push）；适合 ARM 板子。
  multi   buildx --platform linux/amd64,linux/arm64 --push；一次性生成多架构 manifest。
EOF
    exit 0
}

while [ $# -gt 0 ]; do
    case "$1" in
        -v|--version)   VERSION="${2:-}"; shift 2 ;;
        -y|--yes)       ASSUME_YES=1; shift ;;
        --arch)         ARCH="${2:-}"; shift 2 ;;
        --no-pull)      DO_PULL=0; shift ;;
        --no-latest)    DO_LATEST=0; shift ;;
        --no-git-tag)   DO_GIT_TAG=0; shift ;;
        --dry-run)      DRY_RUN=1; shift ;;
        --build-only)   BUILD_ONLY=1; shift ;;
        --image)        CUSTOM_IMAGE="${2:-}"; shift 2 ;;
        --tar)          DO_TAR=1; shift ;;
        --tar-out)      TAR_OUT="${2:-}"; shift 2 ;;
        --push)         DO_PUSH_CUSTOM=1; shift ;;
        --target)       TARGETS="${2:-}"; shift 2 ;;
        --pc-platform)  PC_PLATFORMS="${2:-}"; shift 2 ;;
        --android-docker) ANDROID_USE_DOCKER=1; shift ;;
        --android-docker-image) ANDROID_DOCKER_IMAGE="${2:-}"; shift 2 ;;
        --android-docker-sync) ANDROID_DOCKER_SYNC=1; ANDROID_USE_DOCKER=1; shift ;;
        --restore-backend-abi) RESTORE_BACKEND_ABI=1; shift ;;
        --github-release) DO_GITHUB_RELEASE=1; shift ;;
        --notes)        RELEASE_NOTES="${2:-}"; shift 2 ;;
        --notes-file)   RELEASE_NOTES_FILE="${2:-}"; shift 2 ;;
        --draft)        RELEASE_DRAFT=1; shift ;;
        --prerelease)   RELEASE_PRERELEASE=1; shift ;;
        -h|--help)      usage ;;
        *)              die "未知参数: $1（使用 -h 查看帮助）" ;;
    esac
done

# 展开 TARGETS
# - all -> docker,pc,android
# - 去重 / 校验
TARGETS="$(echo "$TARGETS" | tr ',' '\n' | awk 'NF{print}' | sort -u | tr '\n' ',' | sed 's/,$//')"
if echo ",$TARGETS," | grep -q ',all,'; then
    TARGETS="docker,pc,android"
fi
HAS_DOCKER=0; HAS_PC=0; HAS_ANDROID=0
for t in $(echo "$TARGETS" | tr ',' ' '); do
    case "$t" in
        docker)  HAS_DOCKER=1 ;;
        pc)      HAS_PC=1 ;;
        android) HAS_ANDROID=1 ;;
        *)       die "--target 未知值: $t （合法: docker / pc / android / all）" ;;
    esac
done
[ "$HAS_DOCKER" = "0" ] && [ "$HAS_PC" = "0" ] && [ "$HAS_ANDROID" = "0" ] \
    && die "--target 至少包含一个目标"

case "$ARCH" in
    amd64|arm64|multi) ;;
    *) die "--arch 只能是 amd64 / arm64 / multi，收到: $ARCH" ;;
esac

# -------------------- 构建模式 / 发布模式 互斥校验 --------------------
if [ "$BUILD_ONLY" = "1" ]; then
    [ -n "$VERSION" ]      && warn "--build-only 模式下 -v/--version 被忽略"
    [ "$DO_LATEST" = "0" ] || true   # latest 在 build-only 下本身也不打，不提示
    if [ "$DO_TAR" = "1" ] && [ "$ARCH" != "arm64" ]; then
        die "--tar 仅支持 --arch arm64"
    fi
    if [ "$DO_TAR" = "1" ] && [ "$DO_PUSH_CUSTOM" = "1" ]; then
        die "--tar 与 --push 互斥"
    fi
    if [ "$ARCH" = "multi" ] && [ "$DO_PUSH_CUSTOM" = "0" ]; then
        # multi 必然 push，用户没加 --push 也默认认为要 push（提示一下）
        DO_PUSH_CUSTOM=1
    fi
    # build-only 仅对 docker 构建有意义
    if [ "$HAS_PC" = "1" ] || [ "$HAS_ANDROID" = "1" ]; then
        die "--build-only 模式不支持 --target pc/android（仅限 docker）"
    fi
    if [ "$DO_GITHUB_RELEASE" = "1" ]; then
        die "--build-only 模式不支持 --github-release"
    fi
else
    # 发布模式禁用构建模式专属参数
    [ -n "$CUSTOM_IMAGE" ]   && die "--image 仅在 --build-only 下可用"
    [ "$DO_TAR" = "1" ]      && die "--tar 仅在 --build-only 下可用"
    [ "$DO_PUSH_CUSTOM" = "1" ] && die "--push 仅在 --build-only 下可用（发布模式默认就推送 Docker Hub）"
fi

run() {
    if [ "$DRY_RUN" = "1" ]; then
        echo "  ${C_YELLOW}DRY-RUN${C_RESET} $*"
    else
        eval "$@"
    fi
}

# run_argv：按参数数组原样执行（不经 eval 二次解析），用于参数含空格/等号等
# 特殊字符的场景（例如 docker build 的 --label k=v 参数）。
run_argv() {
    if [ "$DRY_RUN" = "1" ]; then
        echo "  ${C_YELLOW}DRY-RUN${C_RESET} $*"
    else
        "$@"
    fi
}

# -------------------- 前置检查 --------------------
# 定位到仓库根目录（脚本可能被从任意目录调用）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

info "工作目录：$REPO_ROOT"
info "运行模式：$([ "$BUILD_ONLY" = "1" ] && echo '构建模式（--build-only）' || echo '发布模式')"
info "构建架构：$ARCH"

# 必须在 git 仓库里（构建模式也要，用来取 revision 标签）
git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || die "当前目录不是 git 仓库"

# docker 可用（只有目标里有 docker 才检查）
if [ "$HAS_DOCKER" = "1" ] || [ "$BUILD_ONLY" = "1" ]; then
    command -v docker >/dev/null 2>&1 || die "未安装 docker"
    docker info >/dev/null 2>&1 || die "docker daemon 不可用（请启动 docker）"

    # buildx 可用性（arm64 / multi 模式强制）
    if [ "$ARCH" != "amd64" ]; then
        docker buildx version >/dev/null 2>&1 \
            || die "未检测到 docker buildx；arm64 / multi 模式必须使用 buildx（请升级 Docker 或启用 BuildKit）"
    fi

    # Dockerfile 存在
    [ -f Dockerfile ] || die "仓库根目录未找到 Dockerfile"
fi

# PC target 前置检查
if [ "$HAS_PC" = "1" ]; then
    [ -f "scripts/safe-build.mjs" ] || die "未找到 scripts/safe-build.mjs（PC 端打包脚本）"
    command -v node >/dev/null 2>&1 || die "未安装 node（PC 端打包需要）"

    # ---- PC_PLATFORMS 自动推断 ----
    # 根据宿主 OS 给一个合理默认值；用户 --pc-platform 显式指定优先。
    UNAME_S_PC="$(uname -s 2>/dev/null || echo unknown)"
    if [ -z "$PC_PLATFORMS" ]; then
        case "$UNAME_S_PC" in
            Linux)          PC_PLATFORMS="win,linux" ;;
            Darwin)         PC_PLATFORMS="mac,linux" ;;
            MINGW*|MSYS*|CYGWIN*) PC_PLATFORMS="win" ;;
            *)              PC_PLATFORMS="win,linux" ;;
        esac
        info "PC 端平台自动选择: ${PC_PLATFORMS}（宿主 OS: ${UNAME_S_PC}）"
    fi

    # 去重 + 校验
    PC_PLATFORMS="$(echo "$PC_PLATFORMS" | tr ',' '\n' | awk 'NF{print}' | sort -u | tr '\n' ',' | sed 's/,$//')"
    PC_HAS_WIN=0; PC_HAS_LINUX=0; PC_HAS_MAC=0
    for p in $(echo "$PC_PLATFORMS" | tr ',' ' '); do
        case "$p" in
            win)    PC_HAS_WIN=1 ;;
            linux)  PC_HAS_LINUX=1 ;;
            mac)    PC_HAS_MAC=1 ;;
            *)      die "--pc-platform 未知值: $p （合法: win / linux / mac）" ;;
        esac
    done

    # ---- macOS 只能在 macOS 上打 ----
    if [ "$PC_HAS_MAC" = "1" ] && [ "$UNAME_S_PC" != "Darwin" ]; then
        warn "mac 目标只能在 macOS 宿主上产出（dmg/zip 需要 Apple 工具链），将从 PC_PLATFORMS 中移除"
        PC_HAS_MAC=0
        PC_PLATFORMS="$(echo "$PC_PLATFORMS" | tr ',' '\n' | grep -v '^mac$' | tr '\n' ',' | sed 's/,$//')"
    fi

    # ---- Linux 上打 Windows exe 需要 wine + mono ----
    # electron-builder 跨平台打 Win 目标时会调 wine 跑 NSIS / rcedit；
    # mono 用来跑 signtool 替代（虽然我们没配 CSC_LINK，不会真签名，但 mono 是 wine 环境常见依赖）
    if [ "$PC_HAS_WIN" = "1" ] && [ "$UNAME_S_PC" = "Linux" ]; then
        missing_pkgs=()
        command -v wine64 >/dev/null 2>&1 || command -v wine >/dev/null 2>&1 || missing_pkgs+=("wine64")
        command -v mono >/dev/null 2>&1 || missing_pkgs+=("mono-devel")
        if [ "${#missing_pkgs[@]}" -gt 0 ]; then
            warn "Linux 上打 Windows exe 需要 wine + mono，当前缺少: ${missing_pkgs[*]}"
            echo "    Debian/Ubuntu 安装命令："
            echo "      sudo dpkg --add-architecture i386"
            echo "      sudo apt update"
            echo "      sudo apt install -y wine64 wine32 mono-devel"
            echo
            echo "    首次运行 wine 会在 ~/.wine 初始化（几十秒）。"
            echo "    如不想装 wine，改用 --pc-platform linux 只出 AppImage/deb。"
            die "PC 环境不满足（缺 wine/mono），请先安装"
        fi
        ok "wine/mono 就绪，可跨平台打 Windows exe"
    fi
fi

# Android target 前置检查
if [ "$HAS_ANDROID" = "1" ]; then
    [ -d "frontend/android" ] || die "未找到 frontend/android 目录"
    [ -f "frontend/android/app/build.gradle" ] || die "未找到 frontend/android/app/build.gradle"

    # ---- 自动切换到 Docker 构建（主机没装 JDK/SDK 时） ----
    # 如果用户显式传了 --android-docker，直接走 docker；
    # 否则当主机既缺 JAVA_HOME 又缺 ANDROID_HOME/ANDROID_SDK_ROOT 时，也自动切到 docker。
    if [ "$ANDROID_USE_DOCKER" != "1" ]; then
        if [ -z "${JAVA_HOME:-}" ] && [ -z "${ANDROID_HOME:-}" ] && [ -z "${ANDROID_SDK_ROOT:-}" ]; then
            if command -v docker >/dev/null 2>&1; then
                warn "未检测到本地 JDK / Android SDK，自动切换到 Docker 构建（镜像: ${ANDROID_DOCKER_IMAGE}）"
                ANDROID_USE_DOCKER=1
            else
                die "本地无 JDK/Android SDK 且未安装 docker，无法构建 Android。请装 JDK17 + Android SDK，或装 docker 后加 --android-docker"
            fi
        fi
    fi

    if [ "$ANDROID_USE_DOCKER" = "1" ]; then
        command -v docker >/dev/null 2>&1 || die "--android-docker 需要 docker"
        docker info >/dev/null 2>&1 || die "docker daemon 不可用（请启动 docker）"
        info "Android 构建模式: Docker（${ANDROID_DOCKER_IMAGE}）"
    else
        info "Android 构建模式: 本机 gradlew"
    fi

    if [ ! -f "frontend/android/keystore.properties" ] && [ -z "${NOWEN_ANDROID_KEYSTORE_B64:-}" ]; then
        warn "未找到 frontend/android/keystore.properties 且未设 NOWEN_ANDROID_KEYSTORE_B64，APK 将不会被签名（只能用于调试）"
    fi
    command -v node >/dev/null 2>&1 || die "未安装 node（Android 端打包需要先跑 vite build + cap sync）"
fi

# -------------------- 发布模式专属前置检查 --------------------
if [ "$BUILD_ONLY" != "1" ]; then
    CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
    info "当前分支：$CURRENT_BRANCH"
    if [ "$CURRENT_BRANCH" != "$DEFAULT_BRANCH" ]; then
        warn "当前不在 $DEFAULT_BRANCH 分支，继续？"
        if [ "$ASSUME_YES" != "1" ]; then
            read -r -p "[y/N] " ans
            case "$ans" in [yY]|[yY][eE][sS]) ;; *) die "已取消" ;; esac
        fi
    fi

    # 工作区脏检查
    if ! git diff-index --quiet HEAD --; then
        warn "工作区有未提交的改动："
        git status --short | head -20
        die "请先提交或 stash 再发布"
    fi

    # 暂存区检查
    if ! git diff --cached --quiet; then
        die "暂存区有未提交的改动，请先 commit"
    fi

    # -------------------- git pull --------------------
    if [ "$DO_PULL" = "1" ]; then
        info "git pull --ff-only origin $CURRENT_BRANCH ..."
        run "git pull --ff-only origin \"$CURRENT_BRANCH\""
        ok "代码已是最新：$(git log -1 --pretty=format:'%h  %s')"
    else
        info "跳过 git pull（--no-pull）"
    fi
fi

# -------------------- 版本号 / 镜像名确定 --------------------
GIT_COMMIT="$(git log -1 --pretty=format:'%h  %s')"
GIT_SHA="$(git rev-parse HEAD)"
BUILD_DATE="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

if [ "$BUILD_ONLY" = "1" ]; then
    # 构建模式：没有版本号概念，镜像名由 --image 或默认 <DEFAULT_IMAGE_NAME>:<arch> 决定
    if [ -n "$CUSTOM_IMAGE" ]; then
        FULL_IMAGE="$CUSTOM_IMAGE"
    else
        FULL_IMAGE="${DEFAULT_IMAGE_NAME}:${ARCH}"
    fi
    VERSION_TAG=""   # 仅发布模式有
    IMAGE_NAME=""
else
    # 发布模式：需要版本号
    IMAGE_NAME="$DEFAULT_IMAGE_NAME"

    # ----- 版本号来源聚合 -----
    # 汇聚以下三处已发布过的版本，合并去重后取最大值，保证本地 / GitHub / Docker Hub
    # 三端版本号严格单调递增，避免出现 "本地 tag 落后 Docker Hub" 或反之的错位。
    #   1) 本地 git tag
    #   2) GitHub 远端 tag（origin）
    #   3) Docker Hub 镜像 tag（cropflre/nowen-note）
    # 网络不可用（ls-remote / curl 失败）时静默跳过该来源，不阻断发布。

    # 提取形如 vX.Y.Z / X.Y.Z（可带 -rc.N 等后缀）并归一化为裸 X.Y.Z(-suffix)
    normalize_tags() {
        # 读 stdin，每行一个候选字符串；输出合法的 X.Y.Z(-suffix)
        grep -Eo '^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' \
            | sed 's/^v//'
    }

    collect_local_tags() {
        git tag --list 'v[0-9]*.[0-9]*.[0-9]*' 2>/dev/null | normalize_tags || true
    }

    collect_github_tags() {
        # 2s 超时避免网络挂死；ls-remote 输出形如 "<sha>\trefs/tags/vX.Y.Z(^{})"
        timeout 5 git ls-remote --tags --refs origin 2>/dev/null \
            | awk '{print $2}' | sed 's#^refs/tags/##' | normalize_tags || true
    }

    collect_dockerhub_tags() {
        # Docker Hub v2 REST：匿名可读。分页拉到空为止，最多翻 5 页（500 个 tag）足够。
        command -v curl >/dev/null 2>&1 || return 0
        local ns="${IMAGE_NAME%%/*}" repo="${IMAGE_NAME##*/}"
        local url="https://hub.docker.com/v2/repositories/${ns}/${repo}/tags/?page_size=100"
        local page=1
        while [ -n "$url" ] && [ "$page" -le 5 ]; do
            local body
            body="$(curl -fsSL --max-time 5 "$url" 2>/dev/null)" || return 0
            echo "$body" \
                | grep -Eo '"name"[[:space:]]*:[[:space:]]*"[^"]+"' \
                | sed -E 's/.*"([^"]+)"$/\1/' \
                | normalize_tags
            url="$(echo "$body" | grep -Eo '"next"[[:space:]]*:[[:space:]]*"[^"]+"' \
                    | sed -E 's/.*"([^"]+)"$/\1/' | head -1)"
            page=$((page + 1))
        done
    }

    suggest_next_version() {
        local all latest
        all="$( { collect_local_tags; collect_github_tags; collect_dockerhub_tags; } | sort -u )"
        # 只用 "纯三段"（不带 -rc 等后缀）作为递增基准，避免预发布被当正式版
        latest="$(echo "$all" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)"
        if [ -z "$latest" ]; then
            echo "0.1.0"
            return
        fi
        local major minor patch
        IFS='.' read -r major minor patch <<EOF
$latest
EOF
        patch=$((patch + 1))
        echo "${major}.${minor}.${patch}"
    }

    # 返回 0 = 该版本已在任一来源存在
    version_exists_anywhere() {
        local v="$1"
        { collect_local_tags; collect_github_tags; collect_dockerhub_tags; } \
            | sort -u | grep -Fxq "$v"
    }

    validate_version() {
        echo "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
    }

    info "聚合历史版本（本地 tag / GitHub / Docker Hub）..."
    SUGGEST="$(suggest_next_version)"
    # 打印一下当前各源最大版本，方便肉眼核对
    _LOCAL_MAX="$(collect_local_tags    | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)"
    _GH_MAX="$(   collect_github_tags   | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)"
    _DH_MAX="$(   collect_dockerhub_tags| grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)"
    info "  本地 tag 最新 : ${_LOCAL_MAX:-(无)}"
    info "  GitHub 最新   : ${_GH_MAX:-(无/不可达)}"
    info "  Docker Hub 最新: ${_DH_MAX:-(无/不可达)}"
    info "  建议下一版本   : ${C_GREEN}${SUGGEST}${C_RESET}"

    if [ -z "$VERSION" ]; then
        if [ "$ASSUME_YES" = "1" ]; then
            # --yes 模式下自动采用建议版本，便于 CI / 自动化
            VERSION="$SUGGEST"
            info "--yes 模式自动采用建议版本：${VERSION}"
        else
            echo
            echo "${C_BOLD}请输入本次发布版本号${C_RESET}（格式：1.2.3 或 v1.2.3，可带 -rc.1 等后缀）"
            echo "   建议：${C_GREEN}${SUGGEST}${C_RESET}（回车使用建议值）"
            read -r -p "> " VERSION
            VERSION="${VERSION:-$SUGGEST}"
        fi
    fi

    VERSION="${VERSION#v}"
    validate_version "$VERSION" || die "版本号格式非法：$VERSION（期望 X.Y.Z 或 X.Y.Z-rc.N）"
    VERSION_TAG="v${VERSION}"

    # 检查 git tag 是否已存在（本地）
    if [ "$DO_GIT_TAG" = "1" ] && git rev-parse "refs/tags/${VERSION_TAG}" >/dev/null 2>&1; then
        die "git tag ${VERSION_TAG} 已存在（本地）"
    fi
    # 检查 GitHub / Docker Hub 是否已存在（三端任何一处已占用都禁止覆盖）
    if version_exists_anywhere "$VERSION"; then
        die "版本 ${VERSION_TAG} 在 本地 / GitHub / Docker Hub 中已存在，拒绝覆盖"
    fi
fi

# -------------------- 同步 package.json 的 version --------------------
# 让前端 UI（例如设置面板底部版本号）在 docker image 构建前就看到最新版本，
# vite 构建时会把该值通过 `define` 注入到打包产物里。
# 注意：这里只改根 package.json 的 "version"，不改 frontend/ 下的 workspace 版本。
sync_root_pkg_version() {
    local target_version="$1"
    local pkg_file
    pkg_file="${REPO_ROOT:-.}/package.json"
    [ -f "$pkg_file" ] || pkg_file="package.json"
    [ -f "$pkg_file" ] || return 0

    # 读取当前版本
    local current
    current="$(grep -oE '"version"\s*:\s*"[^"]+"' "$pkg_file" | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
    if [ "$current" = "$target_version" ]; then
        info "package.json version 已是 ${target_version}，无需改写"
        return 0
    fi

    info "更新 package.json version: ${current:-(空)} -> ${target_version}"
    # 用 sed 原地替换第一处 "version": "..."（根 package.json 不会含嵌套 version）
    # 兼容 BSD sed（macOS）与 GNU sed
    if sed --version >/dev/null 2>&1; then
        sed -i -E "0,/\"version\"\s*:\s*\"[^\"]+\"/s//\"version\": \"${target_version}\"/" "$pkg_file"
    else
        sed -i '' -E "1,/\"version\"[[:space:]]*:[[:space:]]*\"[^\"]+\"/s//\"version\": \"${target_version}\"/" "$pkg_file"
    fi
}

if [ "$BUILD_ONLY" != "1" ]; then
    sync_root_pkg_version "$VERSION"
fi

# -------------------- Android versionCode / versionName 同步 --------------------
# frontend/android/app/build.gradle 里有硬编码的 `versionCode N` / `versionName "X"`，
# 发版前必须改成本次 VERSION。versionCode 用 MAJOR*10000 + MINOR*100 + PATCH 生成
# （单调递增、不受预发布后缀影响），versionName 直接等于 VERSION。
android_version_code_of() {
    # 入参: X.Y.Z[-suffix]  ->  整数
    local v="$1"
    local base="${v%%-*}"   # 去掉 -rc.1 之类的后缀
    local major minor patch
    IFS='.' read -r major minor patch <<EOF
$base
EOF
    printf '%d\n' "$(( (major * 10000) + (minor * 100) + patch ))"
}

sync_android_version() {
    local target_version="$1"
    local gradle_file="${REPO_ROOT}/frontend/android/app/build.gradle"
    [ -f "$gradle_file" ] || {
        warn "未找到 $gradle_file，跳过 Android 版本号同步"
        return 0
    }

    local new_code cur_name cur_code
    new_code="$(android_version_code_of "$target_version")"
    cur_name="$(grep -oE 'versionName[[:space:]]+"[^"]+"' "$gradle_file" | head -1 | sed -E 's/.*"([^"]+)"/\1/')"
    cur_code="$(grep -oE 'versionCode[[:space:]]+[0-9]+' "$gradle_file" | head -1 | awk '{print $2}')"

    if [ "$cur_name" = "$target_version" ] && [ "$cur_code" = "$new_code" ]; then
        info "Android build.gradle 版本已是 ${target_version}/${new_code}，无需改写"
        return 0
    fi

    info "更新 Android build.gradle: versionName ${cur_name:-?} -> ${target_version}, versionCode ${cur_code:-?} -> ${new_code}"

    # sed 原地替换（兼容 GNU / BSD）
    if sed --version >/dev/null 2>&1; then
        sed -i -E "s/versionCode[[:space:]]+[0-9]+/versionCode ${new_code}/" "$gradle_file"
        sed -i -E "s/versionName[[:space:]]+\"[^\"]+\"/versionName \"${target_version}\"/" "$gradle_file"
    else
        sed -i '' -E "s/versionCode[[:space:]]+[0-9]+/versionCode ${new_code}/" "$gradle_file"
        sed -i '' -E "s/versionName[[:space:]]+\"[^\"]+\"/versionName \"${target_version}\"/" "$gradle_file"
    fi
}

if [ "$BUILD_ONLY" != "1" ] && [ "$HAS_ANDROID" = "1" ]; then
    sync_android_version "$VERSION"
fi

# -------------------- 发布 / 构建 摘要 --------------------
case "$ARCH" in
    amd64) PLATFORM_DESC="linux/amd64（原生 docker build）" ;;
    arm64) PLATFORM_DESC="linux/arm64（buildx，QEMU 模拟）" ;;
    multi) PLATFORM_DESC="linux/amd64,linux/arm64（buildx --push，多架构 manifest）" ;;
esac

if [ "$BUILD_ONLY" = "1" ]; then
    step "构建摘要"
    echo "  目标镜像      : ${FULL_IMAGE}"
    echo "  构建架构      : ${PLATFORM_DESC}"
    if [ "$DO_TAR" = "1" ]; then
        echo "  输出方式      : --output type=docker,dest=${TAR_OUT}"
    elif [ "$DO_PUSH_CUSTOM" = "1" ]; then
        echo "  输出方式      : --push（推送到 ${FULL_IMAGE%:*}）"
    elif [ "$ARCH" = "arm64" ]; then
        echo "  输出方式      : --load（加载到本机 docker）"
    else
        echo "  输出方式      : 本机 docker 镜像"
    fi
    echo "  git commit    : ${GIT_COMMIT}"
    echo "  构建时间      : ${BUILD_DATE}"
else
    step "发布摘要"
    echo "  版本 tag      : ${VERSION_TAG}"
    echo "  目标集合      : ${TARGETS}"
    if [ "$HAS_DOCKER" = "1" ]; then
        echo "  Docker 仓库   : ${IMAGE_NAME}"
        echo "  Docker 架构   : ${PLATFORM_DESC}"
        echo "  Docker latest : $([ "$DO_LATEST" = "1" ] && echo yes || echo no)"
    fi
    if [ "$HAS_PC" = "1" ]; then
        echo "  PC 打包       : electron-builder（平台: ${PC_PLATFORMS}）"
        if [ "$RESTORE_BACKEND_ABI" = "1" ]; then
            echo "                  (打包后自动恢复 backend better-sqlite3 到 Node ABI)"
        fi
    fi
    if [ "$HAS_ANDROID" = "1" ]; then
        if [ "$ANDROID_USE_DOCKER" = "1" ]; then
            if [ "$ANDROID_DOCKER_SYNC" = "1" ]; then
                echo "  Android 打包  : Docker（镜像: ${ANDROID_DOCKER_IMAGE}，前端 + gradle 全在容器内）"
            else
                echo "  Android 打包  : Docker + Capacitor + gradlew assembleRelease（镜像: ${ANDROID_DOCKER_IMAGE}）"
            fi
        else
            echo "  Android 打包  : Capacitor + gradlew assembleRelease（本机）"
        fi
        echo "  Android 版本  : versionName=${VERSION}, versionCode=$(android_version_code_of "$VERSION")"
    fi
    echo "  同步 git tag  : $([ "$DO_GIT_TAG" = "1" ] && echo yes || echo no)"
    echo "  GitHub Release: $([ "$DO_GITHUB_RELEASE" = "1" ] && echo yes || echo no)"
    echo "  git commit    : ${GIT_COMMIT}"
    echo "  构建时间      : ${BUILD_DATE}"
    if [ "$HAS_DOCKER" = "1" ] && [ "$ARCH" = "multi" ]; then
        echo "  ${C_YELLOW}注意          : multi 模式会直接 push 多架构 manifest 到 Docker Hub${C_RESET}"
    fi
fi
[ "$DRY_RUN" = "1" ] && echo "  ${C_YELLOW}模式          : DRY-RUN（不真实执行）${C_RESET}"

if [ "$ASSUME_YES" != "1" ]; then
    echo
    read -r -p "确认？[y/N] " ans
    case "$ans" in [yY]|[yY][eE][sS]) ;; *) die "已取消" ;; esac
fi

# -------------------- 构建 tags 与 labels --------------------
START_TS=$(date +%s)

# 各个 target 实际是否"被执行"，发布模式下由 HAS_DOCKER/HAS_PC/HAS_ANDROID 决定；
# 构建模式 (BUILD_ONLY=1) 强制只跑 docker，前面参数校验已保证这点。
SHOULD_BUILD_DOCKER=$( [ "$BUILD_ONLY" = "1" ] && echo 1 || echo "$HAS_DOCKER" )

BUILD_TAGS=()
if [ "$SHOULD_BUILD_DOCKER" = "1" ]; then
    if [ "$BUILD_ONLY" = "1" ]; then
        BUILD_TAGS=( -t "${FULL_IMAGE}" )
    else
        BUILD_TAGS=( -t "${IMAGE_NAME}:${VERSION_TAG}" )
        [ "$DO_LATEST" = "1" ] && BUILD_TAGS+=( -t "${IMAGE_NAME}:latest" )
    fi
fi

# OCI 标签：便于 docker inspect 时追溯
OCI_LABELS=(
    --label "org.opencontainers.image.revision=${GIT_SHA}"
    --label "org.opencontainers.image.created=${BUILD_DATE}"
    --label "org.opencontainers.image.source=${GITHUB_REPO_URL}"
    --label "org.opencontainers.image.title=nowen-note"
)
[ -n "$VERSION_TAG" ] && OCI_LABELS+=( --label "org.opencontainers.image.version=${VERSION_TAG}" )

# 确保 buildx builder 存在（仅 arm64/multi 需要）
ensure_buildx_builder() {
    if ! docker buildx inspect "$BUILDX_BUILDER" >/dev/null 2>&1; then
        info "创建 buildx builder: $BUILDX_BUILDER"
        run_argv docker buildx create --name "$BUILDX_BUILDER" --use
    else
        run_argv docker buildx use "$BUILDX_BUILDER"
    fi
    run_argv docker buildx inspect --bootstrap
}

BUILD_DURATION=0
if [ "$SHOULD_BUILD_DOCKER" = "1" ]; then
    step "开始构建 Docker 镜像"
    BUILD_START=$(date +%s)

    # 计算 buildx 输出模式（--load / --push / --output）
    BUILDX_OUTPUT=()
    if [ "$BUILD_ONLY" = "1" ]; then
        if [ "$DO_TAR" = "1" ]; then
            BUILDX_OUTPUT=( --output "type=docker,dest=${TAR_OUT}" )
        elif [ "$DO_PUSH_CUSTOM" = "1" ]; then
            BUILDX_OUTPUT=( --push )
        else
            # 构建模式下 arm64 默认 --load；multi 已在前面被强制为 --push
            BUILDX_OUTPUT=( --load )
        fi
    else
        # 发布模式：arm64 用 --load（稍后 docker push），multi 用 --push（直接多架构推送）
        if [ "$ARCH" = "multi" ]; then
            BUILDX_OUTPUT=( --push )
        else
            BUILDX_OUTPUT=( --load )
        fi
    fi

    case "$ARCH" in
        amd64)
            # 明确 -f Dockerfile 与上下文路径 "$REPO_ROOT"，避免个别环境下 docker build 被
            # 劫持为 buildx bake 模式时无法正确定位 Dockerfile
            BUILD_CMD=( docker build -f "$REPO_ROOT/Dockerfile" "${BUILD_TAGS[@]}" "${OCI_LABELS[@]}" "$REPO_ROOT" )
            echo "  ${BUILD_CMD[*]}"
            run_argv "${BUILD_CMD[@]}"
            ;;
        arm64)
            ensure_buildx_builder
            BUILD_CMD=(
                docker buildx build
                --platform linux/arm64
                -f "$REPO_ROOT/Dockerfile"
                "${BUILD_TAGS[@]}"
                "${OCI_LABELS[@]}"
                "${BUILDX_OUTPUT[@]}"
                "$REPO_ROOT"
            )
            echo "  ${BUILD_CMD[*]}"
            run_argv "${BUILD_CMD[@]}"
            ;;
        multi)
            ensure_buildx_builder
            # 多架构 manifest 不能 --load 也不能导成单 tar，只能 --push
            BUILD_CMD=(
                docker buildx build
                --platform linux/amd64,linux/arm64
                -f "$REPO_ROOT/Dockerfile"
                "${BUILD_TAGS[@]}"
                "${OCI_LABELS[@]}"
                --push
                "$REPO_ROOT"
            )
            echo "  ${BUILD_CMD[*]}"
            run_argv "${BUILD_CMD[@]}"
            ;;
    esac

    BUILD_END=$(date +%s)
    BUILD_DURATION=$((BUILD_END - BUILD_START))
    ok "Docker 构建完成，用时 ${BUILD_DURATION}s"
fi

# -------------------- 构建模式：到此结束 --------------------
if [ "$BUILD_ONLY" = "1" ]; then
    END_TS=$(date +%s)
    TOTAL=$((END_TS - START_TS))

    step "构建完成"
    if [ "$DO_TAR" = "1" ]; then
        echo "  ${C_GREEN}${TAR_OUT}${C_RESET}  ←  已写入"
        echo
        echo "在板子上离线加载："
        printf "    docker load -i %s\n" "$TAR_OUT"
        printf "    docker run --platform linux/arm64 -p 3001:3001 %s\n" "$FULL_IMAGE"
    elif [ "$DO_PUSH_CUSTOM" = "1" ]; then
        echo "  ${C_GREEN}${FULL_IMAGE}${C_RESET}  ←  已推送"
        echo
        echo "在板子 / 服务器上："
        printf "    docker pull %s\n" "$FULL_IMAGE"
    else
        echo "  ${C_GREEN}${FULL_IMAGE}${C_RESET}  ←  已加载到本机 docker"
        echo
        echo "本机测试："
        printf "    docker run --platform linux/arm64 -p 3001:3001 %s\n" "$FULL_IMAGE"
    fi
    echo "  构建架构      : ${PLATFORM_DESC}"
    echo "  总耗时        : ${TOTAL}s"
    echo
    ok "完成"
    exit 0
fi

# -------------------- 发布模式：docker push（arm64 / amd64） --------------------
PUSH_DURATION=0
if [ "$SHOULD_BUILD_DOCKER" = "1" ]; then
    if [ "$ARCH" = "multi" ]; then
        info "multi 模式 buildx 已经把镜像直接推送到 Docker Hub，跳过单独 push 步骤"
    else
        step "推送镜像"
        PUSH_START=$(date +%s)
        info "推送：${IMAGE_NAME}:${VERSION_TAG}"
        run "docker push \"${IMAGE_NAME}:${VERSION_TAG}\""

        if [ "$DO_LATEST" = "1" ]; then
            info "推送：${IMAGE_NAME}:latest"
            run "docker push \"${IMAGE_NAME}:latest\""
        fi
        PUSH_END=$(date +%s)
        PUSH_DURATION=$((PUSH_END - PUSH_START))
    fi
fi

# 尝试获取 digest（multi 模式本地没镜像，拿不到，留空）
DIGEST=""
if [ "$SHOULD_BUILD_DOCKER" = "1" ] && [ "$DRY_RUN" != "1" ] && [ "$ARCH" != "multi" ]; then
    DIGEST="$(docker inspect --format='{{index .RepoDigests 0}}' "${IMAGE_NAME}:${VERSION_TAG}" 2>/dev/null || echo "")"
fi

# -------------------- PC 端打包（electron-builder） --------------------
# 产物会通过 safe-build.mjs 设的 NOWEN_BUILD_OUT=1 输出到 %TEMP%/nowen-note-build
# 或 dist-electron/（取决于 builder.config.js 的逻辑）。
# 我们收集本次所有 PC 平台安装包路径，用于后续上传到 GitHub Release。
#
# 宿主 OS 策略：
#   - Windows:        走 safe-build.mjs（内部做 taskkill + rcedit 日志降噪），只出 win 目标
#   - Linux/macOS:    直接调 electron-builder，按 PC_PLATFORMS 拼 --win / --linux / --mac
#                     跨平台打 win 需要 wine + mono（前置检查已过）
PC_ARTIFACTS=()
PC_BUILD_DURATION=0
if [ "$HAS_PC" = "1" ]; then
    step "PC 端打包（electron-builder）"
    PC_START=$(date +%s)

    UNAME_S_PC="$(uname -s 2>/dev/null || echo unknown)"

    # 统一先跑 rebuild:native + build:all（safe-build.mjs 内部也是这三步，这里拆开以便非 Windows 分支复用）
    if [ "$UNAME_S_PC" = "Linux" ] || [ "$UNAME_S_PC" = "Darwin" ]; then
        # 输出目录：在 Linux/macOS 上不做 tmpdir 切换，默认 dist-electron/
        # （NOWEN_BUILD_OUT 主要是 Windows 下避免 IDE 监听，Linux/macOS 不需要）
        info "rebuild:native + build:all"
        if [ "$DRY_RUN" = "1" ]; then
            echo "  (dry-run) npm run rebuild:native"
            echo "  (dry-run) npm run build:all"
        else
            ( cd "$REPO_ROOT" && run_argv npm run rebuild:native )
            ( cd "$REPO_ROOT" && run_argv npm run build:all )
        fi

        # 拼 electron-builder 平台参数
        EB_PLATFORM_ARGS=()
        [ "$PC_HAS_WIN" = "1" ]   && EB_PLATFORM_ARGS+=( --win )
        [ "$PC_HAS_LINUX" = "1" ] && EB_PLATFORM_ARGS+=( --linux )
        [ "$PC_HAS_MAC" = "1" ]   && EB_PLATFORM_ARGS+=( --mac )

        info "electron-builder ${EB_PLATFORM_ARGS[*]}"
        if [ "$DRY_RUN" = "1" ]; then
            echo "  (dry-run) npx electron-builder --config electron/builder.config.js ${EB_PLATFORM_ARGS[*]}"
        else
            # 临时关闭 publish（避免无意义尝试推 GitHub；我们自己用 gh release 上传）
            # -c.publish=never 会覆盖 config.publish
            ( cd "$REPO_ROOT" && run_argv npx electron-builder \
                --config electron/builder.config.js \
                -c.publish=never \
                "${EB_PLATFORM_ARGS[@]}" )
        fi
    else
        # Windows 宿主：沿用 safe-build.mjs（只会出 win 目标，这里忽略用户 --pc-platform 里的 linux/mac）
        if [ "$PC_HAS_LINUX" = "1" ] || [ "$PC_HAS_MAC" = "1" ]; then
            warn "Windows 宿主暂不支持跨平台打 linux/mac 目标，本次仅产出 Windows 目标"
        fi
        if [ "$DRY_RUN" = "1" ]; then
            echo "  (dry-run) node scripts/safe-build.mjs"
        else
            run_argv node "$REPO_ROOT/scripts/safe-build.mjs"
        fi
    fi

    # 解析产物目录：
    #   - Windows safe-build.mjs 用 NOWEN_BUILD_OUT=1 => %TEMP%/nowen-note-build
    #   - Linux/macOS 直接走 dist-electron/
    PC_OUT_CANDIDATES=(
        "${REPO_ROOT}/dist-electron"
        "$(node -e 'console.log(require("os").tmpdir())' 2>/dev/null)/nowen-note-build"
    )
    PC_OUT=""
    for cand in "${PC_OUT_CANDIDATES[@]}"; do
        if [ -d "$cand" ]; then
            PC_OUT="$cand"
            break
        fi
    done

    if [ "$DRY_RUN" != "1" ] && [ -n "$PC_OUT" ]; then
        # 收集要上传的产物：.exe / .dmg / .AppImage / .deb / -portable.exe / .zip / .blockmap / latest*.yml
        # electron-updater 需要 latest.yml / latest-mac.yml / latest-linux.yml + blockmap
        while IFS= read -r f; do
            PC_ARTIFACTS+=( "$f" )
        done < <(
            find "$PC_OUT" -maxdepth 1 -type f \( \
                -name "*.exe" -o \
                -name "*.dmg" -o \
                -name "*.zip" -o \
                -name "*.AppImage" -o \
                -name "*.deb" -o \
                -name "*.blockmap" -o \
                -name "latest*.yml" \
            \) 2>/dev/null | sort
        )
        info "PC 产物目录: $PC_OUT"
        for f in "${PC_ARTIFACTS[@]}"; do
            echo "    - $(basename "$f")"
        done
    fi

    PC_END=$(date +%s)
    PC_BUILD_DURATION=$((PC_END - PC_START))
    ok "PC 打包完成，用时 ${PC_BUILD_DURATION}s"

    # ---- 恢复 backend better-sqlite3 的 Node ABI（可选） ----
    # rebuild:native 把 backend/better-sqlite3 编成 Electron ABI，纯 Node 的 tsx 就跑不动了。
    # 加 --restore-backend-abi 后，这里把它再 rebuild 回当前 Node 的 ABI。
    if [ "$RESTORE_BACKEND_ABI" = "1" ]; then
        step "恢复 backend better-sqlite3 到 Node ABI（--restore-backend-abi）"
        if [ ! -d "${REPO_ROOT}/backend/node_modules/better-sqlite3" ]; then
            warn "backend/node_modules/better-sqlite3 不存在，跳过"
        elif [ "$DRY_RUN" = "1" ]; then
            echo "  (dry-run) cd backend && npm rebuild better-sqlite3"
        else
            ( cd "$REPO_ROOT/backend" && run_argv npm rebuild better-sqlite3 ) \
                || warn "rebuild better-sqlite3 (Node ABI) 失败；后续 npm run dev:backend 可能会报 ABI 不匹配，可手动 cd backend && npm rebuild better-sqlite3"
            ok "backend ABI 已恢复为 Node（dev:backend 可直接跑）"
        fi
    fi
fi

# -------------------- Android 端打包（Capacitor + Gradle） --------------------
#
# Keystore 注入（CI 场景常用）：
#   若设置了 NOWEN_ANDROID_KEYSTORE_B64，会把它 base64 -d 还原为 keystore 文件，
#   并自动生成 frontend/android/keystore.properties。
#   环境变量（全部可选，仅在传入 NOWEN_ANDROID_KEYSTORE_B64 时才读）：
#     NOWEN_ANDROID_KEYSTORE_B64        keystore 文件 base64
#     NOWEN_ANDROID_KEYSTORE_PASSWORD   store 密码
#     NOWEN_ANDROID_KEY_ALIAS           key alias（默认 nowen-release）
#     NOWEN_ANDROID_KEY_PASSWORD        key 密码（未设则沿用 store 密码）
#
# trap 机制：
#   成功或失败退出时都会清理临时生成的 keystore / keystore.properties，
#   避免把敏感文件遗留在工作区。（若 keystore.properties 原本就存在，不做任何事）
ANDROID_ARTIFACTS=()
ANDROID_BUILD_DURATION=0
ANDROID_KEYSTORE_TEMP_CREATED=0
ANDROID_KEYSTORE_PROPS_TEMP_CREATED=0

cleanup_android_keystore() {
    # 只清理脚本自己创建的；原本就存在的文件不动
    if [ "$ANDROID_KEYSTORE_TEMP_CREATED" = "1" ]; then
        rm -f "${REPO_ROOT}/frontend/android/app/nowen-release.keystore" 2>/dev/null || true
    fi
    if [ "$ANDROID_KEYSTORE_PROPS_TEMP_CREATED" = "1" ]; then
        rm -f "${REPO_ROOT}/frontend/android/keystore.properties" 2>/dev/null || true
    fi
}

prepare_android_keystore() {
    # 幂等：外部已有 keystore.properties 时不覆盖，仅在用户提供了 B64 环境变量时才自动生成
    local props_file="${REPO_ROOT}/frontend/android/keystore.properties"
    local keystore_path="${REPO_ROOT}/frontend/android/app/nowen-release.keystore"

    if [ -z "${NOWEN_ANDROID_KEYSTORE_B64:-}" ]; then
        return 0
    fi

    if [ -f "$props_file" ]; then
        warn "检测到已有 keystore.properties，忽略 NOWEN_ANDROID_KEYSTORE_B64（不覆盖）"
        return 0
    fi

    command -v base64 >/dev/null 2>&1 || die "需要 base64 命令来还原 keystore"

    local store_pwd="${NOWEN_ANDROID_KEYSTORE_PASSWORD:-}"
    local key_alias="${NOWEN_ANDROID_KEY_ALIAS:-nowen-release}"
    local key_pwd="${NOWEN_ANDROID_KEY_PASSWORD:-$store_pwd}"

    [ -n "$store_pwd" ] || die "设置了 NOWEN_ANDROID_KEYSTORE_B64 但未设 NOWEN_ANDROID_KEYSTORE_PASSWORD"

    info "从环境变量还原 Android keystore -> $keystore_path"
    if [ "$DRY_RUN" = "1" ]; then
        echo "  (dry-run) 解码 keystore 并写入 keystore.properties"
    else
        # macOS 与 Linux 的 base64 兼容：-d 在两者上都支持
        printf '%s' "$NOWEN_ANDROID_KEYSTORE_B64" | base64 -d > "$keystore_path" \
            || die "NOWEN_ANDROID_KEYSTORE_B64 解码失败（是否正确的 base64？）"
        ANDROID_KEYSTORE_TEMP_CREATED=1

        # keystore.properties 中的 storeFile 是相对于 rootProject.projectDir（即 frontend/android/）
        # 所以这里写 "app/nowen-release.keystore"
        cat > "$props_file" <<EOF
storeFile=app/nowen-release.keystore
storePassword=${store_pwd}
keyAlias=${key_alias}
keyPassword=${key_pwd}
EOF
        chmod 600 "$props_file" 2>/dev/null || true
        ANDROID_KEYSTORE_PROPS_TEMP_CREATED=1
        ok "keystore.properties 已生成（将于脚本退出时清理）"
    fi
}

if [ "$HAS_ANDROID" = "1" ]; then
    # 注册清理 trap（幂等：多次调用 trap 会覆盖前一次）
    trap cleanup_android_keystore EXIT

    step "Android 端打包（Capacitor + gradlew assembleRelease）"
    ANDROID_START=$(date +%s)

    # 0. 先从环境变量还原 keystore（如有）
    prepare_android_keystore

    # 1. 前端 + capacitor sync
    # 默认：在宿主 node 上跑 `npm run build` + `npx cap sync android`
    # --android-docker-sync：连同这两步也放进 Docker（镜像里自带 node，宿主可完全不装 node）
    if [ "$ANDROID_DOCKER_SYNC" = "1" ]; then
        info "frontend build + npx cap sync android（Docker 内）"
        GRADLE_CACHE_VOL="${HOME}/.gradle-docker-nowen-note"
        mkdir -p "$GRADLE_CACHE_VOL"
        # 同步用一个 npm 缓存卷，避免每次都重新下载依赖
        NPM_CACHE_VOL="${HOME}/.npm-docker-nowen-note"
        mkdir -p "$NPM_CACHE_VOL"
        DOCKER_UID="$(id -u 2>/dev/null || echo 1000)"
        DOCKER_GID="$(id -g 2>/dev/null || echo 1000)"

        if [ "$DRY_RUN" = "1" ]; then
            echo "  (dry-run) docker run ... ${ANDROID_DOCKER_IMAGE} bash -lc 'cd frontend && npm ci && npm run build && npx cap sync android'"
        else
            # frontend 的依赖若没装，这里 npm ci 一把；已装则 cap sync 会直接复用
            run_argv docker run --rm \
                -u "${DOCKER_UID}:${DOCKER_GID}" \
                -v "${REPO_ROOT}:/workspace" \
                -v "${NPM_CACHE_VOL}:/home/circleci/.npm" \
                -w /workspace \
                -e npm_config_cache=/home/circleci/.npm \
                "${ANDROID_DOCKER_IMAGE}" \
                bash -lc '
                    set -e
                    cd frontend
                    if [ ! -d node_modules ]; then
                        echo "[docker] frontend/node_modules 不存在，执行 npm ci"
                        npm ci --no-audit --no-fund
                    fi
                    npm run build
                    npx cap sync android
                '
        fi
    else
        info "frontend build + npx cap sync android（宿主 node）"
        if [ "$DRY_RUN" = "1" ]; then
            echo "  (dry-run) cd frontend && npm run build && npx cap sync android"
        else
            ( cd "$REPO_ROOT/frontend" && run_argv npm run build )
            ( cd "$REPO_ROOT/frontend" && run_argv npx cap sync android )
        fi
    fi

    # 2. gradle assembleRelease —— 本机 or Docker
    if [ "$ANDROID_USE_DOCKER" = "1" ]; then
        # Docker 模式：把仓库挂进容器里跑 gradlew。
        # cimg/android:2024.01.1-node 自带 JDK 17 + Android SDK + Node，国内机器首次拉会慢些。
        # - 用 host 的 UID/GID 避免产物文件变成 root
        # - 挂载 ~/.gradle 作为缓存，避免每次重跑都下载依赖
        GRADLE_CACHE_VOL="${HOME}/.gradle-docker-nowen-note"
        mkdir -p "$GRADLE_CACHE_VOL"

        # 构造 docker 命令
        # --network host：gradle 拉依赖更快；如环境受限可删
        DOCKER_UID="$(id -u 2>/dev/null || echo 1000)"
        DOCKER_GID="$(id -g 2>/dev/null || echo 1000)"

        info "docker run ${ANDROID_DOCKER_IMAGE} -> gradlew assembleRelease"
        if [ "$DRY_RUN" = "1" ]; then
            echo "  (dry-run) docker run --rm -v ${REPO_ROOT}:/workspace -w /workspace/frontend/android ${ANDROID_DOCKER_IMAGE} ./gradlew assembleRelease"
        else
            # 注意：镜像里需要有 Android SDK 和 JDK 17；cimg/android 已经满足。
            # 如果你换用更精简的镜像（如 openjdk:17 + SDK 手动装），记得在镜像里配好 ANDROID_HOME。
            run_argv docker run --rm \
                -u "${DOCKER_UID}:${DOCKER_GID}" \
                -v "${REPO_ROOT}:/workspace" \
                -v "${GRADLE_CACHE_VOL}:/home/circleci/.gradle" \
                -w /workspace/frontend/android \
                -e GRADLE_USER_HOME=/home/circleci/.gradle \
                "${ANDROID_DOCKER_IMAGE}" \
                bash -lc "chmod +x ./gradlew && ./gradlew assembleRelease --no-daemon"
        fi
    else
        # 本机 gradlew
        UNAME_S_AND="$(uname -s 2>/dev/null || echo unknown)"
        case "$UNAME_S_AND" in
            MINGW*|MSYS*|CYGWIN*) GRADLEW="gradlew.bat" ;;
            *)                    GRADLEW="./gradlew" ;;
        esac

        info "gradlew assembleRelease（本机）"
        if [ "$DRY_RUN" = "1" ]; then
            echo "  (dry-run) cd frontend/android && $GRADLEW assembleRelease"
        else
            ( cd "$REPO_ROOT/frontend/android" && run_argv $GRADLEW assembleRelease )
        fi
    fi

    # 3. 收集 APK 产物并重命名（加上 version 后缀，避免覆盖）
    if [ "$DRY_RUN" != "1" ]; then
        APK_SRC="${REPO_ROOT}/frontend/android/app/build/outputs/apk/release/app-release.apk"
        if [ -f "$APK_SRC" ]; then
            APK_OUT="${REPO_ROOT}/frontend/android/app/build/outputs/apk/release/Nowen-Note-${VERSION}.apk"
            cp -f "$APK_SRC" "$APK_OUT"
            ANDROID_ARTIFACTS+=( "$APK_OUT" )
            info "APK: $APK_OUT"
        else
            # 未签名 APK
            APK_UNSIGNED="${REPO_ROOT}/frontend/android/app/build/outputs/apk/release/app-release-unsigned.apk"
            if [ -f "$APK_UNSIGNED" ]; then
                warn "只找到未签名 APK: $APK_UNSIGNED"
                warn "检查 frontend/android/keystore.properties 或 NOWEN_ANDROID_KEYSTORE_B64 是否配置正确"
                ANDROID_ARTIFACTS+=( "$APK_UNSIGNED" )
            else
                die "Android 打包成功但找不到 APK 产物"
            fi
        fi
    fi

    ANDROID_END=$(date +%s)
    ANDROID_BUILD_DURATION=$((ANDROID_END - ANDROID_START))
    ok "Android 打包完成，用时 ${ANDROID_BUILD_DURATION}s"
fi

# -------------------- git tag --------------------
if [ "$DO_GIT_TAG" = "1" ]; then
    step "打 git tag 并推送到 GitHub"

    # 若前面 sync_root_pkg_version / sync_android_version 修改了 package.json
    # 或 android/build.gradle，一并 commit，这样 git tag 会落在"版本号已更新"的 commit 上。
    CHANGED_FILES=()
    if [ -n "$(git status --porcelain -- package.json 2>/dev/null)" ]; then
        CHANGED_FILES+=( "package.json" )
    fi
    if [ -n "$(git status --porcelain -- frontend/android/app/build.gradle 2>/dev/null)" ]; then
        CHANGED_FILES+=( "frontend/android/app/build.gradle" )
    fi
    if [ "${#CHANGED_FILES[@]}" -gt 0 ]; then
        info "版本相关文件有变更，先 commit: ${CHANGED_FILES[*]}"
        if [ "$DRY_RUN" = "1" ]; then
            echo "  (dry-run) git add ${CHANGED_FILES[*]} && git commit -m \"chore(release): ${VERSION_TAG}\""
        else
            run_argv git add "${CHANGED_FILES[@]}"
            run "git commit -m \"chore(release): ${VERSION_TAG}\""
        fi
    fi

    if git rev-parse -q --verify "refs/tags/${VERSION_TAG}" >/dev/null 2>&1; then
        info "本地 tag ${VERSION_TAG} 已存在，跳过创建"
    else
        info "git tag -a ${VERSION_TAG} -m 'Release ${VERSION_TAG}'"
        run "git tag -a \"${VERSION_TAG}\" -m \"Release ${VERSION_TAG}\""
    fi
    info "git push origin ${VERSION_TAG}"
    if [ "$DRY_RUN" = "1" ]; then
        echo "  (dry-run) git push origin HEAD && git push origin \"${VERSION_TAG}\""
    elif git push origin HEAD && git push origin "${VERSION_TAG}"; then
        ok "git commit + tag ${VERSION_TAG} 已推送"
    else
        echo
        echo "${C_YELLOW}[!] git push tag 失败（Docker 镜像已推送，本地 tag 已保留）${C_RESET}"
        echo "    常见原因：GitHub 已禁用密码认证，需使用 PAT 或 SSH key"
        echo "    修复方式任选一种，然后补推："
        echo "      git push origin ${VERSION_TAG}"
        echo
        echo "    方案 A（PAT，推荐）："
        echo "      1. https://github.com/settings/tokens 生成 fine-grained token（Contents: RW）"
        echo "      2. git config --global credential.helper store"
        echo "      3. git push origin ${VERSION_TAG}   # 用户名: GitHub 用户名；密码: 粘贴 PAT"
        echo
        echo "    方案 B（SSH key）："
        echo "      1. ssh-keygen -t ed25519 -C \"\$(hostname)\""
        echo "      2. cat ~/.ssh/id_ed25519.pub  → 添加到 https://github.com/settings/keys"
        echo "      3. git remote set-url origin git@github.com:${GITHUB_REPO_SLUG}.git"
        echo "      4. git push origin ${VERSION_TAG}"
        die "git tag 推送失败"
    fi
else
    info "跳过 git tag（--no-git-tag）"
fi

# -------------------- GitHub Release（多端产物统一上传） --------------------
# 走 gh CLI（https://cli.github.com/），产物作为 Release assets 上传到 vX.Y.Z tag 上。
# 要求：
#   1. 环境已装 gh 且 gh auth status 通过，或设 GH_TOKEN 环境变量
#   2. DO_GIT_TAG=1（tag 必须先推到远端，gh release create 才能找到）
#   3. 收集到至少一个产物（PC_ARTIFACTS / ANDROID_ARTIFACTS 非空）
RELEASE_URL=""
if [ "$DO_GITHUB_RELEASE" = "1" ]; then
    step "发布到 GitHub Releases"

    if [ "$DO_GIT_TAG" != "1" ]; then
        die "--github-release 需要同时打 git tag（不要与 --no-git-tag 一起用）"
    fi

    command -v gh >/dev/null 2>&1 || die "未安装 gh CLI。请先安装：https://cli.github.com/"
    # gh 登录状态或 GH_TOKEN 任一满足即可
    if ! gh auth status >/dev/null 2>&1 && [ -z "${GH_TOKEN:-}" ]; then
        die "gh 未登录（gh auth login），且未设置 GH_TOKEN 环境变量"
    fi

    # 是否预发布：显式 --prerelease 或版本号带 - 后缀
    IS_PRERELEASE=0
    [ "$RELEASE_PRERELEASE" = "1" ] && IS_PRERELEASE=1
    case "$VERSION" in *-*) IS_PRERELEASE=1 ;; esac

    # 整理 release notes
    NOTES_ARGS=()
    if [ -n "$RELEASE_NOTES_FILE" ]; then
        [ -f "$RELEASE_NOTES_FILE" ] || die "--notes-file 不存在: $RELEASE_NOTES_FILE"
        NOTES_ARGS=( --notes-file "$RELEASE_NOTES_FILE" )
    elif [ -n "$RELEASE_NOTES" ]; then
        NOTES_ARGS=( --notes "$RELEASE_NOTES" )
    else
        # 自动生成一份默认说明
        AUTO_NOTES="Release ${VERSION_TAG}"$'\n\n'"Targets: ${TARGETS}"
        if [ "$HAS_DOCKER" = "1" ]; then
            AUTO_NOTES+=$'\n\n'"Docker image: \`${IMAGE_NAME}:${VERSION_TAG}\`"
            [ "$DO_LATEST" = "1" ] && AUTO_NOTES+=$'\n'"Docker image: \`${IMAGE_NAME}:latest\`"
        fi
        AUTO_NOTES+=$'\n\n'"Commit: ${GIT_COMMIT}"
        NOTES_ARGS=( --notes "$AUTO_NOTES" )
    fi

    # 合并所有产物
    ALL_ASSETS=()
    [ "${#PC_ARTIFACTS[@]}" -gt 0 ]      && ALL_ASSETS+=( "${PC_ARTIFACTS[@]}" )
    [ "${#ANDROID_ARTIFACTS[@]}" -gt 0 ] && ALL_ASSETS+=( "${ANDROID_ARTIFACTS[@]}" )

    if [ "${#ALL_ASSETS[@]}" -eq 0 ]; then
        warn "没有产物需要上传到 GitHub Release，跳过"
    else
        info "将上传 ${#ALL_ASSETS[@]} 个产物到 ${GITHUB_REPO_SLUG} @ ${VERSION_TAG}"
        for f in "${ALL_ASSETS[@]}"; do
            echo "    - $(basename "$f")  ($(du -h "$f" 2>/dev/null | awk '{print $1}'))"
        done

        # gh release create 的开关组装
        CREATE_ARGS=(
            release create "$VERSION_TAG"
            --repo "$GITHUB_REPO_SLUG"
            --title "$VERSION_TAG"
            --target "$(git rev-parse HEAD)"
        )
        [ "$IS_PRERELEASE" = "1" ] && CREATE_ARGS+=( --prerelease )
        [ "$RELEASE_DRAFT" = "1" ] && CREATE_ARGS+=( --draft )
        CREATE_ARGS+=( "${NOTES_ARGS[@]}" )
        CREATE_ARGS+=( "${ALL_ASSETS[@]}" )

        if [ "$DRY_RUN" = "1" ]; then
            echo "  (dry-run) gh ${CREATE_ARGS[*]}"
        else
            # 已存在的 release 就改用 upload（常见于补传失败的那次）
            if gh release view "$VERSION_TAG" --repo "$GITHUB_REPO_SLUG" >/dev/null 2>&1; then
                info "Release ${VERSION_TAG} 已存在，改用 gh release upload --clobber"
                run_argv gh release upload "$VERSION_TAG" \
                    --repo "$GITHUB_REPO_SLUG" \
                    --clobber \
                    "${ALL_ASSETS[@]}"
            else
                run_argv gh "${CREATE_ARGS[@]}"
            fi
            RELEASE_URL="https://github.com/${GITHUB_REPO_SLUG}/releases/tag/${VERSION_TAG}"
            ok "GitHub Release 已发布：${RELEASE_URL}"
        fi
    fi
fi

# -------------------- 完成 --------------------
END_TS=$(date +%s)
TOTAL=$((END_TS - START_TS))

step "发布完成"
if [ "$HAS_DOCKER" = "1" ]; then
    echo "  ${C_GREEN}${IMAGE_NAME}:${VERSION_TAG}${C_RESET}  ←  已推送到 Docker Hub"
    [ "$DO_LATEST" = "1" ] && echo "  ${C_GREEN}${IMAGE_NAME}:latest${C_RESET}  ←  已推送到 Docker Hub"
fi
if [ "$HAS_PC" = "1" ] && [ "${#PC_ARTIFACTS[@]}" -gt 0 ]; then
    echo "  ${C_GREEN}PC 产物${C_RESET}（${#PC_ARTIFACTS[@]} 个）："
    for f in "${PC_ARTIFACTS[@]}"; do
        echo "    - $(basename "$f")"
    done
fi
if [ "$HAS_ANDROID" = "1" ] && [ "${#ANDROID_ARTIFACTS[@]}" -gt 0 ]; then
    echo "  ${C_GREEN}Android 产物${C_RESET}："
    for f in "${ANDROID_ARTIFACTS[@]}"; do
        echo "    - $(basename "$f")"
    done
fi
[ "$DO_GIT_TAG" = "1" ] && echo "  ${C_GREEN}git tag ${VERSION_TAG}${C_RESET}  ←  已推送到 GitHub"
[ -n "$RELEASE_URL" ]   && echo "  ${C_GREEN}GitHub Release${C_RESET}  ←  ${RELEASE_URL}"

echo "  总耗时        : ${TOTAL}s  (docker:${BUILD_DURATION}s push:${PUSH_DURATION}s pc:${PC_BUILD_DURATION}s android:${ANDROID_BUILD_DURATION}s)"
[ -n "$DIGEST" ] && echo "  docker digest : ${DIGEST}"

echo
ok "发布成功 🎉"
echo

if [ "$HAS_DOCKER" = "1" ]; then
    echo "Docker 拉取命令："
    printf "    docker pull %s:%s\n" "$IMAGE_NAME" "$VERSION_TAG"
    [ "$DO_LATEST" = "1" ] && printf "    docker pull %s:latest\n" "$IMAGE_NAME"
fi
if [ -n "$RELEASE_URL" ]; then
    echo
    echo "用户下载入口："
    echo "    $RELEASE_URL"
fi
