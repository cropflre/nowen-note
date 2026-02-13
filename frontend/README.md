# nowen-note

自托管私有笔记应用，对标群晖 Note Station。

A self-hosted private note-taking app, inspired by Synology Note Station.

---

## 中文文档

### 简介

nowen-note 是一款自托管的私有化笔记应用，采用现代前后端分离架构，支持 Docker 一键部署。内置 Tiptap 富文本编辑器，支持无限层级笔记本、全文搜索、标签管理等功能。

### 技术栈

| 层级 | 技术 |
|------|------|
| 前端框架 | React 18 + TypeScript + Vite 5 |
| 编辑器 | Tiptap 3（代码高亮、图片、任务列表、下划线、高亮等） |
| UI 组件 | Radix UI + shadcn/ui 风格组件 |
| 样式 | Tailwind CSS 3.4 + Framer Motion |
| 后端框架 | Hono 4 + @hono/node-server |
| 数据库 | SQLite（better-sqlite3） |
| 数据校验 | Zod |

### 项目结构

```
nowen-note/
├── frontend/          # 前端 React 应用
│   ├── src/
│   │   ├── components/   # 组件（Sidebar、NoteList、EditorPane、TiptapEditor）
│   │   ├── store/        # 状态管理（useReducer + Context）
│   │   ├── lib/          # 工具函数 & API 封装
│   │   └── types/        # 类型定义
│   └── ...
├── backend/           # 后端 Hono 应用
│   └── src/
│       ├── db/           # 数据库 Schema & 种子数据
│       ├── routes/       # API 路由（notebooks、notes、tags、search）
│       └── index.ts      # 入口文件
├── Dockerfile         # 多阶段构建
├── docker-compose.yml # 容器编排
└── package.json       # 根级脚本
```

### 快速开始

#### 开发模式

```bash
# 安装所有依赖
npm run install:all

# 启动后端（端口 3001）
npm run dev:backend

# 启动前端（Vite，自动代理 /api → 3001）
npm run dev:frontend
```

#### Docker 部署

```bash
docker-compose up -d
```

访问 `http://localhost:3001` 即可使用。

### 核心功能

- **三栏布局**：侧边栏（260px）+ 笔记列表（300px）+ 编辑器（自适应）
- **无限层级笔记本**：支持嵌套子笔记本
- **Tiptap 富文本编辑器**：Markdown 快捷键、代码高亮、图片插入、任务列表
- **FTS5 全文搜索**：基于 SQLite 虚拟表，通过触发器自动同步
- **标签管理**：多对多关系，彩色标签
- **乐观锁**：version 字段防止编辑冲突
- **深色主题**：沉浸式深色配色方案

---

## English Documentation

### Introduction

nowen-note is a self-hosted private note-taking application with a modern frontend-backend separated architecture. It supports one-click Docker deployment, featuring a Tiptap rich-text editor, unlimited nested notebooks, full-text search, and tag management.

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + TypeScript + Vite 5 |
| Editor | Tiptap 3 (code highlight, image, task list, underline, highlight, etc.) |
| UI Components | Radix UI + shadcn/ui style components |
| Styling | Tailwind CSS 3.4 + Framer Motion |
| Backend | Hono 4 + @hono/node-server |
| Database | SQLite (better-sqlite3) |
| Validation | Zod |

### Project Structure

```
nowen-note/
├── frontend/          # React frontend app
│   ├── src/
│   │   ├── components/   # Components (Sidebar, NoteList, EditorPane, TiptapEditor)
│   │   ├── store/        # State management (useReducer + Context)
│   │   ├── lib/          # Utilities & API client
│   │   └── types/        # Type definitions
│   └── ...
├── backend/           # Hono backend app
│   └── src/
│       ├── db/           # Database schema & seed data
│       ├── routes/       # API routes (notebooks, notes, tags, search)
│       └── index.ts      # Entry point
├── Dockerfile         # Multi-stage build
├── docker-compose.yml # Container orchestration
└── package.json       # Root-level scripts
```

### Quick Start

#### Development

```bash
# Install all dependencies
npm run install:all

# Start backend (port 3001)
npm run dev:backend

# Start frontend (Vite, auto-proxies /api → 3001)
npm run dev:frontend
```

#### Docker Deployment

```bash
docker-compose up -d
```

Visit `http://localhost:3001` to use the app.

### Key Features

- **Three-column layout**: Sidebar (260px) + Note List (300px) + Editor (flexible)
- **Unlimited nested notebooks**: Support for nested sub-notebooks
- **Tiptap rich-text editor**: Markdown shortcuts, code highlighting, image upload, task lists
- **FTS5 full-text search**: Based on SQLite virtual tables with auto-sync triggers
- **Tag management**: Many-to-many relationships with colored tags
- **Optimistic locking**: Version field to prevent edit conflicts
- **Dark theme**: Immersive dark color scheme
