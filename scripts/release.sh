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

# ===== 多端发版（PC / Android / Docker / GitHub Releases / 飞牛 .fpk / 绿联 .upk / Lite / Clipper） =====
# TARGETS 用逗号分隔的集合：docker / pc / android / fpk / upk / lite / clipper / all
# 默认 docker（向后兼容旧行为）；all = docker,pc,android,fpk,upk,lite,clipper
TARGETS="docker"
TARGETS_EXPLICIT=0     # 用户是否通过 --target 显式指定了
DO_GITHUB_RELEASE=0    # --github-release：把 PC/Android 产物上传到 GitHub Release（自动打 tag）
NO_GITHUB_RELEASE_EXPLICIT=0  # --no-github-release：显式关闭自动推断
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

# ===== mac 架构选择（仅 PC_HAS_MAC=1 时生效）=====
# 逗号分隔，可选 x64 / arm64；默认 "x64,arm64"·两架构都打。
# 脱离必要性：electron-builder mac.target 已改为单架构读 env NOWEN_MAC_ARCH，
# 这里负责循环：每个 arch 先 rebuild:native，再 electron-builder。
# 历史教训（2026-05 Intel Mac ERR_DLOPEN_FAILED）：
#   原来一次 build 打 arm64+x64 dmg，但 better-sqlite3.node 只能 rebuild 一种架构、
#   另一份装包内是错架构的 .node，用户一打开就 dlopen 失败。
MAC_ARCHES=""          # --mac-arch x64,arm64

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

# ===== 原子发布（all-or-nothing） =====
# 当设为 1 时：先把三端（Docker / PC / Android）全部构建成功，最后统一执行所有
#   "对外可见的推送动作"：docker push / git tag push / gh release。
# 任何一端构建失败，则 Docker Hub / GitHub 都不会留下任何此次版本的痕迹（本地会保留产物用于排查）。
# 场景：
#   - 多端组合（docker+pc / docker+android / 三端）或"一键全量发布"时默认自动开启
#   - 单目标（只 docker 或只 pc 或只 android）时默认关闭（没有意义，也不需要额外 buildx 验证）
#   - --atomic / --no-atomic 可显式覆盖
ATOMIC_RELEASE=-1              # -1=未指定（由目标组合自动推断）；0=关；1=开
ATOMIC_RELEASE_EXPLICIT=0      # 用户通过 --atomic/--no-atomic 显式设置

# ===== 飞牛 .fpk 打包 =====
# 复用 scripts/fpk/build-fpk.mjs。镜像地址默认与 DEFAULT_IMAGE_NAME 保持一致，
# 也可通过 --fpk-dockerhub-repo 或环境变量 DOCKERHUB_REPO 覆盖。
FPK_DOCKERHUB_REPO=""           # --fpk-dockerhub-repo

# ===== 绿联 .upk 打包 =====
# 复用 scripts/upk/build-upk.mjs。与 fpk 不同，upk **必须把镜像 tar 打进包里**，
# 所以该步骤依赖本机 docker daemon 里已有目标 tag 的镜像。
# 安排在 docker push 之前（与 fpk 同原子语义：push 失败不出包）。
#
# 镜像来源策略（按 ARCH 分支）：
#   - amd64 / arm64：前面 buildx 已经 --load 到本机，直接 docker save。
#   - multi（amd64,arm64）：buildx 多架构 manifest **无法 --load 到本机 docker daemon**，
#     第一次构建只把层写进 buildx 缓存。所以这里 upk 段开头会针对每个架构
#     额外跑一次 `buildx --platform linux/<arch> --load`，吃前一次的缓存秒级落地，
#     再交给 build-upk.mjs。这样保留了"upk 失败 → docker 还没推 → 全链路阻断"的强原子语义。
#   - HAS_DOCKER=0（只跑 upk 不跑 docker）：build-upk.mjs 自己开 --pull 拉远端镜像。
UPK_BUILD_NO="1"                # --upk-build
UPK_IMAGE_REF=""                # --upk-image，默认 ${FPK_DOCKERHUB_REPO}:v${VERSION}

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
      --target TARGETS     逗号分隔：docker / pc / android / fpk / upk / lite / clipper / all
                           默认 docker；示例：--target pc,android,fpk,upk,lite,clipper
                           - lite     : 调 scripts/build-lite.mjs 出 "无后端" 的 PC 安装包
                           - clipper  : 调 packages/nowen-clipper 出浏览器扩展 zip
                           - upk      : 调 scripts/upk/build-upk.mjs 出绿联 NAS .upk 安装包
      --fpk-dockerhub-repo USER/REPO
                           飞牛 .fpk 引用的 dockerhub 镜像（默认取 cropflre/nowen-note）
      --upk-image REPO:TAG
                           绿联 .upk 要打进包的镜像名（默认 同 fpk-dockerhub-repo : v版本号）
      --upk-build N        绿联 .upk 的构建号（默认 1，会拼成 X.Y.Z.N 写入包名）      --pc-platform LIST   PC 端要打的平台，逗号分隔：win / linux / mac
                           默认：Linux 宿主 => win,linux；macOS => mac,linux；Windows => win
                           在 Debian 上打 Windows exe 需要 wine64 + mono（首次 apt install 一次）
      --mac-arch LIST      mac 要打的 CPU 架构，逗号分隔：x64 / arm64（默认 x64）
                           x64 包 Apple Silicon 也可走 Rosetta 跑；想出原生 arm64 包传 arm64 或 x64,arm64
                           （注意：同时打两架构时 latest-mac.yml 仅最后一次构建的架构能走自动更新）
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
                           注意：当 --target 包含 pc 或 android 时会自动启用，无需手动加
      --no-github-release  显式关闭 GitHub Release 上传（覆盖自动推断）
      --notes "TEXT"       Release 发布说明（简短文本）
      --notes-file PATH    Release 发布说明（从文件读，优先级高于 --notes）
      --draft              Release 作为草稿（可在网页上再发布）
      --prerelease         标记为 Pre-release（版本号带 -rc / -alpha 等后缀会自动置位）
      --atomic             原子发布：三端全部构建成功后，再统一执行 docker push / git tag / GitHub Release
                           （多端组合或"一键全量发布"时默认开启）
      --no-atomic          关闭原子发布：保持旧行为（边构建边推送）

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
        --target)       TARGETS="${2:-}"; TARGETS_EXPLICIT=1; shift 2 ;;
        --pc-platform)  PC_PLATFORMS="${2:-}"; shift 2 ;;
        --mac-arch)     MAC_ARCHES="${2:-}"; shift 2 ;;
        --android-docker) ANDROID_USE_DOCKER=1; shift ;;
        --android-docker-image) ANDROID_DOCKER_IMAGE="${2:-}"; shift 2 ;;
        --android-docker-sync) ANDROID_DOCKER_SYNC=1; ANDROID_USE_DOCKER=1; shift ;;
        --restore-backend-abi) RESTORE_BACKEND_ABI=1; shift ;;
        --github-release) DO_GITHUB_RELEASE=1; shift ;;
        --no-github-release) DO_GITHUB_RELEASE=0; NO_GITHUB_RELEASE_EXPLICIT=1; shift ;;
        --notes)        RELEASE_NOTES="${2:-}"; shift 2 ;;
        --notes-file)   RELEASE_NOTES_FILE="${2:-}"; shift 2 ;;
        --draft)        RELEASE_DRAFT=1; shift ;;
        --prerelease)   RELEASE_PRERELEASE=1; shift ;;
        --atomic)       ATOMIC_RELEASE=1; ATOMIC_RELEASE_EXPLICIT=1; shift ;;
        --no-atomic)    ATOMIC_RELEASE=0; ATOMIC_RELEASE_EXPLICIT=1; shift ;;
        --fpk-dockerhub-repo) FPK_DOCKERHUB_REPO="${2:-}"; shift 2 ;;
        --upk-image)         UPK_IMAGE_REF="${2:-}"; shift 2 ;;
        --upk-build)         UPK_BUILD_NO="${2:-}"; shift 2 ;;
        -h|--help)      usage ;;
        *)              die "未知参数: $1（使用 -h 查看帮助）" ;;
    esac
done

# -------------------- 交互式向导（完整覆盖所有选项） --------------------
# 当用户直接 ./release.sh（不带任何参数）且不是 -y 自动模式时，启动交互式向导，
# 让用户通过菜单选择所有配置，无需记命令行参数。
if [ "$TARGETS_EXPLICIT" = "0" ] && [ "$BUILD_ONLY" = "0" ] && [ "$ASSUME_YES" = "0" ]; then
    echo
    echo "${C_BOLD}${C_CYAN}╔════════════════════════════════════════╗${C_RESET}"
    echo "${C_BOLD}${C_CYAN}║     Nowen Note 发布向导               ║${C_RESET}"
    echo "${C_BOLD}${C_CYAN}╚════════════════════════════════════════╝${C_RESET}"

    # ======== 第 1 步：选择发布目标 ========
    echo
    echo "${C_BOLD}📦 第 1 步：选择发布目标${C_RESET}"
    echo
    echo "  ${C_CYAN}1${C_RESET})  Docker 镜像               仅发布 Docker Hub 镜像"
    echo "  ${C_CYAN}2${C_RESET})  PC 客户端                 打包 exe / AppImage / deb / dmg"
    echo "  ${C_CYAN}3${C_RESET})  Android APK               打包 Android 安装包"
    echo "  ${C_CYAN}4${C_RESET})  PC + Android              同时打 PC 和 Android"
    echo "  ${C_BOLD}${C_GREEN}5${C_RESET})  ${C_BOLD}🚀 一键全量发布${C_RESET}          git tag + Docker(amd64+arm64) + exe + APK + .fpk + lite + clipper + GitHub Releases（不含 .upk，单独走选项 10）"
    echo "  ${C_CYAN}6${C_RESET})  自定义组合                手动输入 docker,pc,android,fpk,upk,lite,clipper 组合"
    echo "  ${C_CYAN}7${C_RESET})  飞牛 .fpk                 仅打包飞牛 NAS 安装包（要求镜像已发到 Docker Hub）"
    echo "  ${C_CYAN}8${C_RESET})  Lite 版（无后端）          仅打 PC 端 lite 安装包（builder.lite.config.js）"
    echo "  ${C_CYAN}9${C_RESET})  浏览器扩展 (clipper)        仅打 nowen-clipper 浏览器扩展 zip"
    echo "  ${C_CYAN}10${C_RESET}) 绿联 .upk                 仅打包绿联 NAS 安装包（镜像 tar 打进包，本机需 docker）"
    echo
    read -r -p "请输入序号 [1-10]（默认 1）: " _mode_choice
    _mode_choice="${_mode_choice:-1}"

    # _ONE_SHOT=1 表示"一键全量发布"模式：后续 Docker 架构 / PC 平台 / Android 方式 /
    # GitHub Release / 其他选项 全部跳过交互，采用最合理的默认值，实现真正"一次性全发"。
    _ONE_SHOT=0

    case "$_mode_choice" in
        1) TARGETS="docker" ;;
        2) TARGETS="pc" ;;
        3) TARGETS="android" ;;
        4) TARGETS="pc,android" ;;
        5)
            # 注意：一键全量"不含"绿联 .upk —— upk 依赖 ugcli check，
            # 经常因为 ugcli/绿联模板自身原因卡住主流程，故独立到选项 10。
            TARGETS="docker,pc,android,fpk,lite,clipper"
            _ONE_SHOT=1
            # ---- 一键全量：Docker 多架构 ----
            ARCH="multi"
            # ---- 一键全量：PC 平台按宿主自动推断 ----
            if [ -z "$PC_PLATFORMS" ]; then
                _UNAME_ONESHOT="$(uname -s 2>/dev/null || echo unknown)"
                case "$_UNAME_ONESHOT" in
                    Linux)  PC_PLATFORMS="win,linux" ;;
                    Darwin) PC_PLATFORMS="mac,linux" ;;
                    *)      PC_PLATFORMS="win" ;;
                esac
            fi
            # ---- 一键全量：Android 按本机 SDK 是否可用自动选 ----
            if { [ -n "${JAVA_HOME:-}" ] || command -v javac >/dev/null 2>&1; } \
               && { [ -n "${ANDROID_HOME:-}" ] || [ -n "${ANDROID_SDK_ROOT:-}" ]; }; then
                ANDROID_USE_DOCKER=0
            elif command -v docker >/dev/null 2>&1; then
                ANDROID_USE_DOCKER=1
                ANDROID_DOCKER_SYNC=0
            else
                ANDROID_USE_DOCKER=0
                warn "一键模式：未检测到 JDK/Android SDK 也未检测到 Docker，Android 构建很可能失败"
            fi
            # ---- 一键全量：必然打 git tag + 推 GitHub Release + git pull ----
            DO_GIT_TAG=1
            DO_GITHUB_RELEASE=1
            NO_GITHUB_RELEASE_EXPLICIT=0
            DO_PULL=1
            DO_LATEST=1
            # ---- 一键全量：必然启用原子发布（构建全部成功才推送）----
            ATOMIC_RELEASE=1
            ATOMIC_RELEASE_EXPLICIT=1
            # ABI 恢复保持默认（0），一键模式不做（打包完一般也不需要立刻 dev:backend）
            echo
            info "🚀 已进入 ${C_BOLD}${C_GREEN}一键全量发布${C_RESET} 模式："
            info "   - Docker 架构: ${C_GREEN}multi (amd64+arm64)${C_RESET}"
            info "   - PC 平台:     ${C_GREEN}${PC_PLATFORMS}${C_RESET}"
            if [ "$ANDROID_USE_DOCKER" = "1" ]; then
                info "   - Android:     ${C_GREEN}Docker 构建${C_RESET}"
            else
                info "   - Android:     ${C_GREEN}本机 gradlew${C_RESET}"
            fi
            info "   - git tag:     ${C_GREEN}是${C_RESET}"
            info "   - GitHub 发布: ${C_GREEN}是${C_RESET}"
            info "   - git pull:    ${C_GREEN}是${C_RESET}"
info "   - 飞牛 .fpk:   ${C_GREEN}是${C_RESET}（在 Docker push 后构建）"
            info "   - 绿联 .upk:   ${C_YELLOW}否${C_RESET}（独立选项 10，避免 ugcli 问题阻断主流程）"
            info "   - Lite 版:     ${C_GREEN}是${C_RESET}（无后端 PC 安装包）"
            info "   - 浏览器扩展:  ${C_GREEN}是${C_RESET}（nowen-clipper zip）"
            info "   - 原子发布:    ${C_GREEN}是${C_RESET}（三端全部构建成功才推送）"
            ;;
        6)
            echo
            echo "  可选值：${C_GREEN}docker${C_RESET}, ${C_GREEN}pc${C_RESET}, ${C_GREEN}android${C_RESET}, ${C_GREEN}fpk${C_RESET}, ${C_GREEN}upk${C_RESET}, ${C_GREEN}lite${C_RESET}, ${C_GREEN}clipper${C_RESET}（逗号分隔）"
            read -r -p "  请输入组合: " _custom_targets
            [ -z "$_custom_targets" ] && die "未输入任何目标"
            TARGETS="$_custom_targets"
            ;;
        7) TARGETS="fpk" ;;
        8) TARGETS="lite" ;;
        9) TARGETS="clipper" ;;
        10)
            # 选项 10：单独补一个 .upk，挂到已存在的 GitHub Release 上。
            # 语义：不打新 tag、不升版本号、复用远端最新版本。
            TARGETS="upk"
            _UPK_ONLY_MODE=1
            DO_GIT_TAG=0
            DO_GITHUB_RELEASE=1
            NO_GITHUB_RELEASE_EXPLICIT=1   # 护住 不被 631 行的自动推断洗掉
            ;;
        *) die "无效选择: $_mode_choice" ;;
    esac
    [ "$_ONE_SHOT" = "0" ] && info "已选择发布目标: ${C_GREEN}${TARGETS}${C_RESET}"

    # 提前解析一下 TARGETS，以便后续步骤做条件判断
    _W_HAS_DOCKER=0; _W_HAS_PC=0; _W_HAS_ANDROID=0; _W_HAS_FPK=0; _W_HAS_UPK=0; _W_HAS_LITE=0; _W_HAS_CLIPPER=0
    for _wt in $(echo "$TARGETS" | tr ',' ' '); do
        case "$_wt" in
            docker)  _W_HAS_DOCKER=1 ;;
            pc)      _W_HAS_PC=1 ;;
            android) _W_HAS_ANDROID=1 ;;
            fpk)     _W_HAS_FPK=1 ;;
            upk)     _W_HAS_UPK=1 ;;
            lite)    _W_HAS_LITE=1 ;;
            clipper) _W_HAS_CLIPPER=1 ;;
        esac
    done

    # ======== 第 2 步：Docker 架构（仅当目标包含 docker 时） ========
    if [ "$_ONE_SHOT" = "0" ] && [ "$_W_HAS_DOCKER" = "1" ]; then
        echo
        echo "${C_BOLD}🏗️  第 2 步：Docker 构建架构${C_RESET}"
        echo
        echo "  ${C_CYAN}1${C_RESET})  amd64     x86 服务器/NAS（最快，默认）"
        echo "  ${C_CYAN}2${C_RESET})  arm64     ARM64 板子（A311D/RK3566 等，需 QEMU）"
        echo "  ${C_CYAN}3${C_RESET})  multi     同时打 amd64 + arm64 多架构（直接 push）"
        echo
        read -r -p "请选择 [1-3]（默认 1）: " _arch_choice
        _arch_choice="${_arch_choice:-1}"
        case "$_arch_choice" in
            1) ARCH="amd64" ;;
            2) ARCH="arm64" ;;
            3) ARCH="multi" ;;
            *) die "无效选择: $_arch_choice" ;;
        esac
        info "Docker 架构: ${C_GREEN}${ARCH}${C_RESET}"
    fi

    # ======== 第 3 步：PC 平台选择（仅当目标包含 pc 时） ========
    if [ "$_ONE_SHOT" = "0" ] && [ "$_W_HAS_PC" = "1" ] && [ -z "$PC_PLATFORMS" ]; then
        echo
        echo "${C_BOLD}💻 第 3 步：PC 端要打的平台${C_RESET}"
        echo
        _UNAME_W="$(uname -s 2>/dev/null || echo unknown)"
        case "$_UNAME_W" in
            Linux)  _default_plat="win,linux" ;;
            Darwin) _default_plat="mac,linux" ;;
            *)      _default_plat="win" ;;
        esac
        echo "  ${C_CYAN}1${C_RESET})  ${_default_plat}       自动推荐（基于当前系统: ${_UNAME_W}）"
        echo "  ${C_CYAN}2${C_RESET})  win                 仅 Windows（exe + portable）"
        echo "  ${C_CYAN}3${C_RESET})  linux               仅 Linux（AppImage + deb）"
        echo "  ${C_CYAN}4${C_RESET})  win,linux           Windows + Linux"
        echo "  ${C_CYAN}5${C_RESET})  mac                 仅 macOS（需在 macOS 上运行）"
        echo "  ${C_CYAN}6${C_RESET})  自定义              手动输入 win,linux,mac 组合"
        echo
        read -r -p "请选择 [1-6]（默认 1）: " _plat_choice
        _plat_choice="${_plat_choice:-1}"
        case "$_plat_choice" in
            1) PC_PLATFORMS="$_default_plat" ;;
            2) PC_PLATFORMS="win" ;;
            3) PC_PLATFORMS="linux" ;;
            4) PC_PLATFORMS="win,linux" ;;
            5) PC_PLATFORMS="mac" ;;
            6)
                read -r -p "  请输入平台组合（win,linux,mac）: " _custom_plat
                [ -z "$_custom_plat" ] && die "未输入任何平台"
                PC_PLATFORMS="$_custom_plat"
                ;;
            *) die "无效选择: $_plat_choice" ;;
        esac
        info "PC 平台: ${C_GREEN}${PC_PLATFORMS}${C_RESET}"
    fi

    # ======== 第 4 步：Android 构建方式（仅当目标包含 android 时） ========
    if [ "$_ONE_SHOT" = "0" ] && [ "$_W_HAS_ANDROID" = "1" ]; then
        echo
        echo "${C_BOLD}📱 第 4 步：Android 构建方式${C_RESET}"
        echo
        # 探测本机是否有 JDK / Android SDK
        _has_local_android=0
        if { [ -n "${JAVA_HOME:-}" ] || command -v javac >/dev/null 2>&1; } \
           && { [ -n "${ANDROID_HOME:-}" ] || [ -n "${ANDROID_SDK_ROOT:-}" ]; }; then
            _has_local_android=1
        fi
        if [ "$_has_local_android" = "1" ]; then
            echo "  ${C_CYAN}1${C_RESET})  本机 gradlew       使用本机 JDK + Android SDK（已检测到）"
            echo "  ${C_CYAN}2${C_RESET})  Docker 构建         使用 Docker 镜像跑 gradle（无需本机装 SDK）"
            echo
            read -r -p "请选择 [1-2]（默认 1）: " _android_choice
            _android_choice="${_android_choice:-1}"
        else
            if command -v docker >/dev/null 2>&1; then
                echo "  ${C_YELLOW}未检测到本机 JDK / Android SDK${C_RESET}"
                echo
                echo "  ${C_CYAN}1${C_RESET})  Docker 构建         使用 Docker 镜像（推荐，无需装 SDK）"
                echo "  ${C_CYAN}2${C_RESET})  本机 gradlew       强制用本机（需先手动安装 JDK + SDK）"
                echo
                read -r -p "请选择 [1-2]（默认 1）: " _android_choice
                _android_choice="${_android_choice:-1}"
                # 映射选项（无本机 SDK 时默认选项为 docker）
                case "$_android_choice" in
                    1) _android_choice=2 ;;
                    2) _android_choice=1 ;;
                esac
            else
                echo "  ${C_YELLOW}未检测到 JDK/SDK 且未安装 Docker${C_RESET}"
                echo "  将使用本机 gradlew，请确保已安装 JDK + Android SDK"
                _android_choice=1
            fi
        fi
        case "$_android_choice" in
            1) ANDROID_USE_DOCKER=0; info "Android 构建: ${C_GREEN}本机 gradlew${C_RESET}" ;;
            2)
                ANDROID_USE_DOCKER=1
                echo
                echo "  是否把 frontend build + cap sync 也放进 Docker？"
                echo "  （宿主连 node 都不装也能打 APK，但首次会多下载依赖）"
                read -r -p "  [y/N]（默认 N）: " _sync_choice
                case "$_sync_choice" in
                    [yY]|[yY][eE][sS]) ANDROID_DOCKER_SYNC=1; info "Android 构建: ${C_GREEN}Docker（含前端 sync）${C_RESET}" ;;
                    *) ANDROID_DOCKER_SYNC=0; info "Android 构建: ${C_GREEN}Docker（仅 gradle）${C_RESET}" ;;
                esac
                ;;
            *) die "无效选择: $_android_choice" ;;
        esac
    fi

    # ======== 第 5 步：GitHub Release ========
    # _UPK_ONLY_MODE=1 （选项 10）跳过询问，默认上传到已有 Release。
    if [ "$_ONE_SHOT" = "0" ] && [ "${_UPK_ONLY_MODE:-0}" = "0" ] && { [ "$_W_HAS_PC" = "1" ] || [ "$_W_HAS_ANDROID" = "1" ] || [ "$_W_HAS_FPK" = "1" ] || [ "$_W_HAS_UPK" = "1" ] || [ "$_W_HAS_LITE" = "1" ] || [ "$_W_HAS_CLIPPER" = "1" ]; }; then
        echo
        echo "${C_BOLD}🚀 第 5 步：是否上传产物到 GitHub Releases？${C_RESET}"
        echo
        echo "  ${C_CYAN}1${C_RESET})  是（推荐）    PC/Android 安装包上传到 GitHub，用户可直接下载"
        echo "  ${C_CYAN}2${C_RESET})  否            只打包到本地，不上传"
        echo
        read -r -p "请选择 [1-2]（默认 1）: " _gh_choice
        _gh_choice="${_gh_choice:-1}"
        case "$_gh_choice" in
            1) DO_GITHUB_RELEASE=1; NO_GITHUB_RELEASE_EXPLICIT=0; info "GitHub Release: ${C_GREEN}是${C_RESET}" ;;
            2) DO_GITHUB_RELEASE=0; NO_GITHUB_RELEASE_EXPLICIT=1; info "GitHub Release: ${C_GREEN}否${C_RESET}" ;;
            *) die "无效选择: $_gh_choice" ;;
        esac

        # Release 说明（仅当选了上传时）
        if [ "$DO_GITHUB_RELEASE" = "1" ] && [ -z "$RELEASE_NOTES" ] && [ -z "$RELEASE_NOTES_FILE" ]; then
            echo
            read -r -p "  Release 说明（直接回车跳过，将自动生成）: " _notes_input
            [ -n "$_notes_input" ] && RELEASE_NOTES="$_notes_input"
        fi
    fi

    # ======== 第 6 步：其他选项 ========
    if [ "$_ONE_SHOT" = "0" ]; then
        echo
        echo "${C_BOLD}⚙️  第 6 步：其他选项${C_RESET}"
        echo

        # 是否 git pull
        echo "  是否先 git pull 拉取最新代码？"
        read -r -p "  [Y/n]（默认 Y）: " _pull_choice
        case "$_pull_choice" in
            [nN]|[nN][oO]) DO_PULL=0; info "Git pull: ${C_GREEN}跳过${C_RESET}" ;;
            *) DO_PULL=1; info "Git pull: ${C_GREEN}是${C_RESET}" ;;
        esac

        # PC 端打完后是否恢复 backend ABI
        if [ "$_W_HAS_PC" = "1" ]; then
            echo
            echo "  PC 打包后是否自动恢复 backend better-sqlite3 到 Node ABI？"
            echo "  （方便打包后继续 npm run dev:backend）"
            read -r -p "  [y/N]（默认 N）: " _abi_choice
            case "$_abi_choice" in
                [yY]|[yY][eE][sS]) RESTORE_BACKEND_ABI=1; info "恢复 ABI: ${C_GREEN}是${C_RESET}" ;;
                *) RESTORE_BACKEND_ABI=0 ;;
            esac
        fi
    else
        # 一键全量发布：仍给一次输 release notes 的机会（可选，回车跳过自动生成）
        if [ -z "$RELEASE_NOTES" ] && [ -z "$RELEASE_NOTES_FILE" ]; then
            echo
            echo "${C_BOLD}📝 Release 说明${C_RESET}（可选，直接回车则自动生成）"
            read -r -p "  请输入: " _notes_input
            [ -n "$_notes_input" ] && RELEASE_NOTES="$_notes_input"
        fi
    fi

    echo
    echo "${C_BOLD}${C_CYAN}────────────────────────────────────────${C_RESET}"
    echo "${C_BOLD}  向导配置完成，继续后将开始发布流程${C_RESET}"
    echo "${C_BOLD}${C_CYAN}────────────────────────────────────────${C_RESET}"
fi

# 展开 TARGETS
# - all -> docker,pc,android,fpk,upk,lite,clipper
# - 去重 / 校验
TARGETS="$(echo "$TARGETS" | tr ',' '\n' | awk 'NF{print}' | sort -u | tr '\n' ',' | sed 's/,$//')"
if echo ",$TARGETS," | grep -q ',all,'; then
    TARGETS="docker,pc,android,fpk,upk,lite,clipper"
fi
HAS_DOCKER=0; HAS_PC=0; HAS_ANDROID=0; HAS_FPK=0; HAS_UPK=0; HAS_LITE=0; HAS_CLIPPER=0
for t in $(echo "$TARGETS" | tr ',' ' '); do
    case "$t" in
        docker)  HAS_DOCKER=1 ;;
        pc)      HAS_PC=1 ;;
        android) HAS_ANDROID=1 ;;
        fpk)     HAS_FPK=1 ;;
        upk)     HAS_UPK=1 ;;
        lite)    HAS_LITE=1 ;;
        clipper) HAS_CLIPPER=1 ;;
        *)       die "--target 未知值: $t （合法: docker / pc / android / fpk / upk / lite / clipper / all）" ;;
    esac
done
[ "$HAS_DOCKER" = "0" ] && [ "$HAS_PC" = "0" ] && [ "$HAS_ANDROID" = "0" ] && [ "$HAS_FPK" = "0" ] \
    && [ "$HAS_UPK" = "0" ] && [ "$HAS_LITE" = "0" ] && [ "$HAS_CLIPPER" = "0" ] \
    && die "--target 至少包含一个目标"

# ===== 自动推断 --github-release =====
# 当 target 包含 pc/android/fpk/lite/clipper 时，自动启用 GitHub Release 上传
# 因为这些产物的主要分发渠道就是 GitHub Releases
# 若用户显式传了 --no-github-release 则跳过自动推断
if [ "$DO_GITHUB_RELEASE" = "0" ] && [ "$NO_GITHUB_RELEASE_EXPLICIT" = "0" ] \
   && { [ "$HAS_PC" = "1" ] || [ "$HAS_ANDROID" = "1" ] || [ "$HAS_FPK" = "1" ] || [ "$HAS_UPK" = "1" ] || [ "$HAS_LITE" = "1" ] || [ "$HAS_CLIPPER" = "1" ]; }; then
    info "检测到 target 包含 pc/android/fpk/upk/lite/clipper，自动启用 --github-release（可用 --no-github-release 关闭）"
    DO_GITHUB_RELEASE=1
fi

# ===== 自动推断 --atomic（原子发布） =====
# 多端组合（任意 ≥2 个 target）时自动开启：
# 先把所有构建完成，最后统一执行 docker push / git tag / GitHub Release，
# 避免"Docker 镜像已推送，但 PC/Android 构建失败"的半成品状态。
# 单目标时没有跨端一致性需求，保持关闭以免 multi 模式需要额外构建开销。
# 用户显式传了 --atomic / --no-atomic 时不再自动推断。
if [ "$ATOMIC_RELEASE" = "-1" ]; then
    _TARGET_COUNT=$((HAS_DOCKER + HAS_PC + HAS_ANDROID + HAS_FPK + HAS_UPK + HAS_LITE + HAS_CLIPPER))
    if [ "$_TARGET_COUNT" -ge 2 ]; then
        ATOMIC_RELEASE=1
        info "检测到多端组合（${TARGETS}），自动启用 ${C_GREEN}原子发布${C_RESET}（可用 --no-atomic 关闭）"
    else
        ATOMIC_RELEASE=0
    fi
fi

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
    if [ "$HAS_PC" = "1" ] || [ "$HAS_ANDROID" = "1" ] || [ "$HAS_FPK" = "1" ] || [ "$HAS_UPK" = "1" ] || [ "$HAS_LITE" = "1" ] || [ "$HAS_CLIPPER" = "1" ]; then
        die "--build-only 模式不支持 --target pc/android/fpk/upk/lite/clipper（仅限 docker）"
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

    # ---- 自动探测 JAVA_HOME（Capacitor Android 要求 JDK 21+）----
    if [ -z "${JAVA_HOME:-}" ]; then
        _detected_java_home=""
        # Linux: 尝试常见 JDK 21 路径
        for _jdir in \
            /usr/lib/jvm/java-21-openjdk-amd64 \
            /usr/lib/jvm/java-21-openjdk \
            /usr/lib/jvm/java-21 \
            /usr/lib/jvm/temurin-21-jdk-amd64 \
            /usr/lib/jvm/zulu-21-amd64 \
        ; do
            if [ -x "${_jdir}/bin/javac" ]; then
                _detected_java_home="$_jdir"; break
            fi
        done
        # macOS: 使用 java_home 工具
        if [ -z "$_detected_java_home" ] && command -v /usr/libexec/java_home >/dev/null 2>&1; then
            _detected_java_home="$(/usr/libexec/java_home -v 21 2>/dev/null || true)"
        fi
        # 通用 fallback: 从 javac 反推
        if [ -z "$_detected_java_home" ] && command -v javac >/dev/null 2>&1; then
            _javac_real="$(readlink -f "$(command -v javac)" 2>/dev/null || true)"
            if [ -n "$_javac_real" ]; then
                # /usr/lib/jvm/java-21-xxx/bin/javac -> /usr/lib/jvm/java-21-xxx
                _detected_java_home="$(dirname "$(dirname "$_javac_real")")"
            fi
        fi

        if [ -n "$_detected_java_home" ]; then
            export JAVA_HOME="$_detected_java_home"
            info "自动探测 JAVA_HOME=${JAVA_HOME}"
        fi
    fi

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
        # 一键全量发布（_ONE_SHOT=1）或原子发布模式下，未签名 APK 等于不可用产物
        # （Android 同包名不同签名 = 用户必须卸载老版才能装新版，等于发了个废包）
        # 直接 die，不让它走到 GitHub Release 给用户造成升级灾难
        if [ "${_ONE_SHOT:-0}" = "1" ] || [ "$ATOMIC_RELEASE" = "1" ]; then
            die "未找到 frontend/android/keystore.properties 且未设 NOWEN_ANDROID_KEYSTORE_B64：原子/一键全量发布要求签名 APK，请配置后重试（参考 docs/android-signing.md）"
        else
            warn "未找到 frontend/android/keystore.properties 且未设 NOWEN_ANDROID_KEYSTORE_B64，APK 将不会被签名（只能用于调试）"
        fi
    fi
    command -v node >/dev/null 2>&1 || die "未安装 node（Android 端打包需要先跑 vite build + cap sync）"
fi

# fpk target 前置检查
if [ "$HAS_FPK" = "1" ]; then
    [ -f "scripts/fpk/build-fpk.mjs" ] || die "未找到 scripts/fpk/build-fpk.mjs（飞牛 .fpk 打包脚本）"
    command -v node >/dev/null 2>&1 || die "未安装 node（fpk 打包脚本需要 node）"

    # fnpack 二进制：build-fpk.mjs 内部会找 fnpack-* / FNPACK_BIN
    # 原子/一键全量发布下，必须前置 die，否则等所有构建跑完才在最后失败，浪费时间
    if [ -z "${FNPACK_BIN:-}" ] && \
       ! ls "${REPO_ROOT:-.}"/fnpack-* >/dev/null 2>&1 && \
       ! command -v fnpack >/dev/null 2>&1; then
        if [ "${_ONE_SHOT:-0}" = "1" ] || [ "$ATOMIC_RELEASE" = "1" ]; then
            die "未找到 fnpack 二进制（原子/一键全量发布要求 fpk 必须能打包）

请放置 fnpack 可执行文件，三选一：
  1) 放到项目根目录：${REPO_ROOT:-.}/fnpack 或 fnpack-<版本>-<os>-<arch>
  2) 放到 PATH：sudo cp fnpack /usr/local/bin/ && sudo chmod +x /usr/local/bin/fnpack
  3) 通过环境变量指定：export FNPACK_BIN=/path/to/fnpack

Linux 版下载（飞牛官方）：https://www.fnnas.com/  → 开发者工具 → fnpack
你当前仓库里只有 Windows 版（fnpack-1.2.1-windows-amd64），跑 Linux 打包用不了"
        fi
        warn "未找到 fnpack 二进制（项目根目录的 fnpack-* / PATH 中的 fnpack / 环境变量 FNPACK_BIN）"
        warn "fpk 打包阶段会失败，请先放置 fnpack 可执行文件"
    fi

    # dockerhub 镜像名：优先用 --fpk-dockerhub-repo，再环境变量，再默认 IMAGE_NAME
    if [ -z "$FPK_DOCKERHUB_REPO" ]; then
        FPK_DOCKERHUB_REPO="${DOCKERHUB_REPO:-}"
    fi
    if [ -z "$FPK_DOCKERHUB_REPO" ]; then
        FPK_DOCKERHUB_REPO="$DEFAULT_IMAGE_NAME"
    fi
    info "fpk 镜像地址: ${C_GREEN}${FPK_DOCKERHUB_REPO}${C_RESET}"
fi

# upk target 前置检查
# 与 fpk 不同：upk 必须把镜像 tar 打进包里，所以要求本机有 docker，
# 且要么本地已有目标镜像（buildx --load 产出），要么允许 docker pull 远端拉。
if [ "$HAS_UPK" = "1" ]; then
    [ -f "scripts/upk/build-upk.mjs" ] || die "未找到 scripts/upk/build-upk.mjs（绿联 .upk 打包脚本）"
    command -v node >/dev/null 2>&1   || die "未安装 node（upk 打包脚本需要 node）"
    command -v docker >/dev/null 2>&1 || die "未安装 docker（upk 必须 docker save 镜像 tar 进包）"
    docker info >/dev/null 2>&1       || die "docker daemon 不可用（请启动 docker）"

    # ugcli 二进制：build-upk.mjs 内部会找 ugcli / ugcli.exe / UGCLI_BIN
    if [ -z "${UGCLI_BIN:-}" ] && \
       [ ! -x "${REPO_ROOT:-.}/ugcli" ] && \
       [ ! -f "${REPO_ROOT:-.}/ugcli.exe" ] && \
       ! command -v ugcli >/dev/null 2>&1; then
        if [ "${_ONE_SHOT:-0}" = "1" ] || [ "$ATOMIC_RELEASE" = "1" ]; then
            die "未找到 ugcli 二进制（原子/一键全量发布要求 upk 必须能打包）

请放置 ugcli 可执行文件，三选一：
  1) 放到项目根目录：${REPO_ROOT:-.}/ugcli（Linux）或 ugcli.exe（Windows）
  2) 放到 PATH：sudo cp ugcli /usr/local/bin/ && sudo chmod +x /usr/local/bin/ugcli
  3) 通过环境变量指定：export UGCLI_BIN=/path/to/ugcli

下载地址（绿联开发者）：https://developer.ugnas.com → 开发者工具 → ugcli"
        fi
        warn "未找到 ugcli 二进制（项目根目录的 ugcli / PATH 中的 ugcli / 环境变量 UGCLI_BIN）"
        warn "upk 打包阶段会失败，请先放置 ugcli 可执行文件"
    fi

    # 注意：UPK_IMAGE_REF 的默认值依赖 ${VERSION}，但此时 VERSION 还可能为空
    # （交互/--yes 模式下要等到后面 "询问/采用建议版本号" 那一段才赋值）。
    # 因此这里只校验工具链，真正的镜像 ref 拼接放到 VERSION 确认之后再做。
fi

# Lite 版完全复用 PC 端的 electron-builder 链路，但走 builder.lite.config.js，
# 不打 backend，因此无需 wine + better-sqlite3 等 PC target 的重型依赖。
if [ "$HAS_LITE" = "1" ]; then
    [ -f "scripts/build-lite.mjs" ]                  || die "未找到 scripts/build-lite.mjs（lite 打包脚本）"
    [ -f "electron/builder.lite.config.js" ]         || die "未找到 electron/builder.lite.config.js"
    command -v node >/dev/null 2>&1                  || die "未安装 node（lite 打包需要）"
fi

# clipper target 前置检查
# 浏览器扩展打包独立于主仓库的 npm workspace，需要 packages/nowen-clipper 自身
# 装好依赖（首跑会自动 npm install）。
if [ "$HAS_CLIPPER" = "1" ]; then
    [ -d "packages/nowen-clipper" ]                  || die "未找到 packages/nowen-clipper 目录"
    [ -f "packages/nowen-clipper/package.json" ]     || die "未找到 packages/nowen-clipper/package.json"
    [ -f "packages/nowen-clipper/scripts/pack.mjs" ] || die "未找到 packages/nowen-clipper/scripts/pack.mjs"
    command -v node >/dev/null 2>&1                  || die "未安装 node（clipper 打包需要）"
    command -v npm  >/dev/null 2>&1                  || die "未安装 npm（clipper 打包需要）"
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

    # 工作区脏检查：自动丢弃所有未提交 / 未暂存的改动
    if ! git diff-index --quiet HEAD -- || ! git diff --cached --quiet; then
        warn "工作区有未提交的改动，自动清理中..."
        git status --short | head -20
        git checkout -- .
        git clean -fd
        git reset HEAD -- . >/dev/null 2>&1 || true
        ok "工作区已自动恢复干净"
    fi

    # -------------------- git pull（智能同步）--------------------
    # 不再用裸 git pull --ff-only：在多机协作（开发机 + NAS）场景下
    # 经常出现 diverged，硬 ff 会直接 fatal 退出。
    # 这里改为先 fetch 再判断 ahead/behind：
    #   - 同步         : 跳过
    #   - 落后         : ff-merge 拉取
    #   - 领先         : 提示，跳过（push 阶段会一起推）
    #   - diverged    : 交互问 rebase / merge / abort；-y 时默认 rebase
    if [ "$DO_PULL" = "1" ]; then
        info "git fetch origin $CURRENT_BRANCH ..."
        run "git fetch origin \"$CURRENT_BRANCH\""

        _LR="$(git rev-list --left-right --count "HEAD...origin/$CURRENT_BRANCH" 2>/dev/null || echo "0	0")"
        _AHEAD="$(echo "$_LR" | awk '{print $1}')"
        _BEHIND="$(echo "$_LR" | awk '{print $2}')"
        info "本地相对 origin/$CURRENT_BRANCH：ahead=${_AHEAD}, behind=${_BEHIND}"

        if [ "$_AHEAD" = "0" ] && [ "$_BEHIND" = "0" ]; then
            ok "代码已是最新：$(git log -1 --pretty=format:'%h  %s')"
        elif [ "$_AHEAD" = "0" ] && [ "$_BEHIND" != "0" ]; then
            info "本地落后 ${_BEHIND} 个 commit，执行 fast-forward ..."
            run "git merge --ff-only \"origin/$CURRENT_BRANCH\""
            ok "已快进到：$(git log -1 --pretty=format:'%h  %s')"
        elif [ "$_AHEAD" != "0" ] && [ "$_BEHIND" = "0" ]; then
            warn "本地领先 ${_AHEAD} 个 commit，远端无新提交"
            info "跳过 pull；这些本地 commit 会在发布完成时一并推送"
        else
            warn "本地与远端 diverged：本地领先 ${_AHEAD}，远端领先 ${_BEHIND}"
            echo "  本地独有 commit："
            git --no-pager log --oneline "origin/$CURRENT_BRANCH..HEAD" | head -10 | sed 's/^/    /'
            echo "  远端独有 commit："
            git --no-pager log --oneline "HEAD..origin/$CURRENT_BRANCH" | head -10 | sed 's/^/    /'

            _MERGE_CHOICE=""
            if [ "$ASSUME_YES" = "1" ]; then
                _MERGE_CHOICE="rebase"
                info "非交互模式（-y）→ 默认采用 ${C_GREEN}rebase${C_RESET} 策略"
            else
                echo
                echo "  请选择处理方式："
                echo "    ${C_CYAN}1${C_RESET}) rebase  把本地 commit 重放到远端最新（推荐，历史最干净）"
                echo "    ${C_CYAN}2${C_RESET}) merge   生成一个 merge commit"
                echo "    ${C_CYAN}3${C_RESET}) abort   终止，留给你手动处理"
                read -r -p "  请输入 [1-3]（默认 1）: " _mc
                _mc="${_mc:-1}"
                case "$_mc" in
                    1) _MERGE_CHOICE="rebase" ;;
                    2) _MERGE_CHOICE="merge" ;;
                    3) die "用户选择 abort，已取消发布" ;;
                    *) die "无效选择: $_mc" ;;
                esac
            fi

            if [ "$_MERGE_CHOICE" = "rebase" ]; then
                info "git rebase origin/$CURRENT_BRANCH ..."
                if ! git rebase "origin/$CURRENT_BRANCH"; then
                    git rebase --abort >/dev/null 2>&1 || true
                    die "rebase 出现冲突，已自动 abort。请手动 'git rebase origin/$CURRENT_BRANCH' 解决冲突后重跑。"
                fi
            else
                info "git merge --no-ff origin/$CURRENT_BRANCH ..."
                if ! git merge --no-ff --no-edit "origin/$CURRENT_BRANCH"; then
                    git merge --abort >/dev/null 2>&1 || true
                    die "merge 出现冲突，已自动 abort。请手动解决后重跑。"
                fi
            fi
            ok "同步完成：$(git log -1 --pretty=format:'%h  %s')"
        fi
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
        latest="$(echo "$all" | { grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' || true; } | sort -V | tail -1)"
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
    _LOCAL_MAX="$(collect_local_tags    | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1 || true)"
    _GH_MAX="$(   collect_github_tags   | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1 || true)"
    _DH_MAX="$(   collect_dockerhub_tags| grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1 || true)"
    info "  本地 tag 最新 : ${_LOCAL_MAX:-(无)}"
    info "  GitHub 最新   : ${_GH_MAX:-(无/不可达)}"
    info "  Docker Hub 最新: ${_DH_MAX:-(无/不可达)}"
    info "  建议下一版本   : ${C_GREEN}${SUGGEST}${C_RESET}"

    # 选项 10（补 upk）：复用 GitHub 最新版本号，不升版本不打新 tag。
    # 这里把"建议值"切换成 GitHub 最新版本，让回车直接复用。
    if [ "${_UPK_ONLY_MODE:-0}" = "1" ]; then
        if [ -n "$_GH_MAX" ]; then
            SUGGEST="$_GH_MAX"
            info "  ${C_GREEN}补 upk 模式${C_RESET}：将复用 GitHub 最新版本 ${C_GREEN}${_GH_MAX}${C_RESET}（不打新 tag、不升版本）"
        else
            die "补 upk 模式需要 GitHub 上已有版本，但当前查不到任何 release tag"
        fi
    fi

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

# -------------------- UPK 镜像 ref 兜底拼接（依赖 VERSION，必须放到这之后） --------------------
# 这里拼接 UPK_IMAGE_REF 的默认值：与 fpk 同 repo + v 前缀版本号，与 release.sh
# 推送的 docker tag 对齐。命令行 --upk-image / 环境变量 UPK_IMAGE_REF 已显式传值时
# 不覆盖。之所以放到 VERSION 确认之后，是因为前置检查阶段 VERSION 还可能为空，
# 早拼会得到 "repo:v" 这种残缺 tag，被 build-upk.mjs 的 isBrokenRef 拒绝。
if [ "$HAS_UPK" = "1" ]; then
    if [ -z "$UPK_IMAGE_REF" ]; then
        if [ -z "$FPK_DOCKERHUB_REPO" ]; then
            FPK_DOCKERHUB_REPO="${DOCKERHUB_REPO:-$DEFAULT_IMAGE_NAME}"
        fi
        UPK_IMAGE_REF="${FPK_DOCKERHUB_REPO}:v${VERSION}"
    fi
    info "upk 镜像地址: ${C_GREEN}${UPK_IMAGE_REF}${C_RESET}（构建号: ${UPK_BUILD_NO}）"
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

# -------------------- 同步 backend/package.json 的 version --------------------
# 动机：后端 /api/version 的 resolveAppVersion() 在以下场景会读到 backend/package.json：
#   1) Docker 镜像里 /app/ 不含根 package.json，且 release.sh 没传 --build-arg APP_VERSION
#      （历史构建模式 / 第三方人手 docker build）
#   2) electron 打包后 backend bundle 在某些路径下 __dirname 指向 backend/
# 一旦 backend/package.json 长期停在 1.0.0，前端关于页就会显示一个永远对不上的服务端版本号。
# 这里跟根 package.json 同步 bump，作为镜像内的"真实兜底"。仅改 version 字段，依赖列表不动。
# 注意：和 sync_root_pkg_version 一样只在"发布模式"执行（构建模式不该污染源码）。
sync_backend_pkg_version() {
    local target_version="$1"
    local pkg_file
    pkg_file="${REPO_ROOT:-.}/backend/package.json"
    [ -f "$pkg_file" ] || pkg_file="backend/package.json"
    [ -f "$pkg_file" ] || return 0

    local current
    current="$(grep -oE '"version"\s*:\s*"[^"]+"' "$pkg_file" | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
    if [ "$current" = "$target_version" ]; then
        info "backend/package.json version 已是 ${target_version}，无需改写"
        return 0
    fi

    info "更新 backend/package.json version: ${current:-(空)} -> ${target_version}"
    if sed --version >/dev/null 2>&1; then
        sed -i -E "0,/\"version\"\s*:\s*\"[^\"]+\"/s//\"version\": \"${target_version}\"/" "$pkg_file"
    else
        sed -i '' -E "1,/\"version\"[[:space:]]*:[[:space:]]*\"[^\"]+\"/s//\"version\": \"${target_version}\"/" "$pkg_file"
    fi
}

if [ "$BUILD_ONLY" != "1" ]; then
    sync_backend_pkg_version "$VERSION"
fi

# -------------------- 生成 CHANGELOG / README 区块 / public/changelog.json --------------------
# 解析自上一个 v* tag 至 HEAD 之间的 conventional commits（feat/fix/docs/...），
# 按分组写入：
#   1) CHANGELOG.md       —— 单一真相源
#   2) README.md / README.en.md 内的 <!-- CHANGELOG:BEGIN/END --> 区块
#   3) frontend/public/changelog.json  —— 应用内「更新日志」Modal 的数据源
# 仅在非 build-only 流程里跑；不影响 docker build 单跑场景。
GEN_CHANGELOG_SCRIPT="${REPO_ROOT}/scripts/generate-changelog.mjs"
if [ "$BUILD_ONLY" != "1" ] && [ -f "$GEN_CHANGELOG_SCRIPT" ]; then
    info "生成 CHANGELOG / README 区块 / public/changelog.json"
    # 显式传 --since <上一个 v* tag>，避免 generate-changelog.mjs 在 HEAD 已等同于某个
    # v* tag（重跑发布 / 版本号回写后的 tag 点上）时，误把更早版本的 commits 再重新
    # 归入本版 —— 这会导致 README/CHANGELOG 出现巨大的重复分组块（同一个 "✨ 新增"
    # 连续出现两次）。取"除本版外最大的 v* tag"作为起点最稳妥。
    LAST_RELEASE_TAG="$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname 2>/dev/null \
        | grep -v -x "v${VERSION}" \
        | head -n1 || true)"
    GEN_ARGS=(
        "$GEN_CHANGELOG_SCRIPT"
        --version "$VERSION"
        --write
        --sync-readme
        --emit-json
    )
    if [ -n "$LAST_RELEASE_TAG" ]; then
        GEN_ARGS+=( --since "$LAST_RELEASE_TAG" )
        info "  since tag: ${LAST_RELEASE_TAG}"
    else
        info "  since tag: (无历史 tag，回退到全历史)"
    fi
    if [ "$DRY_RUN" = "1" ]; then
        echo "  (dry-run) node ${GEN_ARGS[*]}"
    else
        run_argv node "${GEN_ARGS[@]}"
    fi
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
    if [ "$HAS_FPK" = "1" ]; then
        echo "  飞牛 .fpk     : scripts/fpk/build-fpk.mjs（镜像: ${FPK_DOCKERHUB_REPO}:${VERSION_TAG}）"
        if [ "$HAS_DOCKER" != "1" ]; then
            echo "                  ${C_YELLOW}(未同时构建 docker target，请确保镜像已发布到 Docker Hub)${C_RESET}"
        fi
    fi
    if [ "$HAS_UPK" = "1" ]; then
        echo "  绿联 .upk     : scripts/upk/build-upk.mjs（镜像: ${UPK_IMAGE_REF}, 构建号: ${UPK_BUILD_NO}）"
        if [ "$HAS_DOCKER" != "1" ]; then
            echo "                  ${C_YELLOW}(未同时构建 docker target，将依赖本地已有镜像或 docker pull --pull)${C_RESET}"
        fi
    fi
    if [ "$HAS_LITE" = "1" ]; then
        echo "  Lite 版       : scripts/build-lite.mjs（electron/builder.lite.config.js）"
    fi
    if [ "$HAS_CLIPPER" = "1" ]; then
        echo "  浏览器扩展    : packages/nowen-clipper -> nowen-clipper-<ver>.zip"
    fi
    echo "  同步 git tag  : $([ "$DO_GIT_TAG" = "1" ] && echo yes || echo no)"
    echo "  GitHub Release: $([ "$DO_GITHUB_RELEASE" = "1" ] && echo yes || echo no)"
    echo "  原子发布      : $([ "$ATOMIC_RELEASE" = "1" ] && echo "yes（三端全部构建成功才推送）" || echo no)"
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

# Docker --build-arg：把版本号 / 构建时间塞到运行时 ENV 里
#   - BUILD_DATE  -> 容器内 NOWEN_BUILD_TIME   -> /api/version 的 buildTime 字段
#   - APP_VERSION -> 容器内 NOWEN_APP_VERSION  -> /api/version 的 appVersion 兜底
# 发布模式才有 VERSION（构建模式 VERSION 为空，APP_VERSION 也跟着空，Dockerfile 里 ARG 默认空字符串兼容）。
DOCKER_BUILD_ARGS=(
    --build-arg "BUILD_DATE=${BUILD_DATE}"
)
if [ -n "${VERSION:-}" ]; then
    DOCKER_BUILD_ARGS+=( --build-arg "APP_VERSION=${VERSION}" )
fi

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
        # 发布模式：
        #   - 非原子发布：沿用旧行为，arm64 --load（稍后 docker push），multi --push（边建边推）
        #   - 原子发布：multi 先不 push（只验证构建并把层写入 buildx 缓存），待 PC/Android 全部
        #     成功后再跑第二次 buildx --push（有完整缓存，基本秒推）；arm64 仍 --load
        if [ "$ARCH" = "multi" ]; then
            if [ "$ATOMIC_RELEASE" = "1" ]; then
                # 不 --push 也不 --load（多架构无法 load），只验证构建；产物留在 buildx 缓存里
                BUILDX_OUTPUT=()
                info "原子发布：multi 先构建验证，待 PC/Android 成功后再统一推送"
            else
                BUILDX_OUTPUT=( --push )
            fi
        else
            BUILDX_OUTPUT=( --load )
        fi
    fi

    case "$ARCH" in
        amd64)
            # 明确 -f Dockerfile 与上下文路径 "$REPO_ROOT"，避免个别环境下 docker build 被
            # 劫持为 buildx bake 模式时无法正确定位 Dockerfile
            BUILD_CMD=( docker build -f "$REPO_ROOT/Dockerfile" "${BUILD_TAGS[@]}" "${OCI_LABELS[@]}" "${DOCKER_BUILD_ARGS[@]}" "$REPO_ROOT" )
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
                "${DOCKER_BUILD_ARGS[@]}"
                "${BUILDX_OUTPUT[@]}"
                "$REPO_ROOT"
            )
            echo "  ${BUILD_CMD[*]}"
            run_argv "${BUILD_CMD[@]}"
            ;;
        multi)
            ensure_buildx_builder
            # 多架构 manifest 不能 --load 也不能导成单 tar：
            #   - 旧行为 / 非原子发布：BUILDX_OUTPUT=( --push )，边建边推
            #   - 原子发布：BUILDX_OUTPUT=()，先只构建验证（层写入 buildx 缓存），
            #     待 PC/Android 全部成功后，末尾统一再跑一次 buildx --push 推送
            BUILD_CMD=(
                docker buildx build
                --platform linux/amd64,linux/arm64
                -f "$REPO_ROOT/Dockerfile"
                "${BUILD_TAGS[@]}"
                "${OCI_LABELS[@]}"
                "${DOCKER_BUILD_ARGS[@]}"
                "${BUILDX_OUTPUT[@]}"
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
# 原子发布模式下，这一步整体延迟到"统一推送阶段"，等 PC/Android 全部成功后再做。
# 非原子发布模式保持原行为：Docker 构建后立即 push（旧版用户习惯）。
PUSH_DURATION=0
if [ "$SHOULD_BUILD_DOCKER" = "1" ] && [ "$ATOMIC_RELEASE" != "1" ]; then
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
elif [ "$SHOULD_BUILD_DOCKER" = "1" ] && [ "$ATOMIC_RELEASE" = "1" ]; then
    info "原子发布：Docker 镜像已构建完成，推送将延迟到所有目标构建成功之后"
fi

# 尝试获取 digest（multi 模式本地没镜像，拿不到，留空；原子模式下 amd64/arm64 的 digest
# 要等到末尾 docker push 完成后再取，这里先不算）
DIGEST=""
if [ "$SHOULD_BUILD_DOCKER" = "1" ] && [ "$DRY_RUN" != "1" ] \
   && [ "$ARCH" != "multi" ] && [ "$ATOMIC_RELEASE" != "1" ]; then
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

    # ---- 前置：确保 backend 依赖齐全 ----
    # 背景：rebuild:native 只负责把原生模块从 Node ABI 切到 Electron ABI，
    #   不会补装缺失的 npm 包；一旦 backend/node_modules 不完整（新机器 / 切过分支 /
    #   手动删过 node_modules / lockfile 漂移），接下来 `npm run build:backend`
    #   的 tsc 会直接 TS2307 "Cannot find module 'xxx'" 报错。
    # 策略：检查几个关键依赖是否都存在；缺任何一个就在 backend/ 下跑一次 npm install。
    # 覆盖：sqlite-vec（曾经因此失败过）、better-sqlite3、hono、jsonwebtoken。
    if [ "$DRY_RUN" = "1" ]; then
        echo "  (dry-run) 检查 backend/node_modules 关键依赖"
    else
        _BACKEND_DEPS_OK=1
        if [ ! -d "${REPO_ROOT}/backend/node_modules" ]; then
            _BACKEND_DEPS_OK=0
        else
            # 兜底 1：lockfile 漂移检测——package-lock.json 比 node_modules
            #   内部快照 .package-lock.json 新，说明刚 git pull 引入了新依赖
            #   但还没 npm install。npm 7+ 会在 install 后写入这份快照，
            #   用它作 mtime 对账，无需维护白名单也能识别新增依赖。
            _BE_LOCK="${REPO_ROOT}/backend/package-lock.json"
            _BE_SNAP="${REPO_ROOT}/backend/node_modules/.package-lock.json"
            if [ -f "$_BE_LOCK" ] && [ -f "$_BE_SNAP" ] && [ "$_BE_LOCK" -nt "$_BE_SNAP" ]; then
                warn "backend lockfile 比 node_modules 快照新，疑似新增依赖未安装"
                _BACKEND_DEPS_OK=0
            elif [ -f "$_BE_LOCK" ] && [ ! -f "$_BE_SNAP" ]; then
                warn "backend node_modules/.package-lock.json 缺失，无法确认依赖一致性"
                _BACKEND_DEPS_OK=0
            fi
            # 兜底 2：白名单逐项 check（覆盖一些历史掉过坑的代表性依赖）
            for _dep in sqlite-vec better-sqlite3 hono jsonwebtoken; do
                if [ ! -d "${REPO_ROOT}/backend/node_modules/${_dep}" ]; then
                    warn "backend 依赖缺失: ${_dep}"
                    _BACKEND_DEPS_OK=0
                fi
            done
        fi
        if [ "$_BACKEND_DEPS_OK" = "0" ]; then
            info "backend 依赖不完整，自动执行 ${C_GREEN}npm install${C_RESET}（避免 tsc TS2307 报错）"
            ( cd "${REPO_ROOT}/backend" && run_argv npm install )
        else
            info "backend 依赖检查通过"
        fi
    fi

    # ---- 前置：确保 frontend 依赖齐全 ----
    # 背景：同 backend，frontend/node_modules 缺包时 `npm run build:frontend`
    #   里的 `tsc -b` 会在各种 import 上直接 TS2307；之前在 Linux 上就被
    #   html2canvas / jspdf / marked / @mhaberler/capacitor-zeroconf-nsd /
    #   @aparajita/capacitor-secure-storage / @aparajita/capacitor-biometric-auth
    #   这一串依赖绊住过。
    # 策略：与 backend 同款——挑几个代表性依赖做白名单体检，缺任一个就
    #   在 frontend/ 跑一次 npm install；齐全则放行不拖慢正常环境。
    if [ "$DRY_RUN" = "1" ]; then
        echo "  (dry-run) 检查 frontend/node_modules 关键依赖"
    else
        _FRONTEND_DEPS_OK=1
        if [ ! -d "${REPO_ROOT}/frontend/node_modules" ]; then
            _FRONTEND_DEPS_OK=0
        else
            # 兜底 1：lockfile 漂移检测（同 backend）
            #   package-lock.json 比 node_modules/.package-lock.json 新 →
            #   git pull 后引入了新依赖但还没安装，强制触发 npm install。
            #   有了这道兜底，下面那串白名单仅作为额外保险，不再是关键依赖唯一识别手段。
            _FE_LOCK="${REPO_ROOT}/frontend/package-lock.json"
            _FE_SNAP="${REPO_ROOT}/frontend/node_modules/.package-lock.json"
            if [ -f "$_FE_LOCK" ] && [ -f "$_FE_SNAP" ] && [ "$_FE_LOCK" -nt "$_FE_SNAP" ]; then
                warn "frontend lockfile 比 node_modules 快照新，疑似新增依赖未安装"
                _FRONTEND_DEPS_OK=0
            elif [ -f "$_FE_LOCK" ] && [ ! -f "$_FE_SNAP" ]; then
                warn "frontend node_modules/.package-lock.json 缺失，无法确认依赖一致性"
                _FRONTEND_DEPS_OK=0
            fi
            # 选型说明：
            #   - react / vite / typescript：基石，缺任一个都是环境未初始化
            #   - marked / html2canvas / jspdf：历史上掉过坑的导出/导入依赖
            #   - @aparajita/capacitor-secure-storage / @aparajita/capacitor-biometric-auth
            #     / @mhaberler/capacitor-zeroconf-nsd：带 scope 的 Capacitor 插件，
            #     新机器 / 切分支时常缺
            #   - mermaid / katex / rehype-raw：编辑器后期新增的块级扩展依赖（Mermaid 图、
            #     数学公式、Markdown 渲染），CI 旧 node_modules 不会有，必须体检触发 install
            #   - @tiptap/extension-text-style：v3 把 FontSize / Color / FontFamily 都
            #     合到这一个包里，字号/颜色功能强依赖；旧 node_modules 漏装会直接 TS2307
            for _dep in \
                react vite typescript \
                marked html2canvas jspdf \
                mermaid katex rehype-raw \
                "@tiptap/extension-text-style" \
                "@aparajita/capacitor-secure-storage" \
                "@aparajita/capacitor-biometric-auth" \
                "@mhaberler/capacitor-zeroconf-nsd"; do
                if [ ! -d "${REPO_ROOT}/frontend/node_modules/${_dep}" ]; then
                    warn "frontend 依赖缺失: ${_dep}"
                    _FRONTEND_DEPS_OK=0
                fi
            done
        fi
        if [ "$_FRONTEND_DEPS_OK" = "0" ]; then
            info "frontend 依赖不完整，自动执行 ${C_GREEN}npm install${C_RESET}（避免 tsc TS2307 报错）"
            ( cd "${REPO_ROOT}/frontend" && run_argv npm install )
        else
            info "frontend 依赖检查通过"
        fi
    fi

    # 统一先跑 rebuild:native + build:all（safe-build.mjs 内部也是这三步，这里拆开以便非 Windows 分支复用）
    if [ "$UNAME_S_PC" = "Linux" ] || [ "$UNAME_S_PC" = "Darwin" ]; then
        # 输出目录：在 Linux/macOS 上不做 tmpdir 切换，默认 dist-electron/
        # （NOWEN_BUILD_OUT 主要是 Windows 下避免 IDE 监听，Linux/macOS 不需要）
        info "build:all"
        if [ "$DRY_RUN" = "1" ]; then
            echo "  (dry-run) npm run build:all"
        else
            ( cd "$REPO_ROOT" && run_argv npm run build:all )
        fi

        # ---- rebuild:native 按平台各打一遍 ----
        # 历史教训（2026-05）：原先一次 rebuild:native + 多平台 electron-builder，
        # 在 Linux 宿主上会把 better-sqlite3 编成 Linux .so 塞进 Win 安装包，
        # 用户启动时 LoadLibrary 报 "is not a valid Win32 application"。
        # 修复：每跑一个平台目标前，按 target-platform 重新准备 better-sqlite3.node：
        #   - host == target：调 @electron/rebuild 真编
        #   - host != target：跨平台分支，用 prebuild-install 下官方 prebuilt
        # 然后 electron-builder 只打这一个平台。
        #
        # HOST_PLATFORM：Linux -> linux, Darwin -> darwin（macOS）
        if [ "$UNAME_S_PC" = "Linux" ]; then HOST_PLATFORM="linux"; else HOST_PLATFORM="darwin"; fi

        _build_one_pc_target() {
            local _eb_flag="$1"     # --win / --linux / --mac
            local _target_plat="$2" # win32 / linux / darwin
            local _target_arch="${3:-x64}"
            info "rebuild:native for ${_target_plat}-${_target_arch} (host=${HOST_PLATFORM})"
            if [ "$DRY_RUN" = "1" ]; then
                echo "  (dry-run) npm run rebuild:native -- --target-platform=${_target_plat} --target-arch=${_target_arch}"
                echo "  (dry-run) npx electron-builder --config electron/builder.config.js --publish never ${_eb_flag}"
                return 0
            fi
            ( cd "$REPO_ROOT" && run_argv npm run rebuild:native -- \
                --target-platform="${_target_plat}" --target-arch="${_target_arch}" )
            info "electron-builder ${_eb_flag}"
            set +e
            ( cd "$REPO_ROOT" && run_argv npx electron-builder \
                --config electron/builder.config.js \
                --publish never \
                "${_eb_flag}" )
            local _ec=$?
            set -e
            if [ "$_ec" != "0" ]; then
                echo
                warn "electron-builder ${_eb_flag} 退出码 $_ec"
                if [ "$_eb_flag" = "--win" ] && [ "$UNAME_S_PC" = "Linux" ]; then
                    warn "你正在 Linux 下打 Windows 目标，常见失败原因："
                    warn "  1) wine 跑 rcedit 被 OOM-kill (signal: killed) → 给 WSL2 加内存：%UserProfile%\\.wslconfig 设 memory=12GB swap=8GB，再 wsl --shutdown"
                    warn "  2) wine 32 位子系统未装 → sudo dpkg --add-architecture i386 && sudo apt install -y wine32:i386 && wineboot -i"
                    warn "  3) winCodeSign 下载被墙 → 设 NOWEN_SKIP_RCEDIT=1 跳过 rcedit/签名"
                    warn "  4) prebuild-install 拉 win32 better-sqlite3 超时 → 设 HTTPS_PROXY"
                fi
                die "PC 端打包失败（原子发布：未推送任何东西）"
            fi
        }

        if [ "$PC_HAS_WIN" = "1" ]; then
            _build_one_pc_target --win win32 x64
        fi
        if [ "$PC_HAS_LINUX" = "1" ]; then
            _build_one_pc_target --linux linux x64
        fi
        if [ "$PC_HAS_MAC" = "1" ]; then
            # mac 按架构循环：每个 arch 都要单独 rebuild:native + electron-builder
            # 通过 NOWEN_MAC_ARCH 让 builder.config.js 的 mac.target 只产出该架构 dmg/zip
            #
            # 默认只打 x64：
            #   - Intel Mac 原生跑
            #   - Apple Silicon 走 Rosetta 也能跑（性能略损，但避免双架构错位 .node 翻车）
            #   - 想出原生 arm64 包可显式 --mac-arch arm64 或 --mac-arch x64,arm64
            #
            # 历史教训（2026-05 Intel Mac ERR_DLOPEN_FAILED）：
            #   原 builder.config 一次 build 同时输出 arm64+x64 dmg/zip，但
            #   backend/better_sqlite3.node 只能 rebuild 出一个架构 → 另一架构包打开崩。
            #
            # 注意：若同时打两个架构，electron-updater 的 latest-mac.yml 会被第二次
            #   覆盖；目前自动更新仅按最后一次构建的架构发布。如需双架构都自动更新，
            #   后续再补 yml 合并逻辑（或回归到 mac 宿主上一次性多架构构建）。
            _MAC_ARCHES_LIST="${MAC_ARCHES:-x64}"
            IFS=',' read -ra _MAC_ARCH_ARR <<< "$_MAC_ARCHES_LIST"
            for _ma in "${_MAC_ARCH_ARR[@]}"; do
                _ma="$(echo "$_ma" | tr -d '[:space:]')"
                [ -z "$_ma" ] && continue
                if [ "$_ma" != "x64" ] && [ "$_ma" != "arm64" ]; then
                    die "--mac-arch 未知值: $_ma （合法: x64 / arm64）"
                fi
                info "mac arch=${_ma}: 先 rebuild:native，再 electron-builder（NOWEN_MAC_ARCH=${_ma}）"
                NOWEN_MAC_ARCH="$_ma" _build_one_pc_target --mac darwin "$_ma"
            done
            if [ "${#_MAC_ARCH_ARR[@]}" -gt 1 ]; then
                warn "本次打了多个 mac 架构（${_MAC_ARCHES_LIST}），latest-mac.yml 仅保留最后一次构建的架构信息——自动更新仅对该架构生效"
            fi
        fi

        # 兼容后续步骤可能引用的变量（原实现使用一次性 EB_PLATFORM_ARGS）
        EB_PLATFORM_ARGS=()
        [ "$PC_HAS_WIN" = "1" ]   && EB_PLATFORM_ARGS+=( --win )
        [ "$PC_HAS_LINUX" = "1" ] && EB_PLATFORM_ARGS+=( --linux )
        [ "$PC_HAS_MAC" = "1" ]   && EB_PLATFORM_ARGS+=( --mac )

        # 注：每个平台目标已经在上面的 _build_one_pc_target 中独立打过了
        # （每打一个平台前都会重新 rebuild:native 为对应平台准备 better-sqlite3.node）
        # 这里不能再 `electron-builder ${EB_PLATFORM_ARGS[*]}`，否则最后一个 rebuild 的
        # 目标会把之前平台的 .node 覆盖，产物再次错位。
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
        # 收集要上传的产物：仅匹配"当前版本号"的安装包 + electron-updater 元数据
        #
        # 历史教训（v1.0.32 翻车）：dist-electron/ 是 electron-builder 默认输出目录，
        # 它从不主动清理历史版本——CI 容器或本地长期累积时，目录里会同时存在
        # Setup.1.0.11.exe ~ Setup.1.0.31.exe 一大堆旧产物，再加 .blockmap。
        # 之前用 -name "*.exe" / "*.AppImage" / "*.blockmap" 全捞，会把所有历史
        # 版本一锅端上传到 GitHub Release，造成 v1.0.32 的 Release 里挂了 60+ 个
        # 历史包（参见 issue：v1.0.32 Release Assets 含 1.0.11 起所有版本）。
        #
        # 正确做法：用 ${VERSION} 作为子串过滤。electron-builder 输出文件名一定
        # 带版本号（Nowen.Note.Setup.1.0.32.exe / Nowen.Note-1.0.32.AppImage /
        # Nowen.Note-1.0.32-arm64-mac.zip / Nowen.Note-1.0.32.exe.blockmap 等）。
        # 例外：latest.yml / latest-mac.yml / latest-linux.yml 不带版本号，但
        # electron-builder 每次构建会覆写为当前版本元数据，直接全收即可。
        #
        # 注意：bash 的 find -name 通配 * 不匹配 /，但同名 glob 在脚本里被花括号
        # 包住时仍然由 find 自己解释，安全。
        while IFS= read -r f; do
            PC_ARTIFACTS+=( "$f" )
        done < <(
            find "$PC_OUT" -maxdepth 1 -type f \( \
                -name "*${VERSION}*.exe" -o \
                -name "*${VERSION}*.dmg" -o \
                -name "*${VERSION}*.zip" -o \
                -name "*${VERSION}*.AppImage" -o \
                -name "*${VERSION}*.deb" -o \
                -name "*${VERSION}*.blockmap" -o \
                -name "latest*.yml" \
            \) 2>/dev/null | sort
        )
        info "PC 产物目录: $PC_OUT (仅匹配版本 ${VERSION})"
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
        # 确保 gradlew 有可执行权限（git clone 到 WSL/Linux 后可能丢失 +x）
        chmod +x "$REPO_ROOT/frontend/android/gradlew" 2>/dev/null || true
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
                # 原子/一键全量发布：未签名 APK = 不可发布（同包名换签名会让所有老用户必须卸载重装）
                # 必须 die，不能让未签名包混进 GitHub Release
                if [ "${_ONE_SHOT:-0}" = "1" ] || [ "$ATOMIC_RELEASE" = "1" ]; then
                    die "Android 打包产出的是未签名 APK ($APK_UNSIGNED)：原子/一键全量发布要求签名 APK，请检查 frontend/android/keystore.properties 或 NOWEN_ANDROID_KEYSTORE_B64 配置"
                fi
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

# -------------------- 飞牛 .fpk 打包（原子发布：在 docker push 之前） --------------------
# 设计要点：fpk 本地打包仅生成 compose.yml 引用 DockerHub 镜像名，
# 不依赖镜像已经推到 DockerHub（运行时用户的 NAS 才会去 docker pull）。
# 所以 fpk 必须在 docker push 之前完成 —— 任何一端构建失败时，docker 还没推，
# 真正满足"全部成功才推送"的原子语义。
FPK_ARTIFACTS=()
FPK_BUILD_DURATION=0
if [ "$HAS_FPK" = "1" ]; then
    step "飞牛 .fpk 打包"
    FPK_START=$(date +%s)

    # build-fpk.mjs 通过环境变量取镜像地址 / 版本号
    # 关键：FPK_IMAGE_TAG=${VERSION_TAG} 让 compose.yaml 拉的镜像 tag 与 docker push 一致。
    # 如果不传 FPK_IMAGE_TAG，build-fpk.mjs fallback 用裸版本号（如 1.0.30），
    # 但 release.sh 实际 push 的是 v1.0.30，飞牛 NAS 安装时会报 "manifest unknown / EOF"。
    # manifest 内的 version 字段仍用纯版本号（飞牛要求 X.Y.Z 形式）。
    info "调用 scripts/fpk/build-fpk.mjs（DOCKERHUB_REPO=${FPK_DOCKERHUB_REPO}, image tag=${VERSION_TAG}, manifest version=${VERSION}）"
    if [ "$DRY_RUN" = "1" ]; then
        echo "  (dry-run) DOCKERHUB_REPO=${FPK_DOCKERHUB_REPO} FPK_IMAGE_TAG=${VERSION_TAG} node scripts/fpk/build-fpk.mjs"
    else
        ( cd "$REPO_ROOT" && \
          DOCKERHUB_REPO="$FPK_DOCKERHUB_REPO" \
          FPK_IMAGE_TAG="$VERSION_TAG" \
          run_argv node scripts/fpk/build-fpk.mjs )
    fi

    # 收集 dist-fpk/ 下产物
    # 注意：dist-fpk/ 目录只增不清，里面会堆积历次发布的 .fpk（例如
    # nowen-note-1.0.29.fpk ... nowen-note-1.0.34.fpk）。收集时**必须只**
    # 抓本次版本号对应的文件，否则会把一堆旧版本一起传到新 Release。
    # 用 "*${VERSION}.fpk" 是因为 build-fpk.mjs 产物名固定为
    # nowen-note-${VERSION}.fpk / nowen-note-${VERSION}-<arch>.fpk 等形态。
    FPK_OUT="${REPO_ROOT}/dist-fpk"
    if [ "$DRY_RUN" != "1" ] && [ -d "$FPK_OUT" ]; then
        while IFS= read -r f; do
            FPK_ARTIFACTS+=( "$f" )
        done < <(find "$FPK_OUT" -maxdepth 1 -type f -name "*${VERSION}*.fpk" 2>/dev/null | sort)
        info "fpk 产物目录: $FPK_OUT（仅收集版本 ${VERSION} 的 .fpk）"
        for f in "${FPK_ARTIFACTS[@]}"; do
            echo "    - $(basename "$f")"
        done
        [ "${#FPK_ARTIFACTS[@]}" -eq 0 ] && {
            # 原子/一键全量发布：build-fpk.mjs 退出码可能是 0 但产物为空（脚本内部容错过度）
            # 这种情况绝不能往下走 GitHub Release
            if [ "${_ONE_SHOT:-0}" = "1" ] || [ "$ATOMIC_RELEASE" = "1" ]; then
                die "未找到任何 .fpk 产物：原子/一键全量发布要求 fpk 构建必须有产物，请检查 build-fpk.mjs 输出"
            fi
            warn "未找到任何 .fpk 产物（请检查 build-fpk.mjs 输出）"
        }
    elif [ "$DRY_RUN" != "1" ]; then
        # dist-fpk 目录都不存在 = build-fpk.mjs 没产任何东西
        if [ "${_ONE_SHOT:-0}" = "1" ] || [ "$ATOMIC_RELEASE" = "1" ]; then
            die "fpk 输出目录 $FPK_OUT 不存在：原子/一键全量发布要求 fpk 构建成功，请检查 build-fpk.mjs"
        fi
        warn "fpk 输出目录 $FPK_OUT 不存在"
    fi

    FPK_END=$(date +%s)
    FPK_BUILD_DURATION=$((FPK_END - FPK_START))
    ok "飞牛 .fpk 打包完成，用时 ${FPK_BUILD_DURATION}s"
fi

# -------------------- 绿联 .upk 打包（原子发布：在 docker push 之前） --------------------
# 设计要点：upk 必须把镜像 tar 打进包内（绿联应用中心不允许引用远端 image latest tag），
# 所以构建依赖本地已有目标镜像。
#
#   - 与 docker target 同跑（一键全量）：紧贴在 buildx --load 之后、push 之前最佳，
#     此时本机已有当前版本的 amd64 + arm64 镜像可直接 docker save，无需重复拉取。
#   - 单独跑 upk（HAS_DOCKER=0）：build-upk.mjs 会先尝试 docker image inspect 找本地镜像，
#     找不到则按 --pull 自动 docker pull --platform linux/<arch> ${UPK_IMAGE_REF}。
#
# 与 fpk 一样：放在 docker push 之前，让"任何一端构建失败 → docker 还没推 → upk 也不出包"
# 满足全链路原子语义。
UPK_ARTIFACTS=()
UPK_BUILD_DURATION=0
if [ "$HAS_UPK" = "1" ]; then
    step "绿联 .upk 打包"
    UPK_START=$(date +%s)

    # ---- multi 架构预热：把镜像 --load 到本机 docker ----
    # 背景：HAS_DOCKER=1 + ARCH=multi 时，前面那次 buildx 走的是
    #   - 原子模式 BUILDX_OUTPUT=()         （只写缓存，不 push 不 load）
    #   - 非原子   BUILDX_OUTPUT=( --push ) （直接推 registry，本机仍无镜像）
    # 两种情况下 docker daemon 里都查不到 ${IMAGE_NAME}:${VERSION_TAG}，build-upk.mjs
    # 走 docker image inspect 必然失败，触发"找不到任何架构镜像"的警告并跳过。
    #
    # 解决：在这里对每个架构跑一次 `buildx --platform linux/<arch> --load`，
    # 但用 **带架构后缀的独立 tag**（${IMAGE_NAME}:${VERSION_TAG}-amd64 / -arm64）
    # 避免相互覆盖。build-upk.mjs 的候选清单里本来就含 ${IMAGE_REF}-${arch}，
    # 会用 `docker image inspect --format '{{.Architecture}}'` 自动选中正确架构。
    # 第一次 buildx 的层全部还在缓存里，这一步基本秒级（重打 manifest + 解压本地）。
    UPK_NEEDS_PULL=0
    if [ "$HAS_DOCKER" != "1" ]; then
        # 没跑 docker target（单独跑 upk），让 build-upk.mjs 自己 docker pull 远端
        UPK_NEEDS_PULL=1
    elif [ "$ARCH" = "multi" ] && [ "$DRY_RUN" != "1" ]; then
        info "multi 模式：upk 需要本机镜像，先 buildx --load 各架构（带 -<arch> 后缀，吃缓存，秒级）"
        ensure_buildx_builder
        for upk_plat in amd64 arm64; do
            UPK_ARCH_TAG="${IMAGE_NAME}:${VERSION_TAG}-${upk_plat}"
            info "  buildx --load linux/${upk_plat} -> ${UPK_ARCH_TAG}"
            UPK_LOAD_CMD=(
                docker buildx build
                --platform "linux/${upk_plat}"
                -f "$REPO_ROOT/Dockerfile"
                -t "$UPK_ARCH_TAG"
                "${OCI_LABELS[@]}"
                "${DOCKER_BUILD_ARGS[@]}"
                --load
                "$REPO_ROOT"
            )
            # 失败一定是 buildx 缓存被清或 Dockerfile 改坏了，直接 die（不靠 --pull 兜底，
            # 因为远端 multi tag 的 manifest 拉下来本机仍只能存一个架构）。
            run_argv "${UPK_LOAD_CMD[@]}"
        done
        ok "multi 镜像已 --load 到本机：${IMAGE_NAME}:${VERSION_TAG}-{amd64,arm64}"
    fi
    # amd64 / arm64 单架构模式下，前面 buildx 已经 --load 到 ${IMAGE_NAME}:${VERSION_TAG}，
    # 不需要预热；build-upk.mjs 直接 docker save 即可（另一架构会被自然跳过）。

    # build-upk.mjs 通过 UPK_IMAGE_REF / UPK_BUILD_NO / DOCKERHUB_REPO 接收参数
    UPK_ARGS=( scripts/upk/build-upk.mjs --build "$UPK_BUILD_NO" )
    if [ "$UPK_NEEDS_PULL" = "1" ]; then
        UPK_ARGS+=( --pull )
    fi

    info "调用 scripts/upk/build-upk.mjs（UPK_IMAGE_REF=${UPK_IMAGE_REF}, build=${UPK_BUILD_NO}, pull=$([ "$UPK_NEEDS_PULL" = "1" ] && echo yes || echo no)）"
    if [ "$DRY_RUN" = "1" ]; then
        echo "  (dry-run) UPK_IMAGE_REF=${UPK_IMAGE_REF} UPK_BUILD_NO=${UPK_BUILD_NO} DOCKERHUB_REPO=${FPK_DOCKERHUB_REPO} node ${UPK_ARGS[*]}"
    else
        ( cd "$REPO_ROOT" && \
          UPK_IMAGE_REF="$UPK_IMAGE_REF" \
          UPK_BUILD_NO="$UPK_BUILD_NO" \
          DOCKERHUB_REPO="$FPK_DOCKERHUB_REPO" \
          run_argv node "${UPK_ARGS[@]}" )
    fi

    # 收集 dist-upk/ 下产物
    # 与 fpk 同思路：dist-upk 是只增不清，必须按当前 VERSION 子串过滤，
    # 否则会把所有历史版本一起传到 GitHub Release。
    # ugcli pack 默认产物名形如 amd64_io.nowen.note_${VERSION}.${BUILD_NO}.upk
    UPK_OUT="${REPO_ROOT}/dist-upk"
    if [ "$DRY_RUN" != "1" ] && [ -d "$UPK_OUT" ]; then
        while IFS= read -r f; do
            UPK_ARTIFACTS+=( "$f" )
        done < <(find "$UPK_OUT" -maxdepth 1 -type f -name "*${VERSION}*.upk" 2>/dev/null | sort)
        info "upk 产物目录: $UPK_OUT（仅收集版本 ${VERSION} 的 .upk）"
        for f in "${UPK_ARTIFACTS[@]}"; do
            echo "    - $(basename "$f")"
        done
        if [ "${#UPK_ARTIFACTS[@]}" -eq 0 ]; then
            if [ "${_ONE_SHOT:-0}" = "1" ] || [ "$ATOMIC_RELEASE" = "1" ]; then
                die "未找到任何 .upk 产物：原子/一键全量发布要求 upk 构建必须有产物，请检查 build-upk.mjs 输出"
            fi
            warn "未找到任何 .upk 产物（请检查 build-upk.mjs 输出）"
        fi
    elif [ "$DRY_RUN" != "1" ]; then
        if [ "${_ONE_SHOT:-0}" = "1" ] || [ "$ATOMIC_RELEASE" = "1" ]; then
            die "upk 输出目录 $UPK_OUT 不存在：原子/一键全量发布要求 upk 构建成功，请检查 build-upk.mjs"
        fi
        warn "upk 输出目录 $UPK_OUT 不存在"
    fi

    UPK_END=$(date +%s)
    UPK_BUILD_DURATION=$((UPK_END - UPK_START))
    ok "绿联 .upk 打包完成，用时 ${UPK_BUILD_DURATION}s"
fi

# -------------------- Lite 版打包（无后端 PC 安装包） --------------------
# 复用 PC 端的依赖体检结果（HAS_PC=1 时 backend/frontend 依赖都已经在 PC 段处理过）。
# 单独跑 lite（HAS_PC=0）时这里也保险地确保 frontend 依赖在位——build-lite.mjs
# 内部会跑 build:frontend，缺包会直接 TS2307。
LITE_ARTIFACTS=()
LITE_BUILD_DURATION=0
if [ "$HAS_LITE" = "1" ]; then
    step "Lite 版打包（scripts/build-lite.mjs）"
    LITE_START=$(date +%s)

    UNAME_S_LITE="$(uname -s 2>/dev/null || echo unknown)"

    # 确保 frontend 依赖：若 PC 段没跑过（HAS_PC=0），这里独立体检一次。
    # PC 段已经体检过的话，再跑一次也只是几个 ls -d，可忽略。
    if [ "$DRY_RUN" != "1" ]; then
        if [ ! -d "${REPO_ROOT}/frontend/node_modules" ]; then
            info "frontend/node_modules 不存在，自动 npm install"
            ( cd "${REPO_ROOT}/frontend" && run_argv npm install )
        fi
    fi

    # build-lite.mjs：Windows 上加 --safe（taskkill 残留 + 临时 OUT 目录）；
    # Linux/macOS 不需要，直接出到 dist-electron-lite/。
    LITE_ARGS=( "$REPO_ROOT/scripts/build-lite.mjs" )
    case "$UNAME_S_LITE" in
        MINGW*|MSYS*|CYGWIN*) LITE_ARGS+=( "--safe" ) ;;
    esac

    if [ "$DRY_RUN" = "1" ]; then
        echo "  (dry-run) node ${LITE_ARGS[*]}"
    else
        ( cd "$REPO_ROOT" && run_argv node "${LITE_ARGS[@]}" )
    fi

    # 收集产物：候选目录与 build-lite.mjs 内部一致
    #   - 普通态：dist-electron-lite/
    #   - --safe：%TEMP%/nowen-note-lite-build/
    LITE_OUT_CANDIDATES=(
        "${REPO_ROOT}/dist-electron-lite"
        "$(node -e 'console.log(require("os").tmpdir())' 2>/dev/null)/nowen-note-lite-build"
    )
    LITE_OUT=""
    for cand in "${LITE_OUT_CANDIDATES[@]}"; do
        if [ -d "$cand" ]; then
            LITE_OUT="$cand"
            break
        fi
    done

    if [ "$DRY_RUN" != "1" ] && [ -n "$LITE_OUT" ]; then
        # 与 PC 端一致：仅匹配当前版本号的产物 + latest*.yml 元数据
        # （根因和修复见 PC 段同位置注释——dist-electron-lite/ 同样是 electron-builder
        # 的累积目录，旧版本不清理；用 ${VERSION} 子串过滤精确收敛）
        # blockmap + latest*.yml 让 lite 也能走 electron-updater 自更新（channel="lite"）
        while IFS= read -r f; do
            LITE_ARTIFACTS+=( "$f" )
        done < <(
            find "$LITE_OUT" -maxdepth 1 -type f \( \
                -name "*${VERSION}*.exe" -o \
                -name "*${VERSION}*.dmg" -o \
                -name "*${VERSION}*.zip" -o \
                -name "*${VERSION}*.AppImage" -o \
                -name "*${VERSION}*.deb" -o \
                -name "*${VERSION}*.blockmap" -o \
                -name "latest*.yml" \
            \) 2>/dev/null | sort
        )
        info "Lite 产物目录: $LITE_OUT (仅匹配版本 ${VERSION})"
        for f in "${LITE_ARTIFACTS[@]}"; do
            echo "    - $(basename "$f")"
        done
        if [ "${#LITE_ARTIFACTS[@]}" -eq 0 ]; then
            if [ "${_ONE_SHOT:-0}" = "1" ] || [ "$ATOMIC_RELEASE" = "1" ]; then
                die "Lite 输出目录 $LITE_OUT 没有任何安装包：原子/一键全量发布要求 lite 必须有产物"
            fi
            warn "Lite 输出目录 $LITE_OUT 没有任何匹配的安装包"
        fi
    elif [ "$DRY_RUN" != "1" ]; then
        if [ "${_ONE_SHOT:-0}" = "1" ] || [ "$ATOMIC_RELEASE" = "1" ]; then
            die "Lite 输出目录不存在（dist-electron-lite / nowen-note-lite-build）：build-lite.mjs 是否成功？"
        fi
        warn "Lite 输出目录不存在（dist-electron-lite / nowen-note-lite-build）"
    fi

    LITE_END=$(date +%s)
    LITE_BUILD_DURATION=$((LITE_END - LITE_START))
    ok "Lite 打包完成，用时 ${LITE_BUILD_DURATION}s"
fi

# -------------------- 浏览器扩展（nowen-clipper）打包 --------------------
# 输出 packages/nowen-clipper/releases/nowen-clipper-<extVer>.zip
# 注意：扩展自身的 version 来自 packages/nowen-clipper/package.json，与主仓库 VERSION
# 解耦（Chrome/Firefox 商店上传必须递增扩展自身版本号；和主版本号绑定反而难维护）。
# 这里尊重 packages/nowen-clipper/package.json 已经写好的版本号，不做改写。
CLIPPER_ARTIFACTS=()
CLIPPER_BUILD_DURATION=0
if [ "$HAS_CLIPPER" = "1" ]; then
    step "浏览器扩展打包（packages/nowen-clipper）"
    CLIPPER_START=$(date +%s)

    CLIPPER_DIR="${REPO_ROOT}/packages/nowen-clipper"

    # 1) 依赖体检：缺 node_modules 自动 npm install
    if [ "$DRY_RUN" != "1" ] && [ ! -d "${CLIPPER_DIR}/node_modules" ]; then
        info "packages/nowen-clipper/node_modules 不存在，自动 npm install"
        ( cd "$CLIPPER_DIR" && run_argv npm install )
    fi

    # 2) 跑 npm run pack：内部串了 build + flatten-html + copy-public + pack.mjs
    info "npm run pack（packages/nowen-clipper）"
    if [ "$DRY_RUN" = "1" ]; then
        echo "  (dry-run) cd packages/nowen-clipper && npm run pack"
    else
        ( cd "$CLIPPER_DIR" && run_argv npm run pack )
    fi

    # 3) 收集 releases/*.zip
    CLIPPER_OUT="${CLIPPER_DIR}/releases"
    if [ "$DRY_RUN" != "1" ] && [ -d "$CLIPPER_OUT" ]; then
        # 只收"本次打的那一个"，避免把历史 zip 一并上传：
        # 读 packages/nowen-clipper/package.json 的 version 字段
        CLIPPER_VER="$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' "${CLIPPER_DIR}/package.json" | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
        TARGET_ZIP="${CLIPPER_OUT}/nowen-clipper-${CLIPPER_VER}.zip"
        if [ -f "$TARGET_ZIP" ]; then
            CLIPPER_ARTIFACTS+=( "$TARGET_ZIP" )
            info "Clipper 产物: $TARGET_ZIP"
        else
            if [ "${_ONE_SHOT:-0}" = "1" ] || [ "$ATOMIC_RELEASE" = "1" ]; then
                die "未找到 $TARGET_ZIP：原子/一键全量发布要求 clipper 必须有产物"
            fi
            warn "未找到 $TARGET_ZIP（pack.mjs 是否成功？）"
        fi
    elif [ "$DRY_RUN" != "1" ]; then
        if [ "${_ONE_SHOT:-0}" = "1" ] || [ "$ATOMIC_RELEASE" = "1" ]; then
            die "Clipper 输出目录不存在: $CLIPPER_OUT"
        fi
        warn "Clipper 输出目录不存在: $CLIPPER_OUT"
    fi

    CLIPPER_END=$(date +%s)
    CLIPPER_BUILD_DURATION=$((CLIPPER_END - CLIPPER_START))
    ok "浏览器扩展打包完成，用时 ${CLIPPER_BUILD_DURATION}s"
fi

# -------------------- 原子发布：统一推送 Docker 镜像 --------------------
# 走到这里意味着所选目标（docker/pc/android/fpk/lite/clipper）全部构建成功。
# 现在才是真正"把东西发出去"的时候：先 docker push，再 git tag push，再 gh release。
# 任何一步失败 set -e 会立即 die，后续不再继续。
if [ "$SHOULD_BUILD_DOCKER" = "1" ] && [ "$ATOMIC_RELEASE" = "1" ]; then
    step "统一推送 Docker 镜像（原子发布：所有构建已完成）"
    PUSH_START=$(date +%s)

    case "$ARCH" in
        multi)
            # 第二次跑 buildx --push：第一次的层已经在 buildx 缓存里，绝大部分是秒过
            info "buildx 重新执行 --push（利用第一次构建的缓存）"
            ensure_buildx_builder
            PUSH_CMD=(
                docker buildx build
                --platform linux/amd64,linux/arm64
                -f "$REPO_ROOT/Dockerfile"
                "${BUILD_TAGS[@]}"
                "${OCI_LABELS[@]}"
                "${DOCKER_BUILD_ARGS[@]}"
                --push
                "$REPO_ROOT"
            )
            echo "  ${PUSH_CMD[*]}"
            run_argv "${PUSH_CMD[@]}"
            ;;
        amd64|arm64)
            info "推送：${IMAGE_NAME}:${VERSION_TAG}"
            run "docker push \"${IMAGE_NAME}:${VERSION_TAG}\""
            if [ "$DO_LATEST" = "1" ]; then
                info "推送：${IMAGE_NAME}:latest"
                run "docker push \"${IMAGE_NAME}:latest\""
            fi
            ;;
    esac

    PUSH_END=$(date +%s)
    PUSH_DURATION=$((PUSH_END - PUSH_START))

    # 现在本地已有镜像（或 multi push 成功），可以取 digest 了
    if [ "$DRY_RUN" != "1" ] && [ "$ARCH" != "multi" ]; then
        DIGEST="$(docker inspect --format='{{index .RepoDigests 0}}' "${IMAGE_NAME}:${VERSION_TAG}" 2>/dev/null || echo "")"
    fi
    ok "Docker 镜像推送完成，用时 ${PUSH_DURATION}s"
fi


# -------------------- git tag --------------------
if [ "$DO_GIT_TAG" = "1" ]; then
    step "打 git tag 并推送到 GitHub"

    # 若前面 sync_root_pkg_version / sync_backend_pkg_version / sync_android_version
    # 修改了 package.json 或 android/build.gradle，一并 commit，这样 git tag 会落在
    # "版本号已更新"的 commit 上。
    CHANGED_FILES=()
    if [ -n "$(git status --porcelain -- package.json 2>/dev/null)" ]; then
        CHANGED_FILES+=( "package.json" )
    fi
    if [ -n "$(git status --porcelain -- backend/package.json 2>/dev/null)" ]; then
        CHANGED_FILES+=( "backend/package.json" )
    fi
    if [ -n "$(git status --porcelain -- frontend/android/app/build.gradle 2>/dev/null)" ]; then
        CHANGED_FILES+=( "frontend/android/app/build.gradle" )
    fi
    # 由 generate-changelog.mjs 产生的 4 个文件，存在变更就一起进 commit
    for f in CHANGELOG.md README.md README.en.md frontend/public/changelog.json; do
        if [ -n "$(git status --porcelain -- "$f" 2>/dev/null)" ]; then
            CHANGED_FILES+=( "$f" )
        fi
    done
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

    # 通常 release 必须依附在 git tag 上，所以 --github-release 默认要求 DO_GIT_TAG=1。
    # 但有一种合法例外：选项 10（补 upk）—— tag 已经在远端 + Release 也已创建，
    # 这次只是想把 .upk 作为 asset 追加上去。此时 DO_GIT_TAG=0 是正确的，
    # 但必须先确认远端 tag 真的存在，否则后面 gh release upload 会失败。
    if [ "$DO_GIT_TAG" != "1" ]; then
        if git ls-remote --tags origin "refs/tags/${VERSION_TAG}" 2>/dev/null | grep -q "${VERSION_TAG}"; then
            info "DO_GIT_TAG=0 但远端 tag ${VERSION_TAG} 已存在，将走 'upload-only' 模式（追加 asset 到已有 Release）"
        else
            die "--github-release 需要同时打 git tag（远端也找不到 ${VERSION_TAG}，无法挂 Release）"
        fi
    fi

    # ---- 确保 gh CLI 可用（未安装则自动安装） ----
    if ! command -v gh >/dev/null 2>&1; then
        info "gh CLI 未安装，尝试自动安装..."
        if command -v apt-get >/dev/null 2>&1; then
            # Debian / Ubuntu
            (type -p wget >/dev/null || (sudo apt-get update && sudo apt-get install -y wget)) \
            && sudo mkdir -p -m 755 /etc/apt/keyrings \
            && wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg \
                | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null \
            && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
            && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
                | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null \
            && sudo apt-get update \
            && sudo apt-get install -y gh
        elif command -v dnf >/dev/null 2>&1; then
            sudo dnf install -y gh
        elif command -v brew >/dev/null 2>&1; then
            brew install gh
        else
            die "无法自动安装 gh CLI，请手动安装：https://cli.github.com/"
        fi
        command -v gh >/dev/null 2>&1 || die "gh CLI 安装失败，请手动安装：https://cli.github.com/"
        ok "gh CLI 安装成功"
    fi

    # ---- 确保 gh 已认证 ----
    # gh 登录状态或 GH_TOKEN 任一满足即可
    if ! gh auth status >/dev/null 2>&1 && [ -z "${GH_TOKEN:-}" ]; then
        # 尝试用 git remote 的凭据自动登录
        if git remote get-url origin 2>/dev/null | grep -q "github.com"; then
            warn "gh 未登录。请运行 'gh auth login' 登录，或设置 GH_TOKEN 环境变量"
            warn "提示：可以用 'echo \$YOUR_TOKEN | gh auth login --with-token' 非交互式登录"
        fi
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
        # 优先取 generate-changelog.mjs --section 的输出（本版分组好的 markdown），
        # 失败则退回到原始的 metadata 摘要。
        # 这里走到时 HEAD 上很可能已经打了 v${VERSION} tag（tag step 在本步前完成），
        # 所以必须显式传 --since 来绕开 HEAD^ 陷阱，避免把上个版本的 commits 再重复收一遍。
        AUTO_NOTES=""
        if [ -f "$GEN_CHANGELOG_SCRIPT" ]; then
            NOTES_SINCE_TAG="$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname 2>/dev/null \
                | grep -v -x "v${VERSION}" \
                | head -n1 || true)"
            SECTION_ARGS=( --version "$VERSION" --section )
            [ -n "$NOTES_SINCE_TAG" ] && SECTION_ARGS+=( --since "$NOTES_SINCE_TAG" )
            CHANGELOG_SECTION="$(node "$GEN_CHANGELOG_SCRIPT" "${SECTION_ARGS[@]}" 2>/dev/null || true)"
            if [ -n "$CHANGELOG_SECTION" ]; then
                AUTO_NOTES="$CHANGELOG_SECTION"$'\n\n---\n'
            fi
        fi
        AUTO_NOTES+="Release ${VERSION_TAG}"$'\n\n'"Targets: ${TARGETS}"
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
    [ "${#FPK_ARTIFACTS[@]}" -gt 0 ]     && ALL_ASSETS+=( "${FPK_ARTIFACTS[@]}" )
    [ "${#UPK_ARTIFACTS[@]}" -gt 0 ]     && ALL_ASSETS+=( "${UPK_ARTIFACTS[@]}" )
    [ "${#LITE_ARTIFACTS[@]}" -gt 0 ]    && ALL_ASSETS+=( "${LITE_ARTIFACTS[@]}" )
    [ "${#CLIPPER_ARTIFACTS[@]}" -gt 0 ] && ALL_ASSETS+=( "${CLIPPER_ARTIFACTS[@]}" )

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
if [ "$HAS_FPK" = "1" ] && [ "${#FPK_ARTIFACTS[@]}" -gt 0 ]; then
    echo "  ${C_GREEN}飞牛 .fpk 产物${C_RESET}："
    for f in "${FPK_ARTIFACTS[@]}"; do
        echo "    - $(basename "$f")"
    done
fi
if [ "$HAS_UPK" = "1" ] && [ "${#UPK_ARTIFACTS[@]}" -gt 0 ]; then
    echo "  ${C_GREEN}绿联 .upk 产物${C_RESET}（${#UPK_ARTIFACTS[@]} 个）："
    for f in "${UPK_ARTIFACTS[@]}"; do
        echo "    - $(basename "$f")"
    done
fi
if [ "$HAS_LITE" = "1" ] && [ "${#LITE_ARTIFACTS[@]}" -gt 0 ]; then
    echo "  ${C_GREEN}Lite 版产物${C_RESET}（${#LITE_ARTIFACTS[@]} 个）："
    for f in "${LITE_ARTIFACTS[@]}"; do
        echo "    - $(basename "$f")"
    done
fi
if [ "$HAS_CLIPPER" = "1" ] && [ "${#CLIPPER_ARTIFACTS[@]}" -gt 0 ]; then
    echo "  ${C_GREEN}浏览器扩展产物${C_RESET}："
    for f in "${CLIPPER_ARTIFACTS[@]}"; do
        echo "    - $(basename "$f")"
    done
fi
[ "$DO_GIT_TAG" = "1" ] && echo "  ${C_GREEN}git tag ${VERSION_TAG}${C_RESET}  ←  已推送到 GitHub"
[ -n "$RELEASE_URL" ]   && echo "  ${C_GREEN}GitHub Release${C_RESET}  ←  ${RELEASE_URL}"

echo "  总耗时        : ${TOTAL}s  (docker:${BUILD_DURATION}s push:${PUSH_DURATION}s pc:${PC_BUILD_DURATION}s android:${ANDROID_BUILD_DURATION}s fpk:${FPK_BUILD_DURATION}s upk:${UPK_BUILD_DURATION}s lite:${LITE_BUILD_DURATION}s clipper:${CLIPPER_BUILD_DURATION}s)"
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
