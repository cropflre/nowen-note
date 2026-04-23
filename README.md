# nowen-note

自托管私有知识库，对标群晖 Note Station。

A self-hosted private knowledge base, inspired by Synology Note Station.

> **问题反馈 QQ 群 / Support QQ Group：`1093473044`**

## 语言 / Language

- [中文文档](#中文文档)
- [English Documentation](#english-documentation)

---

## 中文文档

### 目录

- [简介](#简介)
- [技术栈](#技术栈)
- [项目结构](#项目结构)
- [安装部署](#安装部署)
- [核心功能](#核心功能)
- [开发者工具](#开发者工具)
- [NPM 脚本](#npm-脚本)
- [数据迁移脚本](#数据迁移脚本)
- [Docker Compose 架构](#docker-compose-架构)
- [数据库设计](#数据库设计)
- [API 路由一览](#api-路由一览)

### 简介

**nowen-note** 是一款自托管的私有化知识管理应用，采用现代前后端分离架构，支持 Docker 一键部署、Electron 桌面客户端，以及基于 Capacitor 的 Android 移动端。

一体化能力：

- **现代富文本编辑器**：基于 Tiptap 3，支持 Markdown 快捷键、代码高亮、图片插入、任务列表（另内置 CodeMirror 6 Markdown 源码编辑器作为高级备选，可通过 URL 参数启用）
- **AI 智能助手**：集成 6 大 AI 服务商（通义千问 / OpenAI / Gemini / DeepSeek / 豆包 / Ollama），提供写作助手、生成标题、推荐标签、RAG 知识库问答
- **知识管理**：无限层级笔记本、彩色标签、任务管理、思维导图、说说动态、FTS5 全文搜索
- **协作与历史**：笔记分享（密码 / 有效期 / 权限 / 评论批注）、版本历史回溯
- **自动化**：插件系统（沙箱热加载）、Webhook 事件推送、审计日志
- **数据治理**：自动定时备份、一键恢复；多平台数据导入（小米云笔记 / OPPO 云便签 / iPhone 备忘录）、Markdown + YAML frontmatter 导出
- **开发者生态**：MCP Server（22 个 AI 工具）、TypeScript SDK（60+ API）、CLI（8 组命令）、OpenAPI 3.0 规范

### 技术栈

| 层级       | 技术                                                                |
| ---------- | ------------------------------------------------------------------- |
| 前端框架   | React 18 + TypeScript + Vite 5                                      |
| 富文本编辑 | Tiptap 3（代码高亮、图片、任务列表、下划线、文本高亮等）            |
| Markdown   | CodeMirror 6 + `@codemirror/lang-markdown`                          |
| UI 组件    | Radix UI + shadcn/ui 风格组件 + Lucide Icons                        |
| 样式       | Tailwind CSS 3.4 + Framer Motion                                    |
| 国际化     | i18next（中英文切换）                                               |
| 后端框架   | Hono 4 + `@hono/node-server`                                        |
| 数据库     | SQLite（better-sqlite3）+ FTS5 全文搜索                             |
| 认证       | JWT（jsonwebtoken）+ bcryptjs 密码哈希                              |
| 数据校验   | Zod                                                                 |
| AI 引擎    | 通义千问 / OpenAI / Google Gemini / DeepSeek / 豆包 / Ollama        |
| 数据处理   | JSZip（压缩打包）、Turndown（HTML→Markdown）、FileSaver             |
| Markdown 渲染 | react-markdown + remark-gfm（AI 聊天渲染）                       |
| 桌面端     | Electron 33（NSIS / DMG / AppImage 打包）                           |
| 移动端     | Capacitor 8（Android 原生壳）                                       |
| 开发者工具 | MCP Server + TypeScript SDK + CLI + OpenAPI 3.0                     |

### 项目结构

```
nowen-note/
├── frontend/                       # 前端 React 应用
│   ├── src/
│   │   ├── components/             # 业务组件（约 34 个）
│   │   │   ├── Sidebar.tsx             # 侧边栏（笔记本树 + 导航 + 标签）
│   │   │   ├── NoteList.tsx            # 笔记列表（多视图 + 右键菜单）
│   │   │   ├── EditorPane.tsx          # 编辑器面板（AI 标题/标签 + 大纲 + 锁定 + 分享 + 版本历史）
│   │   │   ├── TiptapEditor.tsx        # Tiptap 富文本编辑器
│   │   │   ├── MarkdownEditor.tsx      # CodeMirror Markdown 编辑器
│   │   │   ├── MarkdownSlashMenu.tsx   # Markdown 编辑器斜杠菜单
│   │   │   ├── SlashCommands.tsx       # Tiptap 斜杠命令
│   │   │   ├── CodeBlockView.tsx       # Tiptap 代码块视图（语言切换 / 一键复制）
│   │   │   ├── editors/
│   │   │   │   └── types.ts            # NoteEditorProps / NoteEditorHandle 统一契约
│   │   │   ├── AIChatPanel.tsx         # AI 知识库问答面板（RAG + Markdown 渲染）
│   │   │   ├── AIWritingAssistant.tsx  # AI 写作助手（10 种文本操作）
│   │   │   ├── AISettingsPanel.tsx     # AI 服务配置（6 大 Provider 卡片）
│   │   │   ├── TaskCenter.tsx          # 任务管理中心
│   │   │   ├── MindMapEditor.tsx       # 思维导图编辑器
│   │   │   ├── DiaryCenter.tsx         # 说说/动态（微博风格时间线）
│   │   │   ├── ShareModal.tsx          # 分享弹窗（链接 + 密码 + 有效期 + 权限）
│   │   │   ├── SharedNoteView.tsx      # 公开分享笔记查看页
│   │   │   ├── CommentPanel.tsx        # 评论批注面板（行内锚点 + 回复 + 解决）
│   │   │   ├── VersionHistoryPanel.tsx # 版本历史面板（版本对比 + 回滚）
│   │   │   ├── TagColorPicker.tsx      # 标签颜色选择器
│   │   │   ├── TagInput.tsx            # 标签输入组件
│   │   │   ├── LoginPage.tsx           # 登录页
│   │   │   ├── ServerConnect.tsx       # 服务器连接配置（客户端模式）
│   │   │   ├── ContextMenu.tsx         # 通用右键菜单
│   │   │   ├── SettingsModal.tsx       # 设置中心（外观/AI/安全/数据）
│   │   │   ├── SecuritySettings.tsx    # 账号安全设置
│   │   │   ├── DataManager.tsx         # 数据管理（导入导出 + 恢复出厂）
│   │   │   ├── MiCloudImport.tsx       # 小米云笔记导入
│   │   │   ├── OppoCloudImport.tsx     # OPPO 云便签导入
│   │   │   ├── iCloudImport.tsx        # iPhone/iCloud 备忘录导入
│   │   │   ├── ThemeProvider.tsx       # 主题 Provider
│   │   │   ├── ThemeToggle.tsx         # 主题切换
│   │   │   ├── Toaster.tsx             # 全局 Toast
│   │   │   └── ui/                     # 通用 UI 基元（按钮、对话框等）
│   │   ├── hooks/                  # 自定义 Hooks
│   │   │   ├── useContextMenu.ts       # 右键菜单状态 + 边缘碰撞检测
│   │   │   ├── useCapacitor.ts         # Capacitor 移动端能力（返回键/状态栏/触觉）
│   │   │   └── useSiteSettings.tsx     # 站点设置 Context（标题/图标/字体）
│   │   ├── store/                  # 状态管理（useReducer + Context）
│   │   ├── lib/                    # 工具函数 & API 封装
│   │   │   ├── api.ts                  # API 客户端（含 AI 流式接口）
│   │   │   ├── contentFormat.ts        # Tiptap JSON / Markdown / HTML 互转
│   │   │   ├── markdownCommands.ts     # Markdown 编辑器命令（加粗/列表/标题等）
│   │   │   ├── codeBlockTheme.ts       # Tiptap 代码块主题
│   │   │   ├── exportService.ts        # 导出服务
│   │   │   ├── importService.ts        # 导入服务
│   │   │   ├── miNoteService.ts        # 小米云笔记服务封装
│   │   │   ├── toast.ts                # Toast 工具
│   │   │   └── utils.ts                # 通用工具
│   │   ├── i18n/                   # 国际化配置 & 语言包（中/英）
│   │   └── types/                  # 类型定义
│   ├── capacitor.config.ts         # Capacitor 移动端配置
│   └── android/                    # Android 原生壳
├── backend/                        # 后端 Hono 应用
│   └── src/
│       ├── db/                     # 数据库 Schema & 迁移（16 张表 + FTS5）
│       ├── routes/                 # API 路由（21 个模块）
│       │   ├── auth.ts                 # 认证（登录/改密/恢复出厂）
│       │   ├── notebooks.ts            # 笔记本 CRUD（无限层级）
│       │   ├── notes.ts                # 笔记 CRUD（锁定/置顶/收藏 + Webhook/审计集成）
│       │   ├── tags.ts                 # 标签管理
│       │   ├── tasks.ts                # 待办任务（子任务/优先级/截止日期）
│       │   ├── mindmaps.ts             # 思维导图 CRUD
│       │   ├── diary.ts                # 说说/动态（时间线 + 发布/删除/统计）
│       │   ├── ai.ts                   # AI 聊天 + 写作助手 + RAG 知识问答
│       │   ├── search.ts               # FTS5 全文搜索
│       │   ├── export.ts               # 数据导入导出
│       │   ├── shares.ts               # 笔记分享（链接/密码/权限/评论/版本历史）
│       │   ├── plugins.ts              # 插件管理与执行
│       │   ├── webhooks.ts             # Webhook 管理（CRUD + 测试 + 投递日志）
│       │   ├── audit.ts                # 审计日志（查询/统计/清理）
│       │   ├── backups.ts              # 数据备份与恢复
│       │   ├── settings.ts             # 站点配置（标题/图标/字体）
│       │   ├── fonts.ts                # 自定义字体（上传/下载/删除）
│       │   ├── micloud.ts              # 小米云笔记导入 API
│       │   ├── oppocloud.ts            # OPPO 云便签导入 API
│       │   └── icloud.ts               # iPhone/iCloud 备忘录导入 API
│       ├── services/               # 服务层
│       │   ├── webhook.ts              # Webhook 事件分发（HMAC-SHA256 签名 + 重试）
│       │   ├── audit.ts                # 审计日志记录器
│       │   ├── backup.ts               # 备份管理器（全量/增量 + 自动定时）
│       │   └── openapi.ts              # OpenAPI 3.0 规范生成
│       ├── plugins/                # 插件系统
│       │   └── plugin-loader.ts        # 插件加载器（热加载 + 沙箱执行）
│       └── index.ts                # 入口（JWT 中间件 + 速率限制 + 路由注册 + 静态托管）
├── packages/                       # 开发者工具包
│   ├── nowen-mcp/                  # MCP Server（22 个 AI 工具 + 资源）
│   ├── nowen-sdk/                  # TypeScript SDK（60+ API 方法）
│   └── nowen-cli/                  # 命令行工具（8 组命令）
├── electron/                       # Electron 桌面端
│   ├── main.js                     # 主进程（fork 后端 + 创建窗口）
│   ├── builder.config.js           # electron-builder 打包配置
│   └── icon.png                    # 应用图标
├── scripts/                        # 维护脚本
│   ├── migrate-tiptap-to-md.mjs    # Tiptap JSON → Markdown 批量迁移
│   ├── export-zip.mjs              # 项目打包（archiver）
│   ├── export-zip-jszip.mjs        # 项目打包（JSZip）
│   └── verify-zip.mjs              # 打包产物校验
├── Dockerfile                      # 多阶段构建
├── docker-compose.yml              # 容器编排（单服务 + 持久化卷）
└── package.json                    # 根级脚本
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

**方法 B：纯 docker 命令（仅主应用）**

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

**服务端口：**

| 端口 | 服务 | 说明 |
|------|------|------|
| `3001` | nowen-note | 主应用（前后端一体 + SQLite） |

**环境变量说明：**

| 变量名 | 默认值 | 说明 |
| ------ | ------ | ---- |
| `PORT` | `3001` | 服务监听端口 |
| `DB_PATH` | `/app/data/nowen-note.db` | 数据库文件路径 |
| `NODE_ENV` | `production` | 运行环境 |
| `OLLAMA_URL` | （未设置） | Ollama 服务地址（如需本地 AI 请自行部署 Ollama） |

---

#### 方式三：Electron 桌面客户端

支持 Windows（NSIS 安装程序）、macOS（DMG）、Linux（AppImage）。

```bash
# 开发运行
npm run electron:dev

# 打包发布
npm run electron:build
```

打包产物输出到 `release/` 目录。桌面端自动 fork 后端进程，数据库存储在用户目录 `nowen-data/` 下。

---

#### 方式四：Android 移动端（Capacitor）

基于 Capacitor 8 构建 Android 原生应用，连接远程服务器使用。

**方法 A：使用预编译 APK（推荐）**

直接从 [GitHub Releases](https://github.com/cropflre/nowen-note/releases) 下载最新的 APK 安装包，传输到手机安装即可。

**方法 B：自行编译**

```bash
# 1. 构建前端
npm run build:frontend

# 2. 同步到 Android 项目
npx cap sync android

# 3. 用 Android Studio 打开并构建
npx cap open android

# 或直接命令行打包 Release APK（需配置签名）
cd frontend/android
./gradlew assembleRelease
```

**签名配置：** 如需构建 Release 版本，请在 `frontend/android/` 目录下创建 `keystore.properties` 文件：

```properties
storePassword=你的密码
keyPassword=你的密码
keyAlias=你的别名
storeFile=你的keystore路径
```

移动端首次启动需配置服务器地址（IP:端口 或域名），通过 HTTP 连接到已部署的 nowen-note 后端。

**Android 图标：** 自定义设计的 Nowen Note 品牌图标，深色背景（#0D1117）+ 白色笔记纸 + 蓝色品牌字母 N + 铅笔装饰，支持 Android 自适应图标（Adaptive Icon）。

---

#### 方式五：群晖 Synology NAS 安装

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

> **提示：** 数据备份只需复制 `/docker/nowen-note/data/nowen-note.db` 文件。可使用群晖 Hyper Backup 定期备份该目录。也可通过 API `/api/backups` 进行在线备份管理。

---

#### 方式六：绿联 UGOS NAS 安装

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

#### 方式七：飞牛 fnOS 安装

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

#### 方式八：威联通 QNAP 安装

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

#### 方式九：极空间 NAS 安装

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

#### 方式十：ARM64 开发板 / 国产 SoC（A311D / RK3566 / OES / OECT）

适用于把 aarch64 的开发板当作家庭/小型团队的笔记服务器。典型设备：
Amlogic **A311D**（Cortex-A73+A53）、Rockchip **RK3566**（Cortex-A55），
搭配 OES Linux / Armbian / OpenKylin 等 Debian 系发行版。

**推荐流程（x86 开发机交叉构建 → 板子导入运行）：**

```bash
# 1. 在 x86 开发机上（一次性）注册 QEMU，使 buildx 能跨架构构建
docker run --privileged --rm tonistiigi/binfmt --install arm64

# 2. 构建 arm64 镜像并打成 tar
bash scripts/release.sh --build-only --arch arm64 --tar -y
# 产物：nowen-note-arm64.tar

# 3. 把 tar 文件传到板子（scp / U 盘都行），然后在板子上：
docker load -i nowen-note-arm64.tar
docker run -d \
  --name nowen-note \
  --restart unless-stopped \
  -p 3001:3001 \
  -v nowen-note-data:/app/data \
  cropflre/nowen-note:arm64
```

访问 `http://<板子 IP>:3001` 即可。

更多细节（多架构 manifest、推送到 registry、板子原生构建、常见坑）见
[docs/deploy-arm64.md](docs/deploy-arm64.md)。

---

#### 通用注意事项

- **数据持久化**：务必将容器内的 `/app/data` 目录映射到宿主机，否则容器删除后数据丢失
- **数据备份**：支持两种方式 — 直接备份 `nowen-note.db` 文件，或通过 API `/api/backups` 在线创建/下载备份
- **自动备份**：服务启动后自动开启每 24 小时数据库备份，保留最近 10 个自动备份
- **端口冲突**：如 3001 端口被占用，可修改主机端口映射（如 `8080:3001`）
- **安全建议**：首次登录后请立即修改默认密码；如需外网访问，建议搭配反向代理（Nginx / Caddy）并启用 HTTPS
- **Ollama**：如需本地 AI 推理，请自行部署 Ollama 服务并配置 `OLLAMA_URL` 环境变量

### 核心功能

#### 认证系统
- JWT Token 认证（30 天有效期）
- 登录页面（带动画与默认账号提示）
- 修改用户名 / 密码（需验证当前密码）
- SHA256 → bcrypt 密码哈希自动升级
- 客户端模式支持服务器地址配置（Electron / Android / file:// 协议）

#### 笔记管理
- **三栏布局**：侧边栏 + 笔记列表 + 编辑器（均支持拖拽调整宽度，双击恢复默认）
- **Tiptap 富文本编辑器**：Markdown 快捷键、代码高亮、图片插入、任务列表；AI 写作助手、版本历史、评论批注、分享等所有上层能力都围绕它构建
  - **Markdown 源码编辑器（高级备选）**：基于 CodeMirror 6 + @codemirror/lang-markdown，面向需要纯 Markdown 源码编辑的高级用户。默认对普通用户隐藏切换入口；开发或调试时可在 URL 追加 `?md=1` 强制启用、`?md=0` 强制关闭，选择会记住到 `localStorage["nowen.editor_mode"]`。两套引擎共享 AI 助手、版本历史、评论批注、CRDT 协同等全部上层能力
- **笔记操作**：置顶、收藏、锁定（前后端双层保护）、软删除（回收站）、恢复、永久删除
- **笔记移动**：右键菜单"移动到..."弹窗（树形笔记本选择器）、编辑器顶栏快速切换笔记本
- **字数统计**：实时显示词数和字符数（中文按字计数，英文按空格分词）
- **笔记大纲**：自动提取 H1-H3 标题生成大纲面板，点击标题跳转定位
- **日历筛选**：笔记列表标题栏日历按钮，选择日期后按更新时间筛选笔记
- **乐观锁**：`version` 字段防止编辑冲突；AI 生成标题等写操作在 409 冲突时会自动以最新版本重试一次
- **版本写入节流**：5 分钟窗口内的同类 `edit` 版本会合并，避免 debounce 每次保存都落一条版本
- **快捷键**：`Alt+N` 快速新建笔记

#### 笔记本
- 支持无限层级嵌套（树形结构）
- 右键菜单：新建笔记、新建子笔记本、更换图标、重命名、删除
- 行内重命名：原地 `<input>` 编辑，Enter 保存、Escape 取消
- **自定义图标**：点击笔记本图标或右键「更换图标」弹出 Emoji 选择器（5 分类：物品/表情/科技/自然/食物）

#### AI 智能助手
- **AI 写作助手**：选中文本后触发，支持 10 种操作
  - 续写、重写、润色、缩写、扩写
  - 中英互译、总结、解释、语法修正
  - 支持「替换选中」或「插入到光标后」两种应用方式
- **AI 生成标题**：基于笔记内容一键生成标题
- **AI 推荐标签**：智能推荐标签并自动创建、关联
- **AI 知识问答（RAG）**：
  - 基于 FTS5 + LIKE 模糊检索知识库相关笔记
  - 中文查询会先做 CJK bigram 拆分并过滤停用词，避免整句切不出关键词
  - FTS 查询使用前缀通配，LIKE 兜底同时匹配 `title` 与 `contentText`
  - 仍无命中时回退到最近 5 篇笔记作为上下文
  - SSE 流式输出 + Markdown 渲染；支持多轮对话（自动携带最近 6 条历史消息）
  - 显示参考笔记来源标签
- **多 AI 服务商支持**：

| 服务商 | 默认模型 | 说明 |
|--------|---------|------|
| 通义千问 | qwen-plus | 阿里云 DashScope |
| OpenAI | gpt-4o-mini | OpenAI 官方 |
| Google Gemini | gemini-2.0-flash | Google AI Studio |
| DeepSeek | deepseek-chat | DeepSeek 官方 |
| 豆包（火山引擎） | doubao-1.5-pro-32k | 字节跳动 |
| Ollama | qwen2.5:7b | 本地部署，无需 API Key |

- **卡片式 Provider 选择**：渐变色图标、配置状态指示、自动填充 URL 和模型
- **连接测试 & 模型列表拉取**：实时验证配置可用性

#### 笔记分享协作
- **链接分享**：一键生成分享链接，支持复制短链接
- **密码保护**：可选设置访问密码，前端密码验证页面
- **有效期控制**：支持 1 小时 / 1 天 / 7 天 / 30 天 / 永久
- **最大访问次数**：可限制分享链接的查看次数
- **权限管理**：只读 / 可评论两种权限模式
- **评论批注**：支持行内锚点批注、回复、标记已解决
- **分享管理**：查看所有分享链接、访问统计、一键禁用/删除
- **安全防护**：速率限制（每分钟 60 次访问 + 密码验证每分钟 10 次）、安全响应头

#### 版本历史
- **自动记录**：笔记每次保存自动创建版本快照，同 5 分钟窗口内的 `edit` 版本自动合并，避免刷屏
- **版本列表**：按时间倒序展示所有历史版本
- **版本对比**：查看任意版本的标题和内容
- **版本回滚**：一键恢复到历史版本
- **变更摘要**：自动记录变更类型（`edit` / `create` / `rollback`）

#### 思维导图
- 可视化脑图编辑器，自研树形布局算法
- 节点操作：新增子节点、编辑、删除、折叠/展开
- 支持键盘快捷键（Tab/Enter/Delete/Space）
- 小地图导航，缩放平移，触摸手势
- 右键导出：PNG（2x 高清）、SVG、.xmind 格式
- 移动端适配：长按编辑节点、长按列表项触发导出菜单、响应式布局

#### 任务管理
- **任务中心**：独立任务管理面板，桌面端三栏布局（筛选面板 + 列表 + 详情）
- **优先级**：高 / 中 / 低三级优先级
- **截止日期**：日期选择，智能显示（今天/明天/本周/已逾期）
- **子任务**：父子关系任务拆分
- **多维筛选**：全部 / 今天 / 本周 / 逾期 / 已完成
- **任务统计**：完成率、逾期数等摘要
- **移动端适配**：水平滚动筛选标签、任务详情全屏覆盖、触摸友好的删除按钮

#### 说说/动态
- **微博风格时间线**：一句话快速发布，轻量便捷
- **发布框**：文字输入 + 心情选择（12 种）+ `Ctrl+Enter` 快捷发布
- **动态卡片**：内容 + 心情 emoji + 相对时间显示 + 删除（二次确认）
- **时间线分组**：按日期自动分组（今天/昨天/具体日期），游标分页加载更多
- **统计概览**：总动态数 + 今日发布数

#### 插件系统
- **热加载**：自动扫描 `data/plugins/` 目录加载插件
- **沙箱执行**：隔离运行插件代码，防止系统影响
- **标准化接口**：插件声明 `manifest.json`（名称/版本/能力）
- **能力注册**：`note-processor`（笔记处理）、`exporter`（导出器）等
- **API 管理**：列出插件 / 重新加载 / 执行指定插件

#### Webhook 事件系统
- **12 种事件类型**：
  - `note.created` / `note.updated` / `note.deleted` / `note.trashed`
  - `notebook.created` / `notebook.deleted`
  - `tag.created`
  - `task.created` / `task.completed`
  - `plugin.executed`
  - `*`（通配：接收所有事件）
- **HMAC-SHA256 签名**：`X-Nowen-Signature` 请求头，防止伪造
- **自动重试**：最多 3 次，指数退避（1s → 2s → 4s）
- **10 秒超时**：防止回调卡住
- **投递日志**：完整记录每次推送的状态码、响应体、尝试次数
- **测试发送**：一键发送测试事件验证 Webhook 配置

#### 审计日志
- **10 大分类**：auth / note / notebook / tag / task / share / ai / plugin / system
- **3 个级别**：info / warn / error
- **自动记录**：笔记创建/删除等关键操作自动写入审计日志
- **多维查询**：按用户/分类/级别/目标/日期范围/分页查询
- **统计看板**：总记录数、今日操作数、按分类/级别统计
- **自动清理**：支持配置保留天数（默认 90 天），定期清理过期日志

#### 数据备份与恢复
- **两种备份模式**：
  - `db-only` — 仅备份数据库文件（SQLite 在线备份）
  - `full` — 全量备份（JSON 导出所有表数据）
- **自动备份**：服务启动后每 24 小时自动创建数据库备份，保留最近 10 个
- **SHA256 校验**：每个备份文件自动生成校验和
- **在线下载**：通过 API 直接下载备份文件
- **一键恢复**：从全量备份事务恢复，显示每张表恢复的行数
- **备份管理**：列出 / 创建 / 下载 / 删除备份

#### 全文搜索
- 基于 SQLite FTS5 虚拟表
- 通过触发器自动同步索引（INSERT/UPDATE/DELETE）
- 搜索 title + contentText

#### 标签系统
- 多对多关系，彩色标签
- 侧边栏标签面板快速筛选

#### 右键菜单系统
- 通用右键菜单组件（毛玻璃面板 + 动画出入场）
- 四方向边缘碰撞检测（菜单不会溢出屏幕，8px 安全边距）
- 支持分隔线、危险操作高亮、禁用状态
- 笔记本列表 & 笔记列表均支持右键操作

#### 数据管理
- **导出备份**：全量导出为 ZIP 压缩包（Markdown + YAML frontmatter），含进度条
- **导入笔记**：支持拖拽上传 `.md` / `.txt` / `.html` / `.zip` 文件，可选择目标笔记本
- **小米云笔记导入**：通过 Cookie 认证连接小米云服务，自动获取笔记列表并批量导入
- **OPPO 云便签导入**：提供浏览器控制台提取脚本（OPPO 便签内容 AES 加密，仅页面端解密），一键复制脚本 → 粘贴 JSON → 选择导入
- **iPhone/iCloud 备忘录导入**：提供两种导入方式
  - 方式一：通过 Mac/iPhone 直接导出为 .txt / .md / .html 文件后导入（推荐）
  - 方式二：通过 iCloud 网页端控制台脚本自动提取，支持自动逐条点击 → 提取内容 → 复制到剪贴板 → 粘贴 JSON → 选择导入。自动转换 Apple Notes Checklist 为 Tiptap taskList 格式
- **恢复出厂设置**：清空所有数据并重置管理员账户，二次确认防误触（需输入 `RESET`）

#### 设置中心
- **外观设置**：主题切换（浅色 / 深色 / 跟随系统）、站点名称与图标自定义
- **字体管理**：内置 4 种字体方案（默认 / 系统 / 衬线 / 等宽）+ 自定义字体上传（支持 otf/ttf/otc/ttc/woff/woff2，支持批量），实时预览
- **AI 设置**：AI 服务商配置、连接测试、模型管理
- **账号安全**：修改用户名和密码
- **数据管理**：导入导出与恢复出厂

#### 主题与交互
- 深色 / 浅色 / 跟随系统三种主题模式
- 侧边栏可折叠（仅图标模式）
- 国际化支持：中英文双语切换
- Framer Motion 丝滑动画
- 全局快捷键：`Alt+N` 快速新建笔记
- **移动端全面适配**：
  - 抽屉式侧边栏（滑动手势开关）+ 列表/编辑器双视图切换
  - TaskCenter 响应式三栏 → 移动端水平筛选标签 + 全屏详情
  - SettingsModal 移动端全屏 + 顶部标签栏切换
  - EditorPane 移动端「更多操作」菜单（删除/移动/AI/大纲）
  - 触摸友好：所有 hover 交互按钮在移动端始终可见
  - ContextMenu 四方向边界碰撞检测
  - 编辑器元信息自动折行、MoveNoteModal 自适应宽度
  - 日历筛选移动端入口、MindMap 列表长按导出
  - safe-area-inset 安全区域适配（刘海屏 / 底部手势条）

#### 多端支持
- **Web 端**：浏览器直接访问，响应式布局适配桌面和移动端
- **Electron 桌面端**：Windows（NSIS）/ macOS（DMG）/ Linux（AppImage），自动管理后端进程，数据存储在用户目录
- **Android 移动端**：基于 Capacitor 构建原生应用，自定义品牌图标，支持 Release 签名打包，连接远程服务器使用
- **客户端模式**：Electron 和 Android 端支持配置服务器地址，通过 HTTP 连接到已部署的后端

### 开发者工具

#### MCP Server（`nowen-mcp`）

为 AI 助手（Claude、Cursor、Windsurf 等）提供 22 个可调用的工具和资源，实现 AI 直接操作笔记系统。

**安装与配置：**
```json
{
  "mcpServers": {
    "nowen-note": {
      "command": "npx",
      "args": ["tsx", "packages/nowen-mcp/src/index.ts"],
      "env": {
        "NOWEN_API_URL": "http://localhost:3001",
        "NOWEN_TOKEN": "你的JWT Token"
      }
    }
  }
}
```

**工具列表（22 个）：**

| 工具 | 说明 |
|------|------|
| `nowen_list_notebooks` | 获取笔记本列表（树形） |
| `nowen_create_notebook` | 创建笔记本 |
| `nowen_list_notes` | 获取笔记列表 |
| `nowen_get_note` | 获取笔记详情 |
| `nowen_create_note` | 创建笔记 |
| `nowen_update_note` | 更新笔记 |
| `nowen_delete_note` | 删除笔记 |
| `nowen_search_notes` | 全文搜索 |
| `nowen_list_tags` | 获取标签列表 |
| `nowen_create_tag` | 创建标签 |
| `nowen_list_tasks` | 获取任务列表 |
| `nowen_create_task` | 创建任务 |
| `nowen_toggle_task` | 切换任务完成状态 |
| `nowen_ai_chat` | AI 知识库问答 |
| `nowen_list_webhooks` | 获取 Webhook 列表 |
| `nowen_create_webhook` | 创建 Webhook |
| `nowen_audit_stats` | 审计统计 |
| `nowen_list_backups` | 获取备份列表 |
| `nowen_create_backup` | 创建数据备份 |
| `nowen_list_plugins` | 获取插件列表 |

#### TypeScript SDK（`@nowen/sdk`）

提供 60+ 类型安全的 API 方法，完整覆盖所有后端能力。

**安装：**
```bash
npm install @nowen/sdk
```

**使用示例：**
```typescript
import { NowenClient } from "@nowen/sdk";

const client = new NowenClient({
  baseUrl: "http://localhost:3001",
  token: "your-jwt-token",
});

// 获取笔记列表
const notes = await client.listNotes({ notebookId: "xxx" });

// 创建笔记
const note = await client.createNote({
  notebookId: "xxx",
  title: "新笔记",
  content: "...",
});

// AI 知识问答
const answer = await client.askAI("项目有哪些新功能？");

// 创建 Webhook
const webhook = await client.createWebhook({
  url: "https://your-server.com/hook",
  events: ["note.created", "note.updated"],
});

// 创建备份
const backup = await client.createBackup("full");
```

**API 分组：**

| 分组 | 方法数 | 能力 |
|------|--------|------|
| 认证 | 3 | 登录 / 验证 / 改密 |
| 笔记本 | 4 | CRUD |
| 笔记 | 8 | CRUD + 收藏/置顶/锁定/移动 |
| 标签 | 4 | CRUD + 笔记关联 |
| 任务 | 5 | CRUD + 切换状态 + 统计 |
| 搜索 | 1 | 全文搜索 |
| AI | 5 | 聊天/问答/设置/模型/知识统计 |
| 导出 | 2 | 导出/导入 |
| 管道 | 4 | 列表/创建/执行/步骤类型 |
| 插件 | 3 | 列表/重新加载/执行 |
| 分享 | 4 | 创建/列表/删除/更新 |
| 思维导图 | 4 | CRUD |
| Webhook | 6 | CRUD + 测试 + 投递日志 |
| 审计 | 3 | 查询/统计/清理 |
| 备份 | 5 | 列表/创建/恢复/删除/自动备份 |
| 系统 | 3 | 健康检查/设置/用户信息 |

#### 命令行工具（`nowen-cli`）

终端中管理笔记系统，支持 8 组命令。

**安装与配置：**
```bash
# 安装依赖
cd packages/nowen-cli && npm install

# 配置服务器
npx nowen config set-url http://localhost:3001
npx nowen config set-token <your-jwt-token>

# 查看配置
npx nowen config show
```

**命令列表：**

```bash
# 笔记操作
nowen notes list [--notebook <id>]        # 列出笔记
nowen notes get <id>                       # 查看笔记
nowen notes create --notebook <id> --title "标题"  # 创建笔记
nowen notes update <id> --title "新标题"   # 更新笔记
nowen notes delete <id>                    # 删除笔记
nowen notes search <关键词>                # 搜索笔记

# 笔记本操作
nowen notebooks list                       # 列出笔记本
nowen notebooks create --name "名称"       # 创建笔记本

# 标签操作
nowen tags list                            # 列出标签
nowen tags create --name "标签名"          # 创建标签

# 任务操作
nowen tasks list [--status <状态>]         # 列出任务
nowen tasks create --title "任务名"        # 创建任务
nowen tasks toggle <id>                    # 切换完成状态

# 搜索
nowen search <关键词>                      # 全文搜索

# AI
nowen ai ask "你的问题"                    # 知识库问答
nowen ai chat "对话内容"                   # AI 对话

# 配置
nowen config show                          # 显示配置
nowen config set-url <url>                 # 设置服务器地址
nowen config set-token <token>             # 设置 JWT Token
```

#### OpenAPI 规范

提供完整的 OpenAPI 3.0 规范文档，可供 Swagger UI、Postman 等工具消费。

```
GET http://localhost:3001/api/openapi.json
```

覆盖 16 个 API 分组、50+ 端点，包含完整的请求/响应 Schema 定义。

### NPM 脚本

| 命令                       | 说明                             |
| -------------------------- | -------------------------------- |
| `npm run install:all`      | 一键安装前后端所有依赖           |
| `npm run dev:backend`      | 开发模式启动后端（端口 3001）    |
| `npm run dev:frontend`     | 开发模式启动前端（端口 5173）    |
| `npm run build:all`        | 全量构建前后端                   |
| `npm run build:frontend`   | 仅构建前端                       |
| `npm run build:backend`    | 仅构建后端                       |
| `npm run electron:dev`     | Electron 开发运行                |
| `npm run electron:build`   | Electron 打包发布                |
| `npm run zip`              | 项目打包（archiver）             |
| `npm run zip:jszip`        | 项目打包（JSZip）                |

### 数据迁移脚本

项目提供一个一次性迁移脚本 `scripts/migrate-tiptap-to-md.mjs`，用于将历史 Tiptap JSON 笔记批量转换为 Markdown 格式（配合 Markdown 编辑器使用）。

**运行前提：**
- 已安装后端依赖（含 `better-sqlite3`）
- **强烈建议先停掉后端服务**，避免写入冲突
- `--apply` 模式会先生成 `<dbfile>.bak-<时间戳>` 的全库备份

**常用命令：**

```bash
# 1. 预览（默认 dry-run，只打印会改动的笔记摘要，不写库）
node scripts/migrate-tiptap-to-md.mjs

# 2. 指定数据库路径预览
node scripts/migrate-tiptap-to-md.mjs --db backend/data/nowen-note.db

# 3. 仅处理指定笔记 ID
node scripts/migrate-tiptap-to-md.mjs --ids abc123,def456 --verbose

# 4. 仅处理前 50 条用于抽样验证
node scripts/migrate-tiptap-to-md.mjs --limit 50 --verbose

# 5. 真正写入（会先自动备份 DB）
node scripts/migrate-tiptap-to-md.mjs --apply
```

**参数说明：**

| 参数 | 说明 |
|------|------|
| `--db <path>` | 指定 SQLite 路径，默认按 `$DB_PATH` → `backend/data/nowen-note.db` |
| `--dry-run` | 只预览（默认行为），不写库 |
| `--apply` | 真正执行写入，会自动创建 `.bak-<timestamp>` 备份 |
| `--limit N` | 最多处理 N 条笔记 |
| `--ids a,b,c` | 仅处理指定笔记 ID（逗号分隔） |
| `--verbose` | 打印每条笔记的转换细节 |
| `--help` | 显示帮助 |

脚本只修改 `notes.content` 字段；`contentText` 保持原值，FTS5 全文搜索索引不受影响。识别为 `empty` / `md` / `html` 的笔记会自动跳过。

### Docker Compose 架构

```
┌───────────────────────────────────────────┐
│              Docker Compose                │
│                                           │
│  ┌─────────────────────────────────────┐  │
│  │           nowen-note :3001          │  │
│  │                                     │  │
│  │  ┌─────────────┐                    │  │
│  │  │  Frontend   │                    │  │
│  │  │  React      │                    │  │
│  │  │  Tiptap/MD  │                    │  │
│  │  ├─────────────┤                    │  │
│  │  │  Backend    │                    │  │
│  │  │  Hono       │◄──► 外部 AI API:   │  │
│  │  │  SQLite     │     通义千问       │  │
│  │  │  JWT        │     OpenAI/Gemini  │  │
│  │  │             │     DeepSeek/豆包   │  │
│  │  └─────────────┘     Ollama（可选）  │  │
│  └─────────────────────────────────────┘  │
└───────────────────────────────────────────┘
```

| 服务 | 镜像 | 端口 | 持久化卷 | 说明 |
|------|------|------|---------|------|
| nowen-note | 自构建 | 3001 | nowen-note-data | 主应用（前后端一体 + SQLite） |

### 数据库设计

16 张数据表 + 1 张 FTS5 全文搜索虚拟表：

| 表名 | 说明 |
|------|------|
| `users` | 用户表（用户名/密码哈希/头像） |
| `notebooks` | 笔记本（支持 parentId 无限层级嵌套） |
| `notes` | 笔记（JSON 内容 + 纯文本 + 锁定/置顶/收藏/归档/回收站） |
| `tags` | 标签（彩色标签） |
| `note_tags` | 笔记-标签多对多关联 |
| `attachments` | 附件 |
| `tasks` | 待办任务（支持子任务 parentId + 优先级 + 截止日期） |
| `diaries` | 说说/动态（内容 + 心情 + 时间戳） |
| `system_settings` | 系统设置键值对（含 AI 配置） |
| `custom_fonts` | 自定义字体 |
| `shares` | 分享记录（链接/密码/权限/有效期/访问统计） |
| `note_versions` | 笔记版本历史 |
| `share_comments` | 评论批注（行内锚点 + 回复 + 已解决标记） |
| `webhooks` | Webhook 配置（URL/事件/密钥/状态） |
| `webhook_deliveries` | Webhook 投递日志（响应状态/重试次数） |
| `audit_logs` | 审计日志（10 分类 + 3 级别 + 操作详情） |
| `notes_fts` | FTS5 全文搜索虚拟表（通过触发器自动同步） |

### API 路由一览

| 路径 | 认证 | 说明 |
|------|------|------|
| `/api/auth` | ✗ | 登录 / 改密 / 恢复出厂 |
| `/api/health` | ✗ | 健康检查 |
| `/api/openapi.json` | ✗ | OpenAPI 3.0 规范文档 |
| `GET /api/settings` | ✗ | 站点设置（品牌信息） |
| `GET /api/fonts` | ✗ | 字体列表 / 字体文件 |
| `/api/shared` | ✗ | 分享公开访问（速率限制） |
| `/api/notebooks` | ✓ | 笔记本 CRUD |
| `/api/notes` | ✓ | 笔记 CRUD |
| `/api/tags` | ✓ | 标签管理 |
| `/api/search` | ✓ | FTS5 全文搜索 |
| `/api/tasks` | ✓ | 待办任务 |
| `/api/mindmaps` | ✓ | 思维导图 CRUD |
| `/api/diary` | ✓ | 说说/动态（发布/时间线/删除/统计） |
| `/api/ai` | ✓ | AI 聊天 + 写作助手 + RAG |
| `/api/shares` | ✓ | 分享管理（创建/列表/更新/删除） |
| `/api/plugins` | ✓ | 插件（列表/重新加载/执行） |
| `/api/webhooks` | ✓ | Webhook（CRUD + 测试 + 投递日志） |
| `/api/audit` | ✓ | 审计日志（查询/统计/清理） |
| `/api/backups` | ✓ | 备份恢复（列表/创建/下载/恢复/自动） |
| `/api/export` | ✓ | 数据导入导出 |
| `/api/settings` | ✓ | 站点配置（写操作） |
| `/api/fonts` | ✓ | 字体上传 / 删除 |
| `/api/micloud` | ✓ | 小米云笔记导入 |
| `/api/oppocloud` | ✓ | OPPO 云便签导入 |
| `/api/icloud` | ✓ | iCloud 备忘录导入 |
| `/api/me` | ✓ | 当前用户信息 |

---

## English Documentation

### Table of Contents

- [Introduction](#introduction)
- [Tech Stack](#tech-stack)
- [Installation & Deployment](#installation--deployment)
- [Key Features](#key-features)
- [Developer Tools](#developer-tools)
- [NPM Scripts](#npm-scripts)
- [Data Migration Script](#data-migration-script)
- [Docker Compose Architecture](#docker-compose-architecture)
- [Database Design](#database-design)
- [API Routes](#api-routes)

### Introduction

**nowen-note** is a self-hosted private knowledge management application with a modern frontend–backend separated architecture. It supports one-click Docker deployment, an Electron desktop client, and an Android mobile app built on Capacitor.

All-in-one capabilities:

- **Dual editor engines**: Tiptap 3 rich-text + CodeMirror 6 Markdown, switchable at runtime
- **AI assistant**: 6 providers (Qwen / OpenAI / Gemini / DeepSeek / Doubao / Ollama) powering writing assistant, title generation, tag suggestion, and RAG knowledge Q&A
- **Knowledge management**: unlimited nested notebooks, colored tags, tasks, mind maps, moments, and FTS5 full-text search
- **Collaboration & history**: note sharing (password / expiry / permissions / inline comments) and version history
- **Automation**: sandboxed hot-reload plugin system, Webhook events, and audit logs
- **Data governance**: scheduled auto-backups with one-click restore; multi-platform import (Mi / OPPO / iCloud notes) and Markdown + YAML frontmatter export
- **Developer ecosystem**: MCP Server (22 AI tools), TypeScript SDK (60+ APIs), CLI (8 command groups), and OpenAPI 3.0 spec

### Tech Stack

| Layer           | Technology                                                                    |
| --------------- | ----------------------------------------------------------------------------- |
| Frontend        | React 18 + TypeScript + Vite 5                                                |
| Rich Text       | Tiptap 3 (code highlight, image, task list, underline, text highlight, etc.)  |
| Markdown        | CodeMirror 6 + `@codemirror/lang-markdown`                                    |
| UI Components   | Radix UI + shadcn/ui style components + Lucide Icons                          |
| Styling         | Tailwind CSS 3.4 + Framer Motion                                              |
| i18n            | i18next (Chinese / English)                                                   |
| Backend         | Hono 4 + `@hono/node-server`                                                  |
| Database        | SQLite (better-sqlite3) + FTS5 full-text search                               |
| Auth            | JWT (jsonwebtoken) + bcryptjs password hashing                                |
| Validation      | Zod                                                                           |
| AI Engine       | Qwen / OpenAI / Google Gemini / DeepSeek / Doubao / Ollama                    |
| Data Utils      | JSZip (compression), Turndown (HTML→Markdown), FileSaver                      |
| Markdown Render | react-markdown + remark-gfm (AI chat rendering)                               |
| Desktop         | Electron 33 (NSIS / DMG / AppImage packaging)                                 |
| Mobile          | Capacitor 8 (Android native shell)                                            |
| Dev Tools       | MCP Server + TypeScript SDK + CLI + OpenAPI 3.0                               |

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

**Method B: docker run (main app only)**

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

**Service Ports:**

| Port | Service | Description |
|------|---------|-------------|
| `3001` | nowen-note | Main app (frontend + backend + SQLite) |

**Environment Variables:**

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `PORT` | `3001` | Server listen port |
| `DB_PATH` | `/app/data/nowen-note.db` | Database file path |
| `NODE_ENV` | `production` | Runtime environment |
| `OLLAMA_URL` | (not set) | Ollama service URL (deploy Ollama yourself if local AI is needed) |

#### Option 3: Electron Desktop Client

Supports Windows (NSIS installer), macOS (DMG), and Linux (AppImage).

```bash
# Development run
npm run electron:dev

# Build for release
npm run electron:build
```

Output goes to the `release/` directory. The desktop client automatically forks the backend process and stores data in the user's `nowen-data/` directory.

#### Option 4: Android Mobile (Capacitor)

Built with Capacitor 8 as a native Android app, connecting to a remote server.

```bash
# 1. Build frontend
npm run build:frontend

# 2. Sync to Android project
npx cap sync android

# 3. Open and build in Android Studio
npx cap open android
```

On first launch, configure the server address (IP:port or domain) to connect to your deployed nowen-note backend via HTTP.

**Android Icon:** Custom-designed Nowen Note brand icon — dark background (#0D1117) + white note paper + blue brand letter N + pencil decoration, supporting Android Adaptive Icons.

#### Option 5: NAS Deployment (Synology / QNAP / UGREEN / fnOS / Zspace)

All NAS platforms with Docker support follow the same general steps:

1. **Build & export image** on your PC: `docker build -t nowen-note . && docker save nowen-note -o nowen-note.tar`
2. **Import** `nowen-note.tar` into your NAS Docker manager
3. **Create container** with:
   - Port mapping: host `3001` → container `3001`
   - Volume mapping: host folder → container `/app/data`
   - Restart policy: always / unless-stopped
4. Visit `http://<nas-ip>:3001`

> **Important:** Always map the `/app/data` directory to persist your database. Back up the `nowen-note.db` file for data safety, or use the built-in backup API at `/api/backups`.

### Key Features

#### Authentication
- JWT Token authentication (30-day expiry)
- Login page with animation and default credential hints
- Change username / password (requires current password verification)
- Automatic SHA256 → bcrypt password hash upgrade
- Client mode: server address configuration for Electron / Android / file:// protocol

#### Note Management
- **Three-column layout**: Sidebar + Note List + Editor (all resizable via drag, double-click to reset)
- **Dual editor engines**:
  - **Tiptap rich-text editor (default)**: Markdown shortcuts, code highlighting, image upload, task lists
  - **Markdown editor (switchable)**: Built on CodeMirror 6 + @codemirror/lang-markdown, pure Markdown source editing with slash menu, inline AI assistant popover, keyboard shortcuts (bold/italic/heading/list, etc.). Shares the same AI writing assistant, version history, comments, and all higher-level features with Tiptap
  - **How to switch**: Click the `MD` / `RTE` badge button on the top-right of the editor toolbar; or append `?md=1` (force MD) / `?md=0` (force Tiptap) to the URL. The preference is persisted to `localStorage["nowen.editor_mode"]`
- **Note operations**: Pin, favorite, lock (frontend + backend dual-layer protection), soft delete (trash), restore, permanent delete
- **Move notes**: Right-click "Move to..." modal (tree notebook selector) + quick notebook switch in editor header
- **Word count**: Real-time word and character count (CJK characters counted individually, English by whitespace)
- **Note outline**: Auto-extract H1-H3 headings into outline panel with click-to-scroll navigation
- **Calendar filter**: Calendar button in note list header, filter notes by update date
- **Optimistic locking**: `version` field prevents edit conflicts; write operations such as AI title generation automatically retry once with the latest version on a 409 conflict
- **Version write throttling**: consecutive `edit` versions within a 5-minute window are merged to avoid flooding the version list on every debounce save
- **Keyboard shortcut**: `Alt+N` for quick note creation

#### Notebooks
- Unlimited nested hierarchy (tree structure)
- Context menu: New note, new sub-notebook, change icon, rename, delete
- Inline rename: In-place `<input>` editing, Enter to save, Escape to cancel
- **Custom icons**: Click notebook icon or right-click "Change Icon" to open Emoji picker (5 categories: Objects/Smileys/Tech/Nature/Food)

#### AI Smart Assistant
- **AI Writing Assistant**: Triggered on text selection, 10 operations
  - Continue, rewrite, polish, shorten, expand
  - Translate (CN↔EN), summarize, explain, fix grammar
  - Apply via "Replace selection" or "Insert after cursor"
- **AI Title Generation**: One-click title generation based on note content
- **AI Tag Suggestion**: Smart tag recommendation with auto-creation
- **AI Knowledge Q&A (RAG)**:
  - Retrieves related notes via FTS5 + LIKE fuzzy search
  - Chinese queries are pre-tokenized with CJK bigram expansion and stop-word filtering, so full sentences are still able to produce usable keywords
  - FTS queries use prefix wildcards; the LIKE fallback matches both `title` and `contentText`
  - If no notes match, falls back to the 5 most recently updated notes as context
  - SSE streaming output with Markdown rendering; multi-turn conversation (last 6 messages as history)
  - Displays referenced note source tags
- **Multi-provider support**:

| Provider | Default Model | Description |
|----------|--------------|-------------|
| Qwen | qwen-plus | Alibaba DashScope |
| OpenAI | gpt-4o-mini | OpenAI Official |
| Google Gemini | gemini-2.0-flash | Google AI Studio |
| DeepSeek | deepseek-chat | DeepSeek Official |
| Doubao (Volcengine) | doubao-1.5-pro-32k | ByteDance |
| Ollama | qwen2.5:7b | Local deployment, no API key needed |

- **Card-style provider selection**: Gradient icons, config status indicators, auto-fill URL & model
- **Connection test & model list fetch**: Real-time configuration validation

#### Note Sharing & Collaboration
- **Link sharing**: One-click shareable link generation with short URL copy
- **Password protection**: Optional access password with frontend verification page
- **Expiry control**: 1 hour / 1 day / 7 days / 30 days / permanent options
- **Max view count**: Limit the number of views for a shared link
- **Permission management**: Read-only / commentable permission modes
- **Inline comments**: Anchor-based inline annotations, replies, and resolved marks
- **Share management**: View all shares, access statistics, one-click disable/delete
- **Security**: Rate limiting (60 req/min for access + 10 req/min for password verification), security headers

#### Version History
- **Auto-snapshot**: Every save automatically creates a version snapshot; consecutive `edit` versions within a 5-minute window are merged
- **Version list**: All historical versions displayed in reverse chronological order
- **Version comparison**: View title and content of any historical version
- **Rollback**: One-click restore to any previous version
- **Change summary**: Automatic change type recording (`edit` / `create` / `rollback`)

#### Mind Mapping
- Visual mind map editor with custom tree layout algorithm
- Node operations: add child, edit, delete, collapse/expand
- Keyboard shortcuts (Tab/Enter/Delete/Space)
- Mini-map navigation, zoom/pan, touch gestures
- Right-click export: PNG (2x HD), SVG, .xmind format
- Mobile responsive: long-press to edit nodes, long-press list items for export menu, adaptive layout

#### Task Management
- **Task Center**: Dedicated task management panel with desktop three-column layout (filter panel + list + detail)
- **Priority levels**: High / Medium / Low
- **Due dates**: Date picker with smart display (today/tomorrow/this week/overdue)
- **Subtasks**: Parent-child task breakdown
- **Multi-filter**: All / Today / This Week / Overdue / Completed
- **Task statistics**: Completion rate, overdue count summary
- **Mobile adaptive**: Horizontal scrollable filter tabs, full-screen task detail overlay, touch-friendly delete buttons

#### Moments / Status Updates
- **Weibo-style timeline**: Quick one-liner posting, lightweight and fast
- **Compose box**: Text input + mood selection (12 moods) + `Ctrl+Enter` quick post
- **Moment cards**: Content + mood emoji + relative time display + delete (with confirmation)
- **Timeline grouping**: Auto-grouped by date (today/yesterday/specific date), cursor-based pagination
- **Stats overview**: Total moments count + today's post count

#### Plugin System
- **Hot reload**: Auto-scan `data/plugins/` directory for plugins
- **Sandboxed execution**: Isolated plugin code execution for safety
- **Standardized interface**: Plugin `manifest.json` declaration (name/version/capabilities)
- **Capability registration**: `note-processor` (note processing), `exporter` (export), etc.
- **API management**: List plugins / reload / execute specific plugin

#### Webhook Event System
- **12 event types**:
  - `note.created` / `note.updated` / `note.deleted` / `note.trashed`
  - `notebook.created` / `notebook.deleted`
  - `tag.created`
  - `task.created` / `task.completed`
  - `plugin.executed`
  - `*` (wildcard: receive all events)
- **HMAC-SHA256 signature**: `X-Nowen-Signature` header for tamper prevention
- **Auto-retry**: Up to 3 attempts with exponential backoff (1s → 2s → 4s)
- **10-second timeout**: Prevents blocking on slow callbacks
- **Delivery logs**: Complete record of each delivery (status code, response body, attempt count)
- **Test delivery**: One-click test event to verify Webhook configuration

#### Audit Logging
- **10 categories**: auth / note / notebook / tag / task / share / ai / plugin / system
- **3 levels**: info / warn / error
- **Auto-logging**: Key operations (note create/delete, etc.) automatically recorded
- **Multi-dimensional query**: By user / category / level / target / date range / pagination
- **Statistics dashboard**: Total records, today's operations, by-category/level breakdown
- **Auto-cleanup**: Configurable retention period (default 90 days)

#### Data Backup & Restore
- **Two backup modes**:
  - `db-only` — Database file backup (SQLite online backup)
  - `full` — Full backup (JSON export of all table data)
- **Auto-backup**: Database backup every 24 hours on startup, retains latest 10
- **SHA256 checksum**: Auto-generated checksum for each backup file
- **Online download**: Download backup files directly via API
- **One-click restore**: Transactional restore from full backup, showing row counts per table
- **Backup management**: List / create / download / delete backups

#### Full-text Search
- Based on SQLite FTS5 virtual tables
- Auto-synced via triggers (INSERT/UPDATE/DELETE)
- Searches both title and contentText

#### Tag System
- Many-to-many relationships with colored tags
- Sidebar tag panel for quick filtering

#### Context Menu System
- Reusable component (frosted glass panel + animated transitions)
- Four-direction edge collision detection (menu never overflows screen, 8px safe margin)
- Supports separators, danger action highlighting, disabled states
- Available on both notebook tree and note list

#### Data Management
- **Export backup**: Full export as ZIP archive (Markdown + YAML frontmatter) with progress bar
- **Import notes**: Drag-and-drop `.md` / `.txt` / `.html` / `.zip` files, choose target notebook
- **Mi Cloud import**: Connect to Xiaomi Cloud via cookie authentication, auto-fetch and batch import
- **OPPO Cloud import**: Browser console extraction script (AES-encrypted, client-side only), copy script → paste JSON → import
- **iPhone/iCloud import**: Two import methods
  - Method 1: Export from Mac/iPhone as .txt / .md / .html files and import directly (recommended)
  - Method 2: Browser console script for iCloud web — auto-clicks notes one by one → extracts content → copies JSON to clipboard → paste and import. Automatically converts Apple Notes Checklist to Tiptap taskList format
- **Factory reset**: Wipe all data and reset admin account, requires typing `RESET` to confirm

#### Settings Center
- **Appearance**: Theme switch (light / dark / system), custom site name and favicon
- **Font management**: 4 built-in font schemes (default / system / serif / monospace) + custom font upload (otf/ttf/otc/ttc/woff/woff2, batch upload), live preview
- **AI settings**: AI provider configuration, connection test, model management
- **Account Security**: Change username and password
- **Data Management**: Import/export and factory reset

#### Theme & Interaction
- Light / Dark / System three theme modes
- Collapsible sidebar (icon-only mode)
- Internationalization: Chinese/English language switching
- Smooth Framer Motion animations
- Global keyboard shortcut: `Alt+N` for quick note creation
- **Comprehensive mobile adaptation**:
  - Drawer-style sidebar (swipe gesture toggle) + list/editor dual-view switch
  - TaskCenter responsive: desktop three-column → mobile horizontal filter tabs + full-screen detail
  - SettingsModal mobile full-screen + top tab bar navigation
  - EditorPane mobile "More actions" menu (delete/move/AI/outline)
  - Touch-friendly: all hover-dependent buttons always visible on mobile
  - ContextMenu four-direction boundary collision detection
  - Editor meta info auto-wrap, MoveNoteModal responsive width
  - Calendar filter mobile entry, MindMap list long-press export
  - safe-area-inset adaptation (notch / gesture bar)

#### Multi-platform Support
- **Web**: Browser access with responsive layout for desktop and mobile
- **Electron Desktop**: Windows (NSIS) / macOS (DMG) / Linux (AppImage), automatic backend process management, data stored in user directory
- **Android Mobile**: Native app built with Capacitor, custom brand icon, Release signing support, connects to remote server
- **Client Mode**: Electron and Android clients support server address configuration via HTTP

### Developer Tools

#### MCP Server (`nowen-mcp`)

Provides 22 callable tools and resources for AI assistants (Claude, Cursor, Windsurf, etc.) to directly interact with the note system.

**Setup:**
```json
{
  "mcpServers": {
    "nowen-note": {
      "command": "npx",
      "args": ["tsx", "packages/nowen-mcp/src/index.ts"],
      "env": {
        "NOWEN_API_URL": "http://localhost:3001",
        "NOWEN_TOKEN": "your-jwt-token"
      }
    }
  }
}
```

**Tool List (22 tools):**

| Tool | Description |
|------|-------------|
| `nowen_list_notebooks` | List notebooks (tree structure) |
| `nowen_create_notebook` | Create notebook |
| `nowen_list_notes` | List notes |
| `nowen_get_note` | Get note details |
| `nowen_create_note` | Create note |
| `nowen_update_note` | Update note |
| `nowen_delete_note` | Delete note |
| `nowen_search_notes` | Full-text search |
| `nowen_list_tags` | List tags |
| `nowen_create_tag` | Create tag |
| `nowen_list_tasks` | List tasks |
| `nowen_create_task` | Create task |
| `nowen_toggle_task` | Toggle task completion |
| `nowen_ai_chat` | AI knowledge Q&A |
| `nowen_list_webhooks` | List Webhooks |
| `nowen_create_webhook` | Create Webhook |
| `nowen_audit_stats` | Audit statistics |
| `nowen_list_backups` | List backups |
| `nowen_create_backup` | Create data backup |
| `nowen_list_plugins` | List plugins |

#### TypeScript SDK (`@nowen/sdk`)

Provides 60+ type-safe API methods with complete coverage of all backend capabilities.

**Installation:**
```bash
npm install @nowen/sdk
```

**Usage Example:**
```typescript
import { NowenClient } from "@nowen/sdk";

const client = new NowenClient({
  baseUrl: "http://localhost:3001",
  token: "your-jwt-token",
});

// List notes
const notes = await client.listNotes({ notebookId: "xxx" });

// Create note
const note = await client.createNote({
  notebookId: "xxx",
  title: "New Note",
  content: "...",
});

// AI knowledge Q&A
const answer = await client.askAI("What are the new features?");

// Create Webhook
const webhook = await client.createWebhook({
  url: "https://your-server.com/hook",
  events: ["note.created", "note.updated"],
});

// Create backup
const backup = await client.createBackup("full");
```

**API Groups:**

| Group | Methods | Capabilities |
|-------|---------|-------------|
| Auth | 3 | Login / verify / change password |
| Notebooks | 4 | CRUD |
| Notes | 8 | CRUD + favorite/pin/lock/move |
| Tags | 4 | CRUD + note association |
| Tasks | 5 | CRUD + toggle status + stats |
| Search | 1 | Full-text search |
| AI | 5 | Chat / Q&A / settings / models / knowledge stats |
| Export | 2 | Export / import |
| Plugins | 3 | List / reload / execute |
| Shares | 4 | Create / list / delete / update |
| Mind Maps | 4 | CRUD |
| Webhooks | 6 | CRUD + test + delivery logs |
| Audit | 3 | Query / stats / cleanup |
| Backups | 5 | List / create / restore / delete / auto-backup |
| System | 3 | Health check / settings / user info |

#### CLI (`nowen-cli`)

Manage your note system from the terminal with 8 command groups.

**Setup:**
```bash
# Install dependencies
cd packages/nowen-cli && npm install

# Configure server
npx nowen config set-url http://localhost:3001
npx nowen config set-token <your-jwt-token>

# View config
npx nowen config show
```

**Commands:**

```bash
# Notes
nowen notes list [--notebook <id>]        # List notes
nowen notes get <id>                       # View note
nowen notes create --notebook <id> --title "Title"  # Create note
nowen notes update <id> --title "New Title" # Update note
nowen notes delete <id>                    # Delete note
nowen notes search <keyword>               # Search notes

# Notebooks
nowen notebooks list                       # List notebooks
nowen notebooks create --name "Name"       # Create notebook

# Tags
nowen tags list                            # List tags
nowen tags create --name "Tag Name"        # Create tag

# Tasks
nowen tasks list [--status <status>]       # List tasks
nowen tasks create --title "Task Name"     # Create task
nowen tasks toggle <id>                    # Toggle completion

# Search
nowen search <keyword>                     # Full-text search

# AI
nowen ai ask "Your question"               # Knowledge Q&A
nowen ai chat "Chat message"               # AI conversation

# Config
nowen config show                          # Show config
nowen config set-url <url>                 # Set server URL
nowen config set-token <token>             # Set JWT token
```

#### OpenAPI Specification

Complete OpenAPI 3.0 specification document, consumable by Swagger UI, Postman, and other tools.

```
GET http://localhost:3001/api/openapi.json
```

Covers 16 API groups, 50+ endpoints, with full request/response schema definitions.

### NPM Scripts

| Command                      | Description                                           |
| ---------------------------- | ----------------------------------------------------- |
| `npm run install:all`        | Install all frontend and backend dependencies         |
| `npm run dev:backend`        | Start backend in development mode (port 3001)         |
| `npm run dev:frontend`       | Start frontend in development mode (port 5173)        |
| `npm run build:all`          | Build both frontend and backend                       |
| `npm run build:frontend`     | Build frontend only                                   |
| `npm run build:backend`      | Build backend only                                    |
| `npm run electron:dev`       | Run Electron in development mode                      |
| `npm run electron:build`     | Build Electron for release                            |
| `npm run zip`                | Project packaging (via `archiver`)                    |
| `npm run zip:jszip`          | Project packaging (via `JSZip`)                       |

### Data Migration Script

A one-time migration script `scripts/migrate-tiptap-to-md.mjs` is provided to batch convert legacy Tiptap JSON notes into Markdown (for use with the Markdown editor).

**Prerequisites:**
- Backend dependencies installed (including `better-sqlite3`)
- **Strongly recommended to stop the backend service first** to avoid write conflicts
- `--apply` mode automatically creates a full DB backup at `<dbfile>.bak-<timestamp>` before writing

**Common commands:**

```bash
# 1. Preview (default dry-run, prints summary of affected notes, no writes)
node scripts/migrate-tiptap-to-md.mjs

# 2. Preview against a specific DB path
node scripts/migrate-tiptap-to-md.mjs --db backend/data/nowen-note.db

# 3. Process only specific note IDs
node scripts/migrate-tiptap-to-md.mjs --ids abc123,def456 --verbose

# 4. Process only the first 50 notes for sampling
node scripts/migrate-tiptap-to-md.mjs --limit 50 --verbose

# 5. Actually write (auto-creates .bak backup first)
node scripts/migrate-tiptap-to-md.mjs --apply
```

**Options:**

| Option | Description |
|--------|-------------|
| `--db <path>` | SQLite path. Defaults to `$DB_PATH` → `backend/data/nowen-note.db` |
| `--dry-run` | Preview only (default), no writes |
| `--apply` | Actually write changes, creates `.bak-<timestamp>` backup automatically |
| `--limit N` | Process at most N notes |
| `--ids a,b,c` | Process only specific note IDs (comma-separated) |
| `--verbose` | Print conversion details for each note |
| `--help` | Show help |

The script only modifies the `notes.content` field; `contentText` is untouched so the FTS5 full-text search index is unaffected. Notes detected as `empty` / `md` / `html` are automatically skipped.

### Docker Compose Architecture

```
┌───────────────────────────────────────────┐
│              Docker Compose                │
│                                           │
│  ┌─────────────────────────────────────┐  │
│  │           nowen-note :3001          │  │
│  │                                     │  │
│  │  ┌─────────────┐                    │  │
│  │  │  Frontend   │                    │  │
│  │  │  React      │                    │  │
│  │  │  Tiptap/MD  │                    │  │
│  │  ├─────────────┤                    │  │
│  │  │  Backend    │                    │  │
│  │  │  Hono       │◄──► External AI:   │  │
│  │  │  SQLite     │     Qwen/OpenAI    │  │
│  │  │  JWT        │     Gemini/DeepSeek│  │
│  │  │             │     Doubao         │  │
│  │  └─────────────┘     Ollama (opt.)  │  │
│  └─────────────────────────────────────┘  │
└───────────────────────────────────────────┘
```

| Service | Image | Port | Volumes | Description |
|---------|-------|------|---------|-------------|
| nowen-note | Self-built | 3001 | nowen-note-data | Main app (frontend + backend + SQLite) |

### Database Design

16 data tables + 1 FTS5 full-text search virtual table:

| Table | Description |
|-------|-------------|
| `users` | Users (username / password hash / avatar) |
| `notebooks` | Notebooks (parentId for unlimited nesting) |
| `notes` | Notes (JSON content + plain text + lock/pin/favorite/archive/trash) |
| `tags` | Tags (colored tags) |
| `note_tags` | Note-Tag many-to-many association |
| `attachments` | Attachments |
| `tasks` | Tasks (subtasks via parentId + priority + due date) |
| `diaries` | Moments (content + mood + timestamp) |
| `system_settings` | System settings key-value store (includes AI config) |
| `custom_fonts` | Custom fonts |
| `shares` | Share records (link / password / permission / expiry / view stats) |
| `note_versions` | Note version history |
| `share_comments` | Comments (inline anchors + replies + resolved marks) |
| `webhooks` | Webhook configuration (URL / events / secret / status) |
| `webhook_deliveries` | Webhook delivery logs (response status / retry count) |
| `audit_logs` | Audit logs (10 categories + 3 levels + operation details) |
| `notes_fts` | FTS5 full-text search virtual table (auto-synced via triggers) |

### API Routes

| Path | Auth | Description |
|------|------|-------------|
| `/api/auth` | ✗ | Login / change password / factory reset |
| `/api/health` | ✗ | Health check |
| `/api/openapi.json` | ✗ | OpenAPI 3.0 specification |
| `GET /api/settings` | ✗ | Site settings (branding) |
| `GET /api/fonts` | ✗ | Font list / font files |
| `/api/shared` | ✗ | Public share access (rate-limited) |
| `/api/notebooks` | ✓ | Notebook CRUD |
| `/api/notes` | ✓ | Note CRUD |
| `/api/tags` | ✓ | Tag management |
| `/api/search` | ✓ | FTS5 full-text search |
| `/api/tasks` | ✓ | Task management |
| `/api/mindmaps` | ✓ | Mind map CRUD |
| `/api/diary` | ✓ | Moments (post / timeline / delete / stats) |
| `/api/ai` | ✓ | AI chat + writing assistant + RAG |
| `/api/shares` | ✓ | Share management (create / list / update / delete) |
| `/api/plugins` | ✓ | Plugins (list / reload / execute) |
| `/api/webhooks` | ✓ | Webhooks (CRUD + test + delivery logs) |
| `/api/audit` | ✓ | Audit logs (query / stats / cleanup) |
| `/api/backups` | ✓ | Backup & restore (list / create / download / restore / auto) |
| `/api/export` | ✓ | Data import / export |
| `/api/settings` | ✓ | Site configuration (write operations) |
| `/api/fonts` | ✓ | Font upload / delete |
| `/api/micloud` | ✓ | Mi Cloud notes import |
| `/api/oppocloud` | ✓ | OPPO Cloud notes import |
| `/api/icloud` | ✓ | iCloud notes import |
| `/api/me` | ✓ | Current user info |
