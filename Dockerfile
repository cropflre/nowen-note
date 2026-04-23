# =============================================================================
# nowen-note 多架构 Dockerfile
# -----------------------------------------------------------------------------
# 支持 linux/amd64 与 linux/arm64（aarch64）。典型 arm64 目标设备：
#   - Amlogic A311D（Cortex-A73 + A53）
#   - Rockchip RK3566（Cortex-A55）
#   - 基于 Debian/Ubuntu 的 OES / Armbian / OpenKylin 发行版
#
# 构建方式（x86 主机交叉构建）：
#   docker buildx build --platform linux/arm64 -t nowen-note:arm64 --load .
#   或用统一脚本：scripts/release.sh --build-only --arch arm64
#
# 关键设计：
#   - 使用 BuildKit 自动注入的 TARGETARCH 选择正确的 rollup 原生二进制；
#     旧版本写死 @rollup/rollup-linux-x64-gnu 会导致 arm64 构建中 vite 报
#     "Cannot find module @rollup/rollup-linux-x64-gnu"。
#   - better-sqlite3 不提供预编译 arm64 二进制（至少本项目锁定的版本没命中），
#     会在 npm ci 时触发 node-gyp 本地编译；因此无论哪条流水线都保留
#     python3/make/g++ 工具链，安装完再清理以缩小镜像。
#   - QEMU 模拟 arm64 构建 better-sqlite3 会显著变慢（数分钟级别），属于预期。
# =============================================================================

# BuildKit 自动传入的变量。未启用 buildx 时 TARGETARCH 为空，回退到 amd64。
ARG TARGETARCH=amd64

# ---------- Stage 1: 前端构建 ----------
FROM --platform=$BUILDPLATFORM node:20-slim AS frontend-build
ARG TARGETARCH
WORKDIR /app/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

# 按目标架构补装 rollup 的原生绑定。
# 原因：package-lock.json 可能来自 Windows/Mac，不包含 Linux 原生可选依赖；
# 而 vite 4.x+ 用的 rollup 需要对应平台的 N-API 绑定才能启动。
# 用 $TARGETARCH 而不是写死 x64，确保 arm64 构建也能拿到 @rollup/rollup-linux-arm64-gnu。
RUN case "$TARGETARCH" in \
      amd64) ROLLUP_PKG="@rollup/rollup-linux-x64-gnu" ;; \
      arm64) ROLLUP_PKG="@rollup/rollup-linux-arm64-gnu" ;; \
      *)     ROLLUP_PKG="" ;; \
    esac; \
    if [ -n "$ROLLUP_PKG" ]; then \
      npm install "$ROLLUP_PKG" --save-optional 2>/dev/null || true; \
    fi

COPY frontend/ .
# 这一步完全发生在 BUILDPLATFORM（x86 主机），速度快；产物是纯静态 JS/CSS，架构无关。
RUN npx vite build

# ---------- Stage 2: 后端构建 ----------
# 使用 TARGETPLATFORM：tsc 本身虽然也架构无关，但 npm ci 会下载 better-sqlite3
# 的原生依赖；让它在目标架构下跑，产物才能原生加载。
FROM node:20-slim AS backend-build
WORKDIR /app/backend
# 安装原生模块编译工具链（better-sqlite3 需要）
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/ .
RUN npx tsc

# ---------- Stage 3: 运行时镜像 ----------
FROM node:20-slim
WORKDIR /app

# 安装原生模块编译工具链，安装依赖后清理；
# 在 arm64（QEMU 模拟）下这一步是最慢的，但是一次性的。
COPY backend/package.json backend/package-lock.json ./backend/
RUN apt-get update && apt-get install -y python3 make g++ \
    && cd backend && npm ci --omit=dev \
    && apt-get purge -y python3 make g++ && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* /root/.npm /tmp/*

COPY --from=backend-build /app/backend/dist ./backend/dist
COPY backend/templates ./backend/templates
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

RUN mkdir -p /app/data

# 启动脚本：首启自动生成并持久化 JWT_SECRET，使镜像开箱即用（同时保持安全基线）
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
ENV DB_PATH=/app/data/nowen-note.db
ENV PORT=3001

EXPOSE 3001

WORKDIR /app
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "backend/dist/index.js"]
