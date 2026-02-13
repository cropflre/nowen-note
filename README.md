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

### 安装部署

> **默认管理员账号：`admin` / `admin123`**
>
> 首次登录后请立即在「设置 → 账号安全」中修改密码。

---

#### 方式一：Windows 本地安装（开发 / 体验）

**环境要求：** Node.js 20+、Git

```bash
# 1. 克隆项目
git clone https://github.com/cropflre/nowen-note.git
cd nowen-note

# 2. 安装所有依赖
npm run install:all

# 3. 启动后端（端口 3001）
npm run dev:backend

# 4. 新开一个终端，启动前端（端口 5173，自动代理 /api → 3001）
npm run dev:frontend
```

浏览器访问 `http://localhost:5173` 即可使用。

数据库文件位于 `backend/data/nowen-note.db`，备份此文件即可迁移数据。

---

#### 方式二：Docker 通用安装（推荐）

适用于任何安装了 Docker 的 Linux / macOS / Windows 设备。

**方法 A：docker-compose（推荐）**

```bash
# 1. 克隆项目
git clone https://github.com/cropflre/nowen-note.git
cd nowen-note

# 2. 一键构建并启动
docker-compose up -d
```

**方法 B：纯 docker 命令**

```bash
# 1. 克隆并构建镜像
git clone https://github.com/cropflre/nowen-note.git
cd nowen-note
docker build -t nowen-note .

# 2. 创建数据目录并运行
mkdir -p /opt/nowen-note/data
docker run -d \
  --name nowen-note \
  --restart unless-stopped \
  -p 3001:3001 \
  -v /opt/nowen-note/data:/app/data \
  -e DB_PATH=/app/data/nowen-note.db \
  nowen-note
```

浏览器访问 `http://<你的IP>:3001` 即可使用。

**环境变量说明：**

| 变量名     | 默认值                     | 说明             |
| ---------- | -------------------------- | ---------------- |
| `PORT`     | `3001`                     | 服务监听端口     |
| `DB_PATH`  | `/app/data/nowen-note.db`  | 数据库文件路径   |
| `NODE_ENV` | `production`               | 运行环境         |

---

#### 方式三：群晖 Synology NAS 安装

**前提：** 已安装 Container Manager（DSM 7.2+）或 Docker 套件（DSM 7.0 / 7.1）。

**步骤：**

1. **上传镜像**
   - 在电脑上执行 `docker build -t nowen-note .` 构建镜像
   - 导出镜像：`docker save nowen-note -o nowen-note.tar`
   - 在群晖 Container Manager → 映像 → 导入 → 上传 `nowen-note.tar`

2. **创建容器**
   - 映像列表中选择 `nowen-note` → 启动
   - **端口设置**：本地端口 `3001` → 容器端口 `3001`
   - **存储空间**：新增文件夹映射
     - 本地路径：`/docker/nowen-note/data`
     - 容器路径：`/app/data`
   - **环境变量**（默认即可，无需修改）

3. **访问使用**
   - 浏览器访问 `http://<群晖IP>:3001`

> **提示：** 数据备份只需复制 `/docker/nowen-note/data/nowen-note.db` 文件。可使用群晖 Hyper Backup 定期备份该目录。

---

#### 方式四：绿联 UGOS NAS 安装

**前提：** 已开启 Docker 功能（绿联 UGOS Pro / UGOS）。

**步骤：**

1. **导入镜像**
   - 在电脑上构建并导出镜像（同群晖步骤）
   - 绿联 NAS → Docker → 镜像管理 → 本地导入 `nowen-note.tar`

2. **创建容器**
   - 选择 `nowen-note` 镜像 → 创建容器
   - **网络**：选择 bridge 模式
   - **端口映射**：主机 `3001` → 容器 `3001`
   - **存储映射**：
     - 主机路径：`/mnt/user/appdata/nowen-note/data`（或自定义路径）
     - 容器路径：`/app/data`
   - **重启策略**：开机自启

3. **访问使用**
   - 浏览器访问 `http://<绿联NAS IP>:3001`

---

#### 方式五：飞牛 fnOS 安装

**前提：** 飞牛 fnOS 已开启 Docker 功能。

**步骤：**

1. **导入镜像**
   - 在电脑上构建并导出镜像（同群晖步骤）
   - 飞牛 fnOS → Docker → 镜像 → 导入 `nowen-note.tar`

2. **创建容器**
   - 选择 `nowen-note` 镜像 → 创建容器
   - **端口映射**：主机 `3001` → 容器 `3001`
   - **卷映射**：
     - 主机路径：`/vol1/docker/nowen-note/data`（根据实际存储卷调整）
     - 容器路径：`/app/data`
   - **重启策略**：除非手动停止

3. **访问使用**
   - 浏览器访问 `http://<飞牛NAS IP>:3001`

---

#### 方式六：威联通 QNAP 安装

**前提：** 已安装 Container Station（QTS 5.0+ / QuTS hero）。

**步骤：**

1. **导入镜像**
   - 在电脑上构建并导出镜像（同群晖步骤）
   - Container Station → 映像档 → 导入 → 选择 `nowen-note.tar`

2. **创建容器**
   - 选择 `nowen-note` 映像 → 创建
   - **网络设置**：NAT 模式，端口映射 `3001` → `3001`
   - **共享文件夹**：
     - 主机路径：`/share/Container/nowen-note/data`
     - 容器路径：`/app/data`
   - **其他**：勾选"自动重新启动"

3. **访问使用**
   - 浏览器访问 `http://<威联通IP>:3001`

> **提示：** QNAP 也支持 docker-compose，在 Container Station → 创建 → 使用 YAML 创建，粘贴本项目的 `docker-compose.yml` 内容即可。

---

#### 方式七：极空间 NAS 安装

**前提：** 极空间 ZOS 已开启 Docker 功能（极空间 Z4S / Z4 Pro / Z2 Pro 等）。

**步骤：**

1. **导入镜像**
   - 在电脑上构建并导出镜像（同群晖步骤）
   - 极空间 → Docker → 镜像 → 本地镜像 → 导入 `nowen-note.tar`

2. **创建容器**
   - 选择 `nowen-note` 镜像 → 创建容器
   - **端口映射**：本地 `3001` → 容器 `3001`
   - **路径映射**：
     - 本地路径：选择一个文件夹（如 `极空间/docker/nowen-note/data`）
     - 容器路径：`/app/data`
   - **重启策略**：自动重启

3. **访问使用**
   - 浏览器访问 `http://<极空间IP>:3001`

---

#### 通用注意事项

- **数据持久化**：务必将容器内的 `/app/data` 目录映射到宿主机，否则容器删除后数据丢失
- **数据备份**：只需备份映射目录中的 `nowen-note.db` 文件
- **端口冲突**：如 3001 端口被占用，可修改主机端口映射（如 `8080:3001`）
- **安全建议**：首次登录后请立即修改默认密码；如需外网访问，建议搭配反向代理（Nginx / Caddy）并启用 HTTPS

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

### Installation & Deployment

> **Default admin credentials: `admin` / `admin123`**
>
> Please change the password immediately after first login via Settings → Account Security.

---

#### Option 1: Windows Local Install (Dev / Preview)

**Requirements:** Node.js 20+, Git

```bash
# 1. Clone the project
git clone https://github.com/cropflre/nowen-note.git
cd nowen-note

# 2. Install all dependencies
npm run install:all

# 3. Start backend (port 3001)
npm run dev:backend

# 4. Open a new terminal, start frontend (port 5173, auto-proxies /api → 3001)
npm run dev:frontend
```

Visit `http://localhost:5173` in your browser.

#### Option 2: Docker (Recommended)

Works on any device with Docker installed (Linux / macOS / Windows).

**Method A: docker-compose (Recommended)**

```bash
git clone https://github.com/cropflre/nowen-note.git
cd nowen-note
docker-compose up -d
```

**Method B: docker run**

```bash
git clone https://github.com/cropflre/nowen-note.git
cd nowen-note
docker build -t nowen-note .

mkdir -p /opt/nowen-note/data
docker run -d \
  --name nowen-note \
  --restart unless-stopped \
  -p 3001:3001 \
  -v /opt/nowen-note/data:/app/data \
  -e DB_PATH=/app/data/nowen-note.db \
  nowen-note
```

Visit `http://<your-ip>:3001` in your browser.

**Environment Variables:**

| Variable   | Default                    | Description          |
| ---------- | -------------------------- | -------------------- |
| `PORT`     | `3001`                     | Server listen port   |
| `DB_PATH`  | `/app/data/nowen-note.db`  | Database file path   |
| `NODE_ENV` | `production`               | Runtime environment  |

#### Option 3: NAS Deployment (Synology / QNAP / UGREEN / fnOS / Zspace)

All NAS platforms with Docker support follow the same general steps:

1. **Build & export image** on your PC: `docker build -t nowen-note . && docker save nowen-note -o nowen-note.tar`
2. **Import** `nowen-note.tar` into your NAS Docker manager
3. **Create container** with:
   - Port mapping: host `3001` → container `3001`
   - Volume mapping: host folder → container `/app/data`
   - Restart policy: always / unless-stopped
4. Visit `http://<nas-ip>:3001`

> **Important:** Always map the `/app/data` directory to persist your database. Back up the `nowen-note.db` file for data safety.

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
