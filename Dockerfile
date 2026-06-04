# =============================================================================
# nowen-note 多架构 Dockerfile（Alpine 精简版）
# -----------------------------------------------------------------------------
# 支持 linux/amd64 与 linux/arm64，macOS（Apple Silicon + Intel）均可原生构建。
#
# 构建方式：
#   # macOS Apple Silicon → arm64（默认，最快，无需 QEMU）
#   docker build -t nowen-note .
#
#   # macOS Intel / Linux x86 → amd64
#   docker build -t nowen-note .
#
#   # 显式指定架构
#   docker build --platform linux/amd64 -t nowen-note .
#   docker build --platform linux/arm64 -t nowen-note .
#
#   # 多架构 manifest
#   docker buildx build --platform linux/amd64,linux/arm64 -t nowen-note --push .
#
# 关键设计：
#   - 基础镜像：node:20-alpine（~42MB），而非 node:20-slim（~150MB）
#   - better-sqlite3 / sqlite-vec 在 musl 下需要本地编译 → 用 --virtual
#     安装构建链，npm ci 完立即 `apk del`，不留任何构建产物在运行层
#   - rollup 的原生绑定根据 TARGETARCH 选 musl 版（linux-*-musl）而不是 gnu
#   - APK_MIRROR 与 NPM_REGISTRY 可配置，中国大陆用户换成国内镜像加速
# =============================================================================

# Docker 镜像源：中国大陆用户可设为 docker.m.daocloud.io/ 加速
# 通过 docker build --build-arg DOCKER_REGISTRY=docker.m.daocloud.io/ ... 传入
ARG DOCKER_REGISTRY=""
ARG TARGETPLATFORM=
ARG TARGETARCH=

# ---------- 镜像源配置 ----------
# 中国大陆用户可设置：
#   docker build --build-arg APK_MIRROR=mirrors.ustc.edu.cn --build-arg NPM_REGISTRY=https://registry.npmmirror.com ...
# 或通过 docker-compose.yml 的 args 传入。
# 默认留空 → 使用 Alpine / npm 官方源（全球 CDN，对 macOS 友好）。
ARG APK_MIRROR=""
ARG NPM_REGISTRY=""

# ---------- Stage 1: 前端构建 ----------
FROM --platform=$BUILDPLATFORM ${DOCKER_REGISTRY}node:20-alpine AS frontend-build
ARG TARGETARCH
ARG APK_MIRROR
ARG NPM_REGISTRY
WORKDIR /app/frontend

# 配置包管理器镜像源（仅在指定时切换，否则用官方源）
RUN if [ -n "$APK_MIRROR" ]; then \
      sed -i 's/https/http/g' /etc/apk/repositories \
      && sed -i "s/dl-cdn.alpinelinux.org/$APK_MIRROR/g" /etc/apk/repositories; \
    fi \
    && if [ -n "$NPM_REGISTRY" ]; then \
      npm config set registry "$NPM_REGISTRY"; \
    fi \
    && npm config set fetch-retry-maxtimeout 180000 \
    && npm config set fetch-retry-mintimeout 20000 \
    && npm config set fetch-retries 5 \
    && npm config set fetch-timeout 600000

# 根 package.json 被 vite.config.ts 读取用于注入 __APP_VERSION__
COPY package.json /app/package.json

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund

# rollup 原生绑定按目标架构选 musl 版（alpine 必须 musl，不能用 gnu）
RUN ROLLUP_VER=$(node -e "try{const l=require('./package-lock.json');const v=(l.packages||{})['node_modules/rollup']||(l.dependencies||{}).rollup||{};console.log(v.version||'')}catch(e){console.log('')}") && \
    [ -z "$ROLLUP_VER" ] && ROLLUP_VER="4.59.0" ; \
    case "$TARGETARCH" in \
      amd64) ROLLUP_PKG="@rollup/rollup-linux-x64-musl@${ROLLUP_VER}" ;; \
      arm64) ROLLUP_PKG="@rollup/rollup-linux-arm64-musl@${ROLLUP_VER}" ;; \
      *)     ROLLUP_PKG="" ;; \
    esac; \
    if [ -n "$ROLLUP_PKG" ]; then \
      echo "Installing $ROLLUP_PKG ..." && \
      npm install "$ROLLUP_PKG" --save-optional --no-audit --no-fund 2>/dev/null || true; \
    fi

COPY frontend/ .
RUN npx vite build

# ---------- Stage 2: 后端构建（tsc） ----------
FROM --platform=$BUILDPLATFORM ${DOCKER_REGISTRY}node:20-alpine AS backend-build
ARG APK_MIRROR
ARG NPM_REGISTRY
WORKDIR /app/backend

# 配置镜像源（同 Stage 1）
RUN if [ -n "$APK_MIRROR" ]; then \
      sed -i 's/https/http/g' /etc/apk/repositories \
      && sed -i "s/dl-cdn.alpinelinux.org/$APK_MIRROR/g" /etc/apk/repositories; \
    fi \
    && if [ -n "$NPM_REGISTRY" ]; then \
      npm config set registry "$NPM_REGISTRY"; \
    fi \
    && npm config set fetch-retry-maxtimeout 180000 \
    && npm config set fetch-retry-mintimeout 20000 \
    && npm config set fetch-retries 5 \
    && npm config set fetch-timeout 600000

# tsc 纯 JS 架构无关，但 npm ci 会触发 better-sqlite3 / sqlite-vec 编译
RUN apk add --no-cache --virtual .build-deps python3 make g++ linux-headers

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY backend/ .
RUN npx tsc

# build-deps 在这个 stage 用不着保留，最终运行时镜像会从 runtime stage 重新编译
RUN apk del .build-deps

# ---------- Stage 3: 运行时镜像 ----------
# 默认使用主机架构（`docker build`）；跨架构构建请用 buildx
FROM ${DOCKER_REGISTRY}node:20-alpine
ARG APK_MIRROR
ARG NPM_REGISTRY
WORKDIR /app

# 配置镜像源
RUN if [ -n "$APK_MIRROR" ]; then \
      sed -i 's/https/http/g' /etc/apk/repositories \
      && sed -i "s/dl-cdn.alpinelinux.org/$APK_MIRROR/g" /etc/apk/repositories; \
    fi \
    && if [ -n "$NPM_REGISTRY" ]; then \
      npm config set registry "$NPM_REGISTRY"; \
    fi \
    && npm config set fetch-retry-maxtimeout 180000 \
    && npm config set fetch-retry-mintimeout 20000 \
    && npm config set fetch-retries 5 \
    && npm config set fetch-timeout 600000

# tini 提供 PID 1 信号转发，15KB，避免容器 kill 时僵尸进程
# docker-cli 用于按需启停 SenseVoice 容器
RUN apk add --no-cache tini docker-cli

# 运行时依赖（production only）：独立编译一次，确保 .node 是正确架构的 musl 版
# 根 package.json 是运行时版本号的真相源
COPY package.json ./package.json
COPY backend/package.json backend/package-lock.json ./backend/
RUN apk add --no-cache --virtual .build-deps python3 make g++ linux-headers \
    && cd backend && npm ci --omit=dev --no-audit --no-fund \
    && apk del .build-deps \
    && npm cache clean --force \
    && rm -rf /root/.npm /tmp/* /var/cache/apk/*

COPY --from=backend-build /app/backend/dist ./backend/dist
COPY backend/templates ./backend/templates
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

RUN mkdir -p /app/data

# 数据卷（便于 NAS 面板自动识别）
VOLUME ["/app/data"]

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# ---- 版本/构建元信息 ----
ARG BUILD_DATE=""
ARG APP_VERSION=""
ENV NOWEN_BUILD_TIME=${BUILD_DATE}
ENV NOWEN_APP_VERSION=${APP_VERSION}

ENV NODE_ENV=production
ENV DB_PATH=/app/data/nowen-note.db
ENV PORT=3001

EXPOSE 3001

WORKDIR /app
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "backend/dist/index.js"]
