# =============================================================================
# nowen-note 多架构 Dockerfile（Alpine 精简版）
# =============================================================================
ARG TARGETARCH=amd64

# ---------- sqlite-vec: 按目标架构编译 musl 扩展（npm Linux 预编译包使用 glibc） ----------
FROM node:20-alpine AS sqlite-vec-build
WORKDIR /build
RUN apk add --no-cache build-base curl sqlite-dev
# 与 backend/package-lock.json 中的 sqlite-vec 版本一致；源码固定校验和。
# v0.1.9 的 BSD u_int*_t 别名不适用于 musl；使用源码已包含的 stdint.h 类型。
RUN curl -fSL --retry 3 https://github.com/asg017/sqlite-vec/releases/download/v0.1.9/sqlite-vec-0.1.9-amalgamation.tar.gz -o sqlite-vec.tar.gz \
    && echo "3acd67cb4aff080c7050926fd3cf8227905fe5b7ee3829d8ee5024ab1283cf61  sqlite-vec.tar.gz" | sha256sum -c - \
    && tar -xzf sqlite-vec.tar.gz \
    && sed -i '/^typedef u_int[0-9]*_t uint[0-9]*_t;$/d' sqlite-vec.c \
    && cc -O3 -fPIC -shared sqlite-vec.c -o vec0.so -lm

# ---------- Stage 1: 前端构建 ----------
FROM --platform=$BUILDPLATFORM node:20-alpine AS frontend-build
ARG TARGETARCH
WORKDIR /app/frontend

COPY package.json /app/package.json
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund

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
COPY scripts/precompress-frontend.mjs /app/scripts/precompress-frontend.mjs
COPY scripts/verify-sync-notification-ui.cjs /app/scripts/verify-sync-notification-ui.cjs
# Web/Docker 产物生成 .br/.gz；Electron 与 Capacitor 继续使用普通 build，避免安装包重复携带压缩副本。
RUN NODE_OPTIONS=--max-old-space-size=4096 npm run build:web

# ---------- Stage 2: 后端构建（包含 updater 专用入口） ----------
FROM node:20-alpine AS backend-build
WORKDIR /app/backend
RUN apk add --no-cache --virtual .build-deps python3 make g++ linux-headers
RUN apk add --no-cache ffmpeg
COPY backend/package.json backend/package-lock.json ./
RUN FFMPEG_BIN=/usr/bin/ffmpeg npm ci --no-audit --no-fund
COPY backend/ .
RUN npx tsc \
    && cp src/plugins/runner-child.mjs src/plugins/sandbox-child.mjs dist/plugins/
RUN apk del .build-deps

# ---------- Stage 3: 运行时镜像 ----------
FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache tini tzdata ffmpeg

COPY package.json ./package.json
COPY backend/package.json backend/package-lock.json ./backend/
RUN apk add --no-cache --virtual .build-deps python3 make g++ linux-headers \
    && cd backend && FFMPEG_BIN=/usr/bin/ffmpeg npm ci --omit=dev --no-audit --no-fund \
    && apk del .build-deps \
    && npm cache clean --force \
    && rm -rf /root/.npm /tmp/* /var/cache/apk/*

COPY --from=backend-build /app/backend/dist ./backend/dist
COPY backend/templates ./backend/templates
COPY --from=frontend-build /app/frontend/dist ./frontend/dist
COPY backend/scripts/smoke-plugin-artifacts.cjs ./backend/scripts/smoke-plugin-artifacts.cjs
COPY --from=sqlite-vec-build /build/vec0.so /tmp/vec0.so
COPY backend/scripts/smoke-sqlite-vec.cjs ./backend/scripts/smoke-sqlite-vec.cjs
# 保持 sqlite-vec 的标准加载路径，同时兼容 amd64/arm64 npm 平台包。
RUN cd backend \
    && node -e "require('node:fs').copyFileSync('/tmp/vec0.so', require('sqlite-vec').getLoadablePath())" \
    && rm /tmp/vec0.so \
    && node scripts/smoke-sqlite-vec.cjs
# 仅使用生产依赖与 dist；没有 src，避免开发入口兜底掩盖遗漏的运行器。
RUN node backend/scripts/smoke-plugin-artifacts.cjs

RUN mkdir -p /app/data /var/lib/nowen-updater \
    && chmod 700 /var/lib/nowen-updater
VOLUME ["/app/data"]

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ARG BUILD_DATE=""
ARG APP_VERSION=""
ARG VCS_REF=""
ENV NOWEN_BUILD_TIME=${BUILD_DATE}
ENV NOWEN_APP_VERSION=${APP_VERSION}
LABEL org.opencontainers.image.title="Nowen Note" \
      org.opencontainers.image.description="Self-hosted note and knowledge management" \
      org.opencontainers.image.source="https://github.com/cropflre/nowen-note" \
      org.opencontainers.image.version=${APP_VERSION} \
      org.opencontainers.image.created=${BUILD_DATE} \
      org.opencontainers.image.revision=${VCS_REF} \
      com.nowen-note.schema-metadata="runtime-api"

ENV NODE_ENV=production
ENV DB_PATH=/app/data/nowen-note.db
ENV PORT=3001
ENV FFMPEG_PATH=/usr/bin/ffmpeg

EXPOSE 3001

# 主应用的容器级健康检查。必须读取运行时 PORT：NAS 面板可能把容器内部端口
# 配置为 53001 等非默认值，固定检查 3001 会让正常服务被误判为 unhealthy。
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=12 \
  CMD node -e "const p=process.env.PORT||'3001';fetch('http://127.0.0.1:'+p+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

WORKDIR /app
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
# 必须从 hardened 入口启动，确保自动全量备份等运行时补丁在 Docker 生产环境生效。
CMD ["node", "backend/dist/index.hardened.js"]
