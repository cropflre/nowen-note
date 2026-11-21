# syntax=docker/dockerfile:1
# =============================================================================
# nowen-note 多架构 Dockerfile（Alpine 精简版）
# =============================================================================
ARG TARGETARCH=amd64

# ---------- sqlite-vec: 按目标架构编译 musl 扩展（npm Linux 预编译包使用 glibc） ----------
FROM node:24.22.1-alpine3.23 AS sqlite-vec-build
WORKDIR /build
RUN apk add --no-cache build-base curl sqlite-dev
# 与 backend/package-lock.json 中的 sqlite-vec 版本一致；源码固定校验和。
# v0.1.9 的 BSD u_int*_t 别名不适用于 musl；使用源码已包含的 stdint.h 类型。
RUN --mount=type=secret,id=github_token,required=false \
    if [ -s /run/secrets/github_token ]; then \
      curl -fsSL --retry 5 --retry-all-errors --retry-delay 2 --connect-timeout 15 --max-time 120 \
        -H "Accept: application/octet-stream" \
        -H "Authorization: Bearer $(cat /run/secrets/github_token)" \
        https://api.github.com/repos/asg017/sqlite-vec/releases/assets/385377719 -o sqlite-vec.tar.gz; \
    else \
      curl -fsSL --retry 5 --retry-all-errors --retry-delay 2 --connect-timeout 15 --max-time 120 \
        -H "Accept: application/octet-stream" \
        https://api.github.com/repos/asg017/sqlite-vec/releases/assets/385377719 -o sqlite-vec.tar.gz; \
    fi \
    && echo "3acd67cb4aff080c7050926fd3cf8227905fe5b7ee3829d8ee5024ab1283cf61  sqlite-vec.tar.gz" | sha256sum -c - \
    && tar -xzf sqlite-vec.tar.gz \
    && sed -i '/^typedef u_int[0-9]*_t uint[0-9]*_t;$/d' sqlite-vec.c \
    && cc -O3 -fPIC -shared sqlite-vec.c -o vec0.so -lm

# ---------- ffmpeg: 只编译动态照片转码用到的组件 ----------
# 后端只用 ffmpeg 把实况/动态照片里的 MOV/MP4 转成 H.264/AAC MP4（backend/src/services/modern-media.ts）。
# Alpine 的 ffmpeg 包会连带 x265、AV1、Vulkan、字幕渲染等约 97MB 依赖；精简版约 8MB。
# 版本与 Alpine 3.23 的 ffmpeg 8.0.1 相同；源码 SHA-256 已与 aports 记录的 SHA-512 交叉核对。
# 滤镜除了命令里的 scale/format，还包括 ffmpeg 自动插入的：-t 用 trim/atrim，按显示矩阵
# 旋转用 transpose/hflip/vflip/rotate，容器裁剪用 crop，格式转换用 aformat/aresample，无滤镜时用 null/anull。
FROM alpine:3.23 AS ffmpeg-build
WORKDIR /build
RUN apk add --no-cache build-base curl nasm pkgconf x264-dev zlib-dev
RUN curl -fsSL --retry 5 --retry-all-errors --retry-delay 2 --connect-timeout 15 --max-time 300 \
      https://ffmpeg.org/releases/ffmpeg-8.0.1.tar.xz -o ffmpeg.tar.xz \
    && echo "05ee0b03119b45c0bdb4df654b96802e909e0a752f72e4fe3794f487229e5a41  ffmpeg.tar.xz" | sha256sum -c - \
    && tar -xJf ffmpeg.tar.xz --strip-components=1 \
    && ./configure \
      --disable-everything --disable-autodetect --disable-doc --disable-debug \
      --disable-ffplay --disable-ffprobe --disable-avdevice --disable-network \
      --enable-gpl --enable-libx264 --enable-pthreads --enable-zlib \
      --enable-protocol=file,pipe \
      --enable-demuxer=mov \
      --enable-muxer=mp4 \
      --enable-decoder=h263,h264,hevc,mjpeg,mpeg4,vp8,vp9,aac,aac_fixed,aac_latm,alac,amrnb,amrwb,flac,mp3,mp3float,opus,vorbis,pcm_alaw,pcm_mulaw,pcm_s16be,pcm_s16le,pcm_s24be,pcm_s24le,pcm_s32be,pcm_s32le,pcm_f32be,pcm_f32le,pcm_u8 \
      --enable-parser=h263,h264,hevc,mjpeg,mpeg4video,vp8,vp9,aac,aac_latm,flac,mpegaudio,opus,vorbis \
      --enable-encoder=libx264,aac \
      --enable-filter=aformat,anull,aresample,atrim,crop,format,hflip,null,rotate,scale,transpose,trim,vflip \
      --optflags=-O3 \
    && make -j"$(nproc)" ffmpeg \
    && strip ffmpeg

# ---------- Stage 1: 前端构建 ----------
FROM --platform=$BUILDPLATFORM node:24.22.1-alpine3.23 AS frontend-build
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
COPY backend/src/lib/aiContentProvenance.ts /app/backend/src/lib/aiContentProvenance.ts
COPY scripts/precompress-frontend.mjs /app/scripts/precompress-frontend.mjs
COPY scripts/verify-sync-notification-ui.cjs /app/scripts/verify-sync-notification-ui.cjs
# In-app What's New is generated from curated release notes during frontend build.
# The Docker builder must contain the same build-time inputs as desktop packaging.
COPY scripts/generate-changelog.mjs scripts/verify-in-app-changelog.mjs /app/scripts/
COPY docs/releases/in-app-changelog.json /app/docs/releases/in-app-changelog.json
COPY CHANGELOG.md /app/CHANGELOG.md
# Web/Docker 产物生成 .br/.gz；Electron 与 Capacitor 继续使用普通 build，避免安装包重复携带压缩副本。
RUN NODE_OPTIONS=--max-old-space-size=4096 npm run build:web

# ---------- Stage 2: 后端构建（包含 updater 专用入口） ----------
# 只编译 TypeScript，与架构无关；运行时依赖由 backend-deps 按目标架构安装。类型声明运行时用不到。
FROM --platform=$BUILDPLATFORM node:24.22.1-alpine3.23 AS backend-build
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY backend/ .
RUN npx tsc --declaration false \
    && cp src/plugins/runner-child.mjs src/plugins/sandbox-child.mjs dist/plugins/

# ---------- 后端生产依赖：按目标架构安装，只保留运行时需要的文件 ----------
FROM node:24.22.1-alpine3.23 AS backend-deps
WORKDIR /app/backend
# 官方 musl 版 node 带完整符号表（约 18MB）；剥离后仍保留原生模块链接所需的动态符号。
RUN apk add --no-cache python3 make g++ linux-headers \
    && strip /usr/local/bin/node
COPY backend/package.json backend/package-lock.json ./
# ffmpeg-static 的安装脚本会下载一份完整 ffmpeg，而镜像用 FFMPEG_PATH 指向上面的精简版，
# 所以跳过安装脚本，只为两个原生模块单独执行。
# 锁文件没有记录 libc，Alpine 上会连 glibc 版 sharp/libvips 一起装（约 16MB），musl 用不到。
# better-sqlite3 的 SQLite/C++ 源码只在编译时使用；@types、文档、source map、TS 源码运行时都不加载。
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm rebuild better-sqlite3 sharp \
    && rm -rf node_modules/@img/sharp-linux-* node_modules/@img/sharp-libvips-linux-* \
       node_modules/better-sqlite3/deps node_modules/better-sqlite3/src node_modules/@types \
    && find node_modules -type f \( -name '*.md' -o -name '*.markdown' -o -name '*.map' \
       -o -name '*.ts' -o -name '*.mts' -o -name '*.cts' \) ! -iname 'licen[cs]e*' -delete
COPY --from=sqlite-vec-build /build/vec0.so /tmp/vec0.so
# 保持 sqlite-vec 的标准加载路径，同时兼容 amd64/arm64 npm 平台包。
RUN node -e "require('node:fs').copyFileSync('/tmp/vec0.so', require('sqlite-vec').getLoadablePath())"

# ---------- MCP: optional embedded HTTP transport ----------
FROM --platform=$BUILDPLATFORM node:24.22.1-alpine3.23 AS mcp-build
WORKDIR /app/packages/nowen-mcp
COPY packages/nowen-mcp/package.json packages/nowen-mcp/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY packages/nowen-mcp/src ./src
COPY packages/nowen-mcp/tsconfig.json ./
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

# ---------- Stage 3: 运行时镜像 ----------
# 基于纯 Alpine，只从 node 镜像拷 node 可执行文件：npm、yarn、corepack 和 C 头文件运行时用不到（约 33MB）。
# 保留官方 node 镜像的 node 用户（uid/gid 1000），兼容以 --user node 运行的部署。
FROM alpine:3.23
RUN addgroup -g 1000 node \
    && adduser -u 1000 -G node -s /bin/sh -D node \
    && apk add --no-cache libstdc++ tini tzdata x264-libs
COPY --from=backend-deps /usr/local/bin/node /usr/local/bin/node
COPY --from=ffmpeg-build /build/ffmpeg /usr/bin/ffmpeg
WORKDIR /app

COPY package.json ./package.json
COPY backend/package.json backend/package-lock.json ./backend/
COPY --from=backend-deps /app/backend/node_modules ./backend/node_modules
COPY --from=backend-build /app/backend/dist ./backend/dist
COPY --from=mcp-build /app/packages/nowen-mcp/package.json ./packages/nowen-mcp/package.json
COPY --from=mcp-build /app/packages/nowen-mcp/dist ./packages/nowen-mcp/dist
COPY --from=mcp-build /app/packages/nowen-mcp/node_modules ./packages/nowen-mcp/node_modules
COPY backend/templates ./backend/templates
COPY --from=frontend-build /app/frontend/dist ./frontend/dist
COPY backend/scripts/smoke-plugin-artifacts.cjs backend/scripts/smoke-sqlite-vec.cjs ./backend/scripts/
# 在最终镜像里确认原生模块、sqlite-vec 扩展和 ffmpeg 的动态库都齐全。
RUN node backend/scripts/smoke-sqlite-vec.cjs \
    && node -e "require('./backend/node_modules/sharp')" \
    && ffmpeg -hide_banner -version > /dev/null
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
# Refuse an image tagged as a new release when its packaged server is still old.
RUN node -e 'const app=require("./package.json").version; const backend=require("./backend/package.json").version; const expected=(process.env.APP_VERSION||app).replace(/^v/, ""); if(app!==expected||backend!==expected) throw new Error("Docker version mismatch: "+JSON.stringify({app,backend,expected}))'
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
