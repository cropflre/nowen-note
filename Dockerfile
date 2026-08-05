# =============================================================================
# nowen-note 多架构 Dockerfile（Alpine 精简版）
# =============================================================================
ARG TARGETARCH=amd64

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
# Web/Docker 产物生成 .br/.gz；Electron 与 Capacitor 继续使用普通 build，避免安装包重复携带压缩副本。
RUN npm run build:web

# ---------- Stage 2: 后端构建（包含 updater 专用入口） ----------
FROM node:20-alpine AS backend-build
WORKDIR /app/backend
RUN apk add --no-cache --virtual .build-deps python3 make g++ linux-headers
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY backend/ .
RUN npx tsc
RUN apk del .build-deps

# ---------- Stage 3: 运行时镜像 ----------
FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache tini tzdata

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

EXPOSE 3001

# 主应用的容器级健康检查。必须读取运行时 PORT：NAS 面板可能把容器内部端口
# 配置为 53001 等非默认值，固定检查 3001 会让正常服务被误判为 unhealthy。
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=12 \
  CMD node -e "const p=process.env.PORT||'3001';fetch('http://127.0.0.1:'+p+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

WORKDIR /app
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
# 必须从 hardened 入口启动，确保自动全量备份等运行时补丁在 Docker 生产环境生效。
CMD ["node", "backend/dist/index.hardened.js"]
