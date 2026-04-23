# Stage 1: Build frontend
FROM node:20-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
# 补装当前平台(Linux)的 rollup 原生绑定，因为 lock 文件可能来自其他平台(Windows/Mac)
RUN npm install @rollup/rollup-linux-x64-gnu --save-optional 2>/dev/null || true
COPY frontend/ .
RUN npx vite build

# Stage 2: Build backend
FROM node:20-slim AS backend-build
WORKDIR /app/backend
# 安装原生模块编译工具链（better-sqlite3 需要）
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/ .
RUN npx tsc

# Stage 3: Production
FROM node:20-slim
WORKDIR /app

# 安装原生模块编译工具链，安装依赖后清理
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
