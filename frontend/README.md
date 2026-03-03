# nowen-note

自托管私有笔记应用，对标群晖 Note Station。

A self-hosted private note-taking app, inspired by Synology Note Station.

---

## 中文文档

### 简介

nowen-note 是一款自托管的私有化笔记应用，采用现代前后端分离架构，支持 Docker 一键部署。集成 Tiptap 富文本编辑器、AI 智能写作助手、OnlyOffice 在线文档协作、思维导图、任务管理等功能，打造一体化知识管理平台。

### 技术栈

| 层级 | 技术 |
|------|------|
| 前端框架 | React 18 + TypeScript + Vite 5 |
| 编辑器 | Tiptap 3（代码高亮、图片、任务列表、下划线、高亮等） |
| UI 组件 | Radix UI + shadcn/ui 风格组件 |
| 样式 | Tailwind CSS 3.4 + Framer Motion |
| 国际化 | i18next（中英文切换） |
| 后端框架 | Hono 4 + @hono/node-server |
| 数据库 | SQLite（better-sqlite3）+ FTS5 全文搜索 |
| 数据校验 | Zod |
| 文档协作 | OnlyOffice Document Server |
| AI 引擎 | OpenAI / 通义千问 / DeepSeek / Gemini / 豆包 / Ollama |

### 项目结构

```
nowen-note/
├── frontend/              # 前端 React 应用
│   ├── src/
│   │   ├── components/    # 组件
│   │   │   ├── Sidebar          # 侧边栏导航（笔记本树、视图切换）
│   │   │   ├── NoteList         # 笔记列表（置顶、收藏、右键菜单）
│   │   │   ├── EditorPane       # 编辑器面板（标题、标签、同步状态）
│   │   │   ├── TiptapEditor     # Tiptap 富文本编辑器
│   │   │   ├── AIChatPanel      # AI 知识库问答面板
│   │   │   ├── AIWritingAssistant  # AI 写作助手（选中文本操作）
│   │   │   ├── AISettingsPanel  # AI 服务配置面板
│   │   │   ├── TaskCenter       # 任务管理中心
│   │   │   ├── MindMapEditor    # 思维导图编辑器
│   │   │   ├── DocumentCenter   # 文档中心（OnlyOffice）
│   │   │   ├── DataManager      # 数据导入导出
│   │   │   └── SettingsModal    # 设置弹窗
│   │   ├── store/         # 状态管理（useReducer + Context）
│   │   ├── lib/           # 工具函数 & API 封装
│   │   ├── i18n/          # 国际化配置 & 语言包
│   │   └── types/         # 类型定义
│   └── ...
├── backend/               # 后端 Hono 应用
│   └── src/
│       ├── db/            # 数据库 Schema & 迁移
│       ├── routes/        # API 路由
│       │   ├── notes        # 笔记 CRUD + 锁定/置顶/收藏
│       │   ├── notebooks    # 笔记本 CRUD + 排序
│       │   ├── tags         # 标签管理
│       │   ├── tasks        # 任务管理 + 子任务
│       │   ├── mindmaps     # 思维导图 CRUD
│       │   ├── documents    # 文档管理 + OnlyOffice
│       │   ├── ai           # AI 聊天 + 写作助手 + RAG 问答
│       │   ├── search       # FTS5 全文搜索
│       │   ├── auth         # 用户认证 + JWT
│       │   ├── settings     # 站点配置
│       │   ├── fonts        # 自定义字体
│       │   ├── export       # 笔记导出
│       │   ├── micloud      # 小米云便签导入
│       │   └── oppocloud    # OPPO 云便签导入
│       └── index.ts       # 入口文件
├── Dockerfile             # 多阶段构建
├── docker-compose.yml     # 容器编排（3 服务）
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

#### Docker 部署

```bash
docker-compose up -d
```

访问 `http://localhost:3001` 即可使用。

服务端口：
- `3001` — nowen-note 主应用
- `8080` — OnlyOffice 文档服务器
- `11434` — Ollama 本地 AI 推理（可选）

### 核心功能

#### 笔记管理
- **三栏布局**：侧边栏 + 笔记列表 + 编辑器（均支持拖拽调整宽度）
- **无限层级笔记本**：支持嵌套子笔记本、拖拽排序
- **Tiptap 富文本编辑器**：Markdown 快捷键、代码高亮、图片插入、任务列表
- **FTS5 全文搜索**：基于 SQLite 虚拟表，通过触发器自动同步
- **标签管理**：多对多关系，彩色标签
- **笔记锁定**：锁定笔记防止误修改，前后端双层保护
- **收藏 & 置顶**：快速访问重要笔记
- **乐观锁**：version 字段防止编辑冲突

#### AI 智能助手
- **AI 写作助手**：对选中文本执行续写、改写、润色、缩写、扩写、翻译（中/英）、摘要、解释、语法修正
- **AI 生成标题**：基于笔记内容自动生成标题
- **AI 推荐标签**：智能推荐并自动创建标签
- **AI 知识问答（RAG）**：基于 FTS5 检索知识库内容，结合上下文回答问题，支持多轮对话
- **多模型支持**：通义千问、OpenAI、Google Gemini、DeepSeek、豆包（火山引擎）、Ollama 本地模型、自定义 OpenAI 兼容接口
- **流式输出**：SSE 实时流式生成，Markdown 格式化渲染

#### 思维导图
- **可视化脑图编辑**：自研树形布局算法
- **节点操作**：添加、编辑、删除、折叠/展开子节点
- **画布交互**：缩放、平移、自适应视图
- **导出**：PNG / SVG 格式

#### 文档中心（OnlyOffice）
- **在线编辑**：Word、Excel、PowerPoint 在线协同编辑
- **文档管理**：创建、上传、下载、搜索
- **JWT 安全认证**：OnlyOffice 与应用间的安全通信

#### 任务管理
- **任务中心**：独立的任务管理面板
- **优先级**：高 / 中 / 低三级优先级
- **截止日期**：日期选择与逾期提醒
- **子任务**：支持任务拆分
- **多维筛选**：全部 / 今天 / 本周 / 逾期 / 已完成

#### 数据管理
- **导入**：Markdown、ZIP 批量导入
- **导出**：笔记导出
- **小米云便签导入**：通过 Cookie 认证批量导入
- **OPPO 云便签导入**：控制台脚本提取 + JSON 批量导入

#### 个性化设置
- **深色 / 浅色主题**：沉浸式配色方案切换
- **站点自定义**：站点标题、图标自定义
- **自定义字体**：上传并切换编辑器字体
- **国际化**：中英文双语切换
- **安全设置**：用户名与密码修改

### Docker Compose 服务

| 服务 | 镜像 | 端口 | 说明 |
|------|------|------|------|
| nowen-note | 自构建 | 3001 | 主应用（前后端一体 + SQLite） |
| onlyoffice | onlyoffice/documentserver | 8080 | 文档在线编辑服务器 |
| ollama | ollama/ollama | 11434 | 本地 AI 推理服务（可选 GPU 加速） |

---

## English Documentation

### Introduction

nowen-note is a self-hosted private note-taking application with a modern frontend-backend separated architecture. It supports one-click Docker deployment, featuring a Tiptap rich-text editor, AI-powered writing assistant, OnlyOffice document collaboration, mind mapping, task management, and more — an all-in-one knowledge management platform.

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + TypeScript + Vite 5 |
| Editor | Tiptap 3 (code highlight, image, task list, underline, highlight, etc.) |
| UI Components | Radix UI + shadcn/ui style components |
| Styling | Tailwind CSS 3.4 + Framer Motion |
| i18n | i18next (Chinese/English) |
| Backend | Hono 4 + @hono/node-server |
| Database | SQLite (better-sqlite3) + FTS5 full-text search |
| Validation | Zod |
| Document Collaboration | OnlyOffice Document Server |
| AI Engine | OpenAI / Qwen / DeepSeek / Gemini / Doubao / Ollama |

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

Service Ports:
- `3001` — nowen-note main app
- `8080` — OnlyOffice Document Server
- `11434` — Ollama local AI inference (optional)

### Key Features

#### Note Management
- **Three-column layout**: Sidebar + Note List + Editor (all resizable via drag)
- **Unlimited nested notebooks**: Support for nested sub-notebooks with drag-and-drop sorting
- **Tiptap rich-text editor**: Markdown shortcuts, code highlighting, image upload, task lists
- **FTS5 full-text search**: Based on SQLite virtual tables with auto-sync triggers
- **Tag management**: Many-to-many relationships with colored tags
- **Note locking**: Lock notes to prevent accidental modifications (frontend + backend dual-layer protection)
- **Favorites & Pinning**: Quick access to important notes
- **Optimistic locking**: Version field to prevent edit conflicts

#### AI Smart Assistant
- **AI Writing Assistant**: Continue, rewrite, polish, shorten, expand, translate (CN/EN), summarize, explain, fix grammar on selected text
- **AI Title Generation**: Auto-generate titles based on note content
- **AI Tag Suggestion**: Intelligently recommend and auto-create tags
- **AI Knowledge Q&A (RAG)**: Retrieve knowledge base content via FTS5, answer with context, support multi-turn conversations
- **Multi-provider support**: Qwen, OpenAI, Google Gemini, DeepSeek, Doubao (Volcengine), Ollama local models, custom OpenAI-compatible APIs
- **Streaming output**: Real-time SSE streaming with Markdown rendering

#### Mind Mapping
- **Visual mind map editor**: Custom tree layout algorithm
- **Node operations**: Add, edit, delete, collapse/expand child nodes
- **Canvas interaction**: Zoom, pan, fit-to-view
- **Export**: PNG / SVG formats

#### Document Center (OnlyOffice)
- **Online editing**: Word, Excel, PowerPoint online collaborative editing
- **Document management**: Create, upload, download, search
- **JWT authentication**: Secure communication between OnlyOffice and the app

#### Task Management
- **Task Center**: Dedicated task management panel
- **Priority levels**: High / Medium / Low
- **Due dates**: Date picker with overdue reminders
- **Subtasks**: Task breakdown support
- **Multi-filter**: All / Today / This Week / Overdue / Completed

#### Data Management
- **Import**: Markdown, ZIP batch import
- **Export**: Note export
- **Mi Cloud Notes Import**: Batch import via Cookie authentication
- **OPPO Cloud Notes Import**: Console script extraction + JSON batch import

#### Personalization
- **Dark / Light theme**: Immersive color scheme switching
- **Site customization**: Custom site title and favicon
- **Custom fonts**: Upload and switch editor fonts
- **Internationalization**: Chinese / English language switching
- **Security settings**: Username and password management

### Docker Compose Services

| Service | Image | Port | Description |
|---------|-------|------|-------------|
| nowen-note | Self-built | 3001 | Main app (frontend + backend + SQLite) |
| onlyoffice | onlyoffice/documentserver | 8080 | Online document editing server |
| ollama | ollama/ollama | 11434 | Local AI inference (optional GPU acceleration) |
