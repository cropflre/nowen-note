# nowen-note

自托管私有笔记应用，对标群晖 Note Station。

A self-hosted private note-taking app, inspired by Synology Note Station.

---

## 中文文档

### 简介

nowen-note 是一款自托管的私有化笔记应用，采用现代前后端分离架构，支持 Docker 一键部署。内置 Tiptap 富文本编辑器，支持 JWT 认证、无限层级笔记本、全文搜索、待办事项、标签管理、数据导入导出等功能。

### 技术栈

| 层级     | 技术                                                         |
| -------- | ------------------------------------------------------------ |
| 前端框架 | React 18 + TypeScript + Vite 5                               |
| 编辑器   | Tiptap 3（代码高亮、图片、任务列表、下划线、文本高亮等）     |
| UI 组件  | Radix UI + shadcn/ui 风格组件 + Lucide Icons                 |
| 样式     | Tailwind CSS 3.4 + Framer Motion                             |
| 后端框架 | Hono 4 + @hono/node-server                                   |
| 数据库   | SQLite（better-sqlite3）+ FTS5 全文搜索                      |
| 认证     | JWT（jsonwebtoken）+ bcryptjs 密码哈希                       |
| 数据校验 | Zod                                                          |
| 数据处理 | JSZip（压缩打包）、Turndown（HTML→Markdown）、FileSaver      |

### 项目结构

```
nowen-note/
├── frontend/              # 前端 React 应用
│   ├── src/
│   │   ├── components/    # 组件
│   │   │   ├── Sidebar.tsx          # 侧边栏（笔记本树 + 导航 + 标签）
│   │   │   ├── NoteList.tsx         # 笔记列表（多视图 + 右键菜单）
│   │   │   ├── EditorPane.tsx       # 编辑器面板
│   │   │   ├── TiptapEditor.tsx     # Tiptap 富文本编辑器
│   │   │   ├── LoginPage.tsx        # 登录页
│   │   │   ├── ContextMenu.tsx      # 通用右键菜单组件
│   │   │   ├── SettingsModal.tsx    # 设置中心（外观/安全/数据）
│   │   │   ├── SecuritySettings.tsx # 账号安全设置
│   │   │   └── DataManager.tsx      # 数据管理（导入导出 + 恢复出厂）
│   │   ├── hooks/         # 自定义 Hooks
│   │   │   └── useContextMenu.ts    # 右键菜单状态管理 + 边缘碰撞检测
│   │   ├── store/         # 状态管理（useReducer + Context）
│   │   ├── lib/           # 工具函数 & API 封装
│   │   └── types/         # 类型定义
│   └── ...
├── backend/               # 后端 Hono 应用
│   └── src/
│       ├── db/            # 数据库 Schema & 种子数据
│       ├── routes/        # API 路由
│       │   ├── auth.ts        # 认证（登录/改密/恢复出厂）
│       │   ├── notebooks.ts   # 笔记本 CRUD
│       │   ├── notes.ts       # 笔记 CRUD
│       │   ├── tags.ts        # 标签管理
│       │   ├── tasks.ts       # 待办事项
│       │   ├── search.ts      # 全文搜索
│       │   └── export.ts      # 数据导入导出
│       └── index.ts       # 入口文件（JWT 中间件 + 路由注册）
├── Dockerfile             # 多阶段构建
├── docker-compose.yml     # 容器编排
└── package.json           # 根级脚本
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

默认管理员账号：`admin` / `admin123`

#### Docker 部署

```bash
docker-compose up -d
```

访问 `http://localhost:3001` 即可使用。

### 核心功能

#### 认证系统
- JWT Token 认证（30 天有效期）
- 登录页面（带动画与默认账号提示）
- 修改用户名 / 密码（需验证当前密码）
- SHA256 → bcrypt 密码哈希自动升级

#### 笔记管理
- **三栏布局**：侧边栏 + 笔记列表 + 编辑器（自适应宽度）
- **Tiptap 富文本编辑器**：Markdown 快捷键、代码高亮、图片插入、任务列表
- **笔记操作**：置顶、收藏、软删除（回收站）、恢复、永久删除
- **乐观锁**：version 字段防止编辑冲突

#### 笔记本
- 支持无限层级嵌套（树形结构）
- 右键菜单：新建笔记、新建子笔记本、重命名、删除
- 行内重命名：原地 `<input>` 编辑，Enter 保存、Escape 取消

#### 右键菜单系统
- 通用右键菜单组件（毛玻璃面板 + 动画出入场）
- 边缘碰撞检测（菜单不会溢出屏幕）
- 支持分隔线、危险操作高亮、禁用状态
- 笔记本列表 & 笔记列表均支持右键操作

#### 全文搜索
- 基于 SQLite FTS5 虚拟表
- 通过触发器自动同步索引

#### 待办事项
- 任务 CRUD（标题、优先级、截止日期）
- 支持子任务（父子关系）
- 多维度筛选：全部、今日、本周、已逾期、已完成
- 任务统计摘要

#### 标签系统
- 多对多关系，彩色标签
- 侧边栏标签面板快速筛选

#### 数据管理
- **导出备份**：全量导出为 ZIP 压缩包（Markdown + YAML frontmatter），含进度条
- **导入笔记**：支持拖拽上传 `.md` / `.txt` / `.zip` 文件，可选择目标笔记本
- **恢复出厂设置**：清空所有数据并重置管理员账户，二次确认防误触（需输入 `RESET`）

#### 设置中心
- **外观设置**：主题切换（浅色 / 深色 / 跟随系统）
- **账号安全**：修改用户名和密码
- **数据管理**：导入导出与恢复出厂

#### 主题与交互
- 深色 / 浅色 / 跟随系统三种主题模式
- 侧边栏可折叠（仅图标模式）
- Framer Motion 丝滑动画

---

## English Documentation

### Introduction

nowen-note is a self-hosted private note-taking application with a modern frontend-backend separated architecture. It supports one-click Docker deployment, featuring JWT authentication, a Tiptap rich-text editor, unlimited nested notebooks, full-text search, task management, tag system, data import/export, and more.

### Tech Stack

| Layer         | Technology                                                                    |
| ------------- | ----------------------------------------------------------------------------- |
| Frontend      | React 18 + TypeScript + Vite 5                                               |
| Editor        | Tiptap 3 (code highlight, image, task list, underline, text highlight, etc.)  |
| UI Components | Radix UI + shadcn/ui style components + Lucide Icons                          |
| Styling       | Tailwind CSS 3.4 + Framer Motion                                             |
| Backend       | Hono 4 + @hono/node-server                                                   |
| Database      | SQLite (better-sqlite3) + FTS5 full-text search                              |
| Auth          | JWT (jsonwebtoken) + bcryptjs password hashing                                |
| Validation    | Zod                                                                           |
| Data Utils    | JSZip (compression), Turndown (HTML→Markdown), FileSaver                      |

### Project Structure

```
nowen-note/
├── frontend/              # React frontend app
│   ├── src/
│   │   ├── components/    # Components
│   │   │   ├── Sidebar.tsx          # Sidebar (notebook tree + nav + tags)
│   │   │   ├── NoteList.tsx         # Note list (multi-view + context menu)
│   │   │   ├── EditorPane.tsx       # Editor pane
│   │   │   ├── TiptapEditor.tsx     # Tiptap rich-text editor
│   │   │   ├── LoginPage.tsx        # Login page
│   │   │   ├── ContextMenu.tsx      # Reusable context menu component
│   │   │   ├── SettingsModal.tsx    # Settings center (appearance/security/data)
│   │   │   ├── SecuritySettings.tsx # Account security settings
│   │   │   └── DataManager.tsx      # Data management (import/export + factory reset)
│   │   ├── hooks/         # Custom Hooks
│   │   │   └── useContextMenu.ts    # Context menu state + edge collision detection
│   │   ├── store/         # State management (useReducer + Context)
│   │   ├── lib/           # Utilities & API client
│   │   └── types/         # Type definitions
│   └── ...
├── backend/               # Hono backend app
│   └── src/
│       ├── db/            # Database schema & seed data
│       ├── routes/        # API routes
│       │   ├── auth.ts        # Auth (login/change-password/factory-reset)
│       │   ├── notebooks.ts   # Notebook CRUD
│       │   ├── notes.ts       # Note CRUD
│       │   ├── tags.ts        # Tag management
│       │   ├── tasks.ts       # Task/Todo management
│       │   ├── search.ts      # Full-text search
│       │   └── export.ts      # Data import/export
│       └── index.ts       # Entry point (JWT middleware + route registration)
├── Dockerfile             # Multi-stage build
├── docker-compose.yml     # Container orchestration
└── package.json           # Root-level scripts
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

Default admin credentials: `admin` / `admin123`

#### Docker Deployment

```bash
docker-compose up -d
```

Visit `http://localhost:3001` to use the app.

### Key Features

#### Authentication
- JWT Token authentication (30-day expiry)
- Login page with animation and default credential hints
- Change username / password (requires current password verification)
- Automatic SHA256 → bcrypt password hash upgrade

#### Note Management
- **Three-column layout**: Sidebar + Note List + Editor (flexible width)
- **Tiptap rich-text editor**: Markdown shortcuts, code highlighting, image upload, task lists
- **Note operations**: Pin, favorite, soft delete (trash), restore, permanent delete
- **Optimistic locking**: Version field to prevent edit conflicts

#### Notebooks
- Unlimited nested hierarchy (tree structure)
- Context menu: New note, new sub-notebook, rename, delete
- Inline rename: In-place `<input>` editing, Enter to save, Escape to cancel

#### Context Menu System
- Reusable context menu component (frosted glass panel + animated transitions)
- Edge collision detection (menu never overflows screen)
- Supports separators, danger action highlighting, disabled states
- Available on both notebook tree and note list

#### Full-text Search
- Based on SQLite FTS5 virtual tables
- Auto-synced via triggers

#### Task Management
- Task CRUD (title, priority, due date)
- Subtask support (parent-child relationship)
- Multi-filter views: All, Today, This Week, Overdue, Completed
- Task statistics summary

#### Tag System
- Many-to-many relationships with colored tags
- Sidebar tag panel for quick filtering

#### Data Management
- **Export backup**: Full export as ZIP archive (Markdown + YAML frontmatter) with progress bar
- **Import notes**: Drag-and-drop `.md` / `.txt` / `.zip` files, choose target notebook
- **Factory reset**: Wipe all data and reset admin account, requires typing `RESET` to confirm

#### Settings Center
- **Appearance**: Theme switch (light / dark / system)
- **Account Security**: Change username and password
- **Data Management**: Import/export and factory reset

#### Theme & Interaction
- Light / Dark / System three theme modes
- Collapsible sidebar (icon-only mode)
- Smooth Framer Motion animations
