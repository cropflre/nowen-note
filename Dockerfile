# Stage 1: Build frontend
FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ .
ENV NODE_OPTIONS="--max-old-space-size=4096"
RUN npm run build

# Stage 2: Build backend
FROM node:20-alpine AS backend-build
WORKDIR /app/backend
# 安装原生模块编译工具链（better-sqlite3 需要）
RUN apk add --no-cache python3 make g++
COPY backend/package*.json ./
RUN npm install
COPY backend/ .
RUN npx tsc

# Stage 3: Production
FROM node:20-alpine
WORKDIR /app

# 安装原生模块编译工具链，安装依赖后清理
COPY backend/package*.json ./backend/
RUN apk add --no-cache python3 make g++ \
    && cd backend && npm install --omit=dev \
    && apk del python3 make g++ \
    && rm -rf /root/.npm /tmp/*

COPY --from=backend-build /app/backend/dist ./backend/dist
COPY backend/templates ./backend/templates
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV DB_PATH=/app/data/nowen-note.db
ENV PORT=3001

EXPOSE 3001

WORKDIR /app
CMD ["node", "backend/dist/index.js"]
