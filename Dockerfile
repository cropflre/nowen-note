# =============================================================================
# nowen-note 多架构 Dockerfile（Alpine 精简版）
# -----------------------------------------------------------------------------
# 支持 linux/amd64 与 linux/arm64。较旧的 slim 版本镜像约 238MB，
# 改用 alpine 基座 + 构建工具链 virtual 卸载 + musl 原生编译后约 85–95MB。
#
# 关键设计：
#   - 基础镜像：node:20-alpine（~42MB），而非 node:20-slim（~150MB）
#   - better-sqlite3 / sqlite-vec 在 musl 下需要本地编译 → 用 --virtual
#     安装构建链，npm ci 完立即 `apk del`，不留任何构建产物在运行层
#   - rollup 的原生绑定根据 TARGETARCH 选 musl 版（linux-*-musl）而不是 gnu
#   - QEMU 模拟 arm64 编译 better-sqlite3 仍然会慢，属预期
# =============================================================================

ARG TARGETARCH=amd64

# ---------- Stage 1: 前端构建 ----------
FROM --platform=$BUILDPLATFORM node:20-alpine AS frontend-build
ARG TARGETARCH
WORKDIR /app/frontend

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
FROM node:20-alpine AS backend-build
WORKDIR /app/backend

# tsc 纯 JS 架构无关，但 npm ci 会触发 better-sqlite3 / sqlite-vec 编译
RUN apk add --no-cache --virtual .build-deps python3 make g++ linux-headers

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY backend/ .
RUN npx tsc

# build-deps 在这个 stage 用不着保留，最终运行时镜像会从 runtime stage 重新编译
RUN apk del .build-deps

# ---------- Stage 3: 运行时镜像 ----------
FROM node:20-alpine
WORKDIR /app

# tini 提供 PID 1 信号转发，15KB，避免容器 kill 时僵尸进程
RUN apk add --no-cache tini

# 运行时依赖（production only）：独立编译一次，确保 .node 是 musl 版
# 根 package.json 是运行时版本号的真相源；/api/version 优先读取它，避免 NAS / 应用市场
# 更新时复用旧容器 ENV（NOWEN_APP_VERSION）导致服务端版本号停在旧值。
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

# 数据卷（见原 Dockerfile 注释：便于 NAS 面板自动识别）
VOLUME ["/app/data"]

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# ---- 版本/构建元信息（由 release.sh 通过 --build-arg 注入；本机 docker build 也兼容空值） ----
# BUILD_DATE   : ISO8601 UTC，如 2026-05-09T10:23:01Z；run-time 通过 NOWEN_BUILD_TIME 暴露给 /api/version
# APP_VERSION  : 形如 1.0.31，写入 NOWEN_APP_VERSION 兜底（即便镜像里 package.json 与发版号偏差也不会报错）
# 这两个 ARG 都是可选的——空字符串场景下后端 resolveAppVersion()/resolveBuildTime() 仍会走原有 fallback。
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
