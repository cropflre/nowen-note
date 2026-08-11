<div align="center">
  <img src="./electron/icon.png" alt="Nowen Note" width="104" />
  <h1>Nowen Note（弄文笔记）</h1>
  <p><strong>开源、自托管的知识库、每日记录与任务协作工作台</strong></p>
  <p>
    统一知识树 · 富文本 / Markdown 双编辑器 · 离线工作区 · AI RAG 问答 · 每日记录 · 任务中心 · 多端协作
  </p>
  <p>
    <a href="./README.en.md">English</a> ·
    <a href="http://nowen.cn/">官方网站</a> ·
    <a href="http://note.nowen.cn/">在线体验</a> ·
    <a href="https://github.com/cropflre/nowen-note/releases">下载客户端</a> ·
    <a href="./docs/tutorials/README.md">教程中心</a> ·
    <a href="./docs/tutorials/mcp.md">MCP 安装</a> ·
    <a href="./CHANGELOG.md">更新日志</a>
  </p>
</div>

<div align="center">

[![GitHub Release](https://img.shields.io/github/v/release/cropflre/nowen-note?display_name=tag&sort=semver)](https://github.com/cropflre/nowen-note/releases)
[![Docker Pulls](https://img.shields.io/docker/pulls/cropflre/nowen-note?logo=docker&logoColor=white)](https://hub.docker.com/r/cropflre/nowen-note)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](./LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Compose%20v2-2496ED?logo=docker&logoColor=white)](./docker-compose.yml)

</div>

> Nowen Note 不只是一个编辑器。它希望成为一套由你掌控数据、可长期运行在 NAS / 服务器上，并能通过 Web、桌面端和移动端随时访问的个人与团队知识基础设施。

> **NAS 远程连接登录**：支持部署到 **绿联 NAS（UGOS / UGOS Pro）** 和 **飞牛 NAS（fnOS）**。部署完成后，可在 Web、桌面端或 Android 客户端中，通过局域网 IP、IPv6 地址或已配置 HTTPS 的公网域名远程连接并登录。

## v1.4.6 已发布

v1.4.6 聚焦 **性能、同步稳定性、移动端体验、权限安全与国际化**，针对近期真实使用反馈进行了一轮集中优化。

- 大幅拆分首屏依赖，编辑器、侧边栏、任务、日记、文件管理、AI 等模块按需加载，并加入 Gzip / Brotli 预压缩与缓存优化。
- 修复单端也可能触发的误冲突、重复副本和异常保存状态，并加强富文本 / Markdown 格式转换时的 Yjs 状态保护。
- Android 新增统一图片手势查看器，支持应用内预览、双指缩放和拖动；任务提醒接入系统原生通知调度。
- 知识库 ACL 增加 Restricted 受限模式与显式拒绝规则，并将权限过滤扩展到搜索、文件、附件、导出、标签和离线同步等链路。
- 三栏布局、编辑器大纲、代码块复制、Markdown 图片导出、附件孤儿清理和绿联远程访问等细节继续修复完善。
- 集中补齐设置、工作区、导入、下载、大文档、日记 Markdown 等界面的多语言支持，并增加对应回归测试。

查看：[v1.4.6 Release](https://github.com/cropflre/nowen-note/releases) · [完整更新日志](./CHANGELOG.md)

## 为什么选择 Nowen Note

| | |
| --- | --- |
| **数据真正属于你** | 支持 Docker / NAS 自托管，可部署到绿联 UGOS、飞牛 fnOS 等 NAS 平台；数据库、附件、索引和备份均由你管理，附件可接入 S3、Cloudflare R2 与 MinIO，备份可同步到邮件或 WebDAV。 |
| **一棵树管理全部内容** | 文件夹、富文本和 Markdown 文档统一组织，根目录也能直接创建文档，支持拖拽、排序、导入、权限继承、密码保护和共享展示。 |
| **在线与离线都能工作** | 可缓存完整工作区、正文和附件，断网继续阅读与编辑，联网后自动恢复增量同步。 |
| **写作、知识与行动统一** | 笔记、每日记录、任务、AI、思维导图和协作权限在同一套产品中完成，无需在多套工具间反复切换。 |

## 核心能力

| 模块 | 当前能力 |
| --- | --- |
| **统一知识树** | 文件夹、富文本与 Markdown 文档混合组织；支持根目录文档、无限层级、拖拽排序、统一创建菜单、全部展开 / 收起、筛选搜索、数量统计、回收站和共享目录；三栏布局可展示子文件夹与层级范围。 |
| **富文本与 Markdown** | Tiptap 3、CodeMirror 6、格式互转、实时预览与分屏、大纲、斜杠命令、表格、代码块、KaTeX、Mermaid、脚注、Callout、媒体嵌入、评论和版本历史。 |
| **可靠保存与离线工作区** | Yjs 持久化确认、未确认修改补传、IndexedDB 草稿恢复、富文本串行版本保存；支持个人空间、共享目录和工作区离线副本，并针对误冲突、重复副本和格式转换状态做保护。 |
| **性能与加载** | 工作区、编辑器、任务、日记、文件管理、AI 等功能按需加载；静态资源支持缓存验证、Gzip / Brotli 预压缩，减少首屏依赖和重复传输。 |
| **知识组织与检索** | 彩色标签、收藏、置顶、全文搜索、文内查找替换、双向链接、块引用、反向链接、知识图谱，以及“全部笔记”固定入口。 |
| **AI 能力** | OpenAI 兼容接口、通义千问、Gemini、DeepSeek、豆包与 Ollama；支持续写、改写、翻译、标题与标签生成、总结、Embedding 索引和 RAG 知识问答。 |
| **每日记录** | 统一“瞬间 / 日历 / 日记”入口，支持短内容、心情、图片、视频、AI 周报 / 月报、自然日期命令、日记实体归档、历史目录整理和工作区共享日记。 |
| **任务与习惯** | 树形任务、列表、看板、日历、甘特图 / 时间轴、依赖关系、重复规则、提醒和模板；支持 My Day、标签、保存视图、预估时长、时间块、Inbox、快速捕获、离线任务 / 习惯，以及 Android 原生任务提醒调度。 |
| **协作、权限与分享** | Yjs + WebSocket 实时协作、工作区角色、目录级 ACL、Restricted 受限模式、显式允许 / 拒绝规则、权限继承、所有权转移、分享密码与有效期、访客评论、公开知识空间，以及富文本 / Markdown 划词批注。 |
| **导入、导出与迁移** | 支持 Markdown、Word / DOCX、网页 URL、微信公众号、SingleFile HTML、思源、Obsidian、小米笔记等；支持选择导入为 Markdown 或富文本，并提供后台任务、进度、重试、远程图片本地化和 Markdown 图片 / 脚注导出。 |
| **附件与存储** | 本地附件按 `YYYY/MM` 归档；支持缩略图、引用检查、孤儿扫描 / 清理、已有附件复用、手动上传文件保护，以及本地磁盘、S3、R2、MinIO。 |
| **备份与恢复** | 本地自动备份、完整 ZIP、邮件备份、凭据加密的 WebDAV 远程备份、Docker 在线升级前备份与失败回滚检查。 |
| **多端访问** | Web、Electron（Windows / macOS / Linux）、Android、iOS 工程、HarmonyOS 工程，以及 Docker / NAS 部署；支持绿联 UGOS、飞牛 fnOS，客户端可通过 IPv4、IPv6 或域名远程连接并登录 NAS 服务；Android 支持应用内图片手势预览。 |
| **开放能力** | OpenAPI 3.0、TypeScript SDK、CLI、Webhook、插件系统、Personal API Token、MCP Server 和浏览器剪藏扩展。 |

## AI 问答与隐私

Nowen Note 的知识库问答采用 RAG 检索增强方式，**不会在每次提问时把全部笔记内容都发送给大模型**。

- **知识库模式**：先在本地索引中检索相关笔记和附件，再发送匹配到的片段。
- **当前笔记模式**：只使用当前打开的笔记。
- **选中文本模式**：只使用当前选择或粘贴的文本。
- **本地模型**：使用 Ollama 等本地服务时，可让问答内容留在自己的设备或服务器中。

使用在线 Embedding 或在线大模型时，建立索引或回答问题所需的相关文本会发送给你自行配置的服务商。身份证、密码、API Key、助记词等高度敏感信息仍不建议以明文保存。

## 让 AI 客户端连接 Nowen Note

Nowen Note 支持 MCP Server，可让 Claude Code、Cursor、VS Code 等 AI 客户端在授权范围内搜索、读取、创建和更新笔记。

- [MCP Server 中文安装教程](./docs/tutorials/mcp.md)
- [MCP Server English guide](./docs/tutorials/mcp.en.md)
- [nowen-mcp 独立包说明](./packages/nowen-mcp/README.md)

当前正式可用方式为源码构建：安装 Node.js 20+，构建 `packages/nowen-mcp`，在 Nowen Note 创建 restricted Personal API Token，再把 `dist/scoped-entry.js` 的绝对路径配置到客户端。

## v1.4.6 重点更新

### 性能与启动体验

- 工作区核心区域、编辑器、任务中心、日记、文件管理、AI 与分享等功能改为按需加载，降低首屏入口包压力。
- 统一启动 Splash / Loading 层级，减少登录态切换和 StrictMode 下的闪烁、重复 Loading。
- Docker Web 静态资源支持预压缩、缓存验证和 Brotli / Gzip 协商，降低重复传输成本。
- 优化附件缓存、签名 URL 与 ETag 复用，减少图片和附件重复请求。

### 同步、编辑器与导出稳定性

- 修复只有一个客户端打开时仍可能出现冲突、自动产生重复文档以及“保存失败 / 冲突副本”同时提示的问题。
- 加强 Markdown / 富文本互转时的 Yjs 因果状态保护，避免格式往返造成内容重复。
- 修复 Tab 缩进刷新或分享后丢失、旧版大纲位置漂移、PC 客户端代码块复制失效等问题。
- 修复 Markdown 图片导出失败，并补齐图片访问签名与脚注导出处理。
- 文件管理中的图片可直接插入正文，视频可直接插入播放器。

### Android 与移动端

- 新增统一图片手势查看器，Markdown 和编辑器图片可直接在应用内预览。
- 支持双指缩放、拖动查看，并抑制缩放结束后的残余点击误触。
- 任务提醒接入 Capacitor 原生通知调度，并增加调度凭证、ACK 重试、登出 / 切换服务清理和精确提醒检查。
- 修复绿联远程访问 Gateway 重定向，以及 Android 根目录创建文档的兼容问题。
- 优化每日记录在移动端的布局密度。

### 权限与数据安全

- 知识库权限新增 Restricted 受限模式、显式 Allow / Deny 规则及最近显式拒绝优先级处理。
- 权限过滤覆盖全文搜索、旧知识集合接口、文件管理、导出、标签、离线同步与附件下载。
- 权限撤销后同步隐藏实时元数据，并避免通过搜索数量或资源响应推测无权限内容是否存在。
- 手动上传附件加入保护状态，避免被孤儿文件清理误删。
- PostgreSQL 权限 Schema 与迁移继续补齐，但正式生产部署仍以 SQLite 为默认基线。

### 界面、国际化与发布可靠性

- 三栏布局支持展示子文件夹与层级范围，并分离目录选择和展开行为。
- 补齐工作区、安全设置、大文档、日记 Markdown、小米云、有道导入、下载与局域网等界面的多语言资源。
- Windows / macOS 更新统一采用浏览器下载策略；Linux 增加原生模块 GLIBC / GLIBCXX 兼容基线检查。
- Android Capacitor 8 正式发版使用 Node.js 22 构建基线，进一步提高跨平台发版的一致性。

完整记录请查看 [CHANGELOG.md](./CHANGELOG.md)。

## 截图

### 桌面端

| AI 写作助手 | AI 服务商配置 |
| :---: | :---: |
| ![桌面 AI 写作](./docs/screenshots/desktop-ai-writing.png) | ![AI 设置](./docs/screenshots/settings-ai.png) |

### 移动端

| 侧边栏 | 笔记列表 | 编辑器 |
| :---: | :---: | :---: |
| ![移动端侧边栏](./docs/screenshots/mobile-sidebar.png) | ![移动端列表](./docs/screenshots/mobile-list.png) | ![移动端编辑器](./docs/screenshots/mobile-editor.png) |

## 官网与在线体验

- 官方网站：<http://nowen.cn/>
- 在线体验：<http://note.nowen.cn/>
- 账号：`demo`
- 密码：`demo123456`

> 演示账号仅用于体验，数据可能被定期重置。请勿存放敏感或重要内容。

## 快速部署

### Docker Compose（推荐）

要求已安装 Docker Engine 与 Docker Compose v2。

```bash
git clone https://github.com/cropflre/nowen-note.git
cd nowen-note
docker compose up -d
```

打开 `http://<服务器IP>:3001`。

默认管理员账号：

```text
用户名：admin
密码：admin123
```

> 首次登录后请立即修改默认密码。公网部署还应配置 HTTPS、备份、正确的公开访问地址，并按需收紧 CORS。

### 绿联 NAS / 飞牛 NAS 远程连接登录

Nowen Note 支持部署在 **绿联 NAS（UGOS / UGOS Pro）** 与 **飞牛 NAS（fnOS）** 上。可使用 Releases 中对应的 `.upk` / `.fpk` 安装包，也可以直接通过 Docker Compose 部署。

部署并启动服务后：

- 局域网访问：浏览器打开 `http://<NAS局域网IP>:3001`。
- 远程访问：在 Web、桌面端或 Android 客户端中填写 NAS 的公网域名、IPv4 或 IPv6 服务地址并登录。
- 公网使用建议配置 HTTPS 反向代理，不建议直接暴露未加密的 HTTP 服务。

查看各平台安装包：[GitHub Releases](https://github.com/cropflre/nowen-note/releases)。

查看运行状态和日志：

```bash
docker compose ps
docker compose logs -f --tail=200 nowen-note
```

### 从旧版本升级

升级前先在管理后台创建完整备份，并确认数据库与附件目录已经持久化。

```bash
docker compose pull
docker compose up -d
```

需要固定当前稳定版本时：

```bash
NOWEN_IMAGE_TAG=v1.4.6 docker compose up -d
```

> v1.4.6 重点修复同步误冲突与重复副本，并优化权限、前端加载、Android 图片预览和任务提醒。升级后建议检查登录、笔记编辑、附件、任务、每日记录、权限和备份功能。镜像回滚不等于数据库回滚，生产环境必须保留独立备份。

### Docker 在线升级（可选）

在线升级仅支持仓库内的官方 [`docker-compose.yml`](./docker-compose.yml)，且默认关闭。主应用容器不会挂载 Docker Socket；只有独立、内网隔离并受限运行的 updater 容器拥有 Docker Engine 权限。

```bash
cp .env.example .env
printf '\nNOWEN_UPDATER_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env
NOWEN_IMAGE_TAG=v1.4.6 docker compose --profile updater up -d
```

启用后，管理员可在「设置 → 关于 → 版本信息」执行升级前检查、完整备份、升级、健康验证和失败回滚。

完整说明见 [Docker 在线升级与恢复](./docs/docker-online-update.md)。

### 仅运行主应用

```bash
docker run -d \
  --name nowen-note \
  --restart unless-stopped \
  -p 3001:3001 \
  -e TZ=Asia/Shanghai \
  -v /opt/nowen-note/data:/app/data \
  cropflre/nowen-note:v1.4.6
```

## 数据、备份与配置

### 持久化目录

容器内的持久化根目录是 **`/app/data`**，不是 `/data`。默认 Compose 使用名为 `nowen-note-data` 的 Docker Volume。

```text
/app/data/
├── nowen-note.db
├── attachments/
├── backups/
├── fonts/
└── .jwt_secret
```

- 默认生产数据库为 SQLite，主文件是 `/app/data/nowen-note.db`。
- 附件默认存储在 `/app/data/attachments`，新文件按 `YYYY/MM` 分目录。
- 自动备份默认位于 `/app/data/backups`。
- 生产环境建议把 `BACKUP_DIR` 映射到独立物理磁盘，并遵循 3-2-1 备份原则。
- PostgreSQL 适配和迁移仍在验证中，当前正式部署与恢复流程继续以 SQLite 为默认基线。

### 常用环境变量

完整模板见 [`.env.example`](./.env.example)。

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `NOWEN_PORT` | `3001` | Compose 对外暴露端口 |
| `TZ` | `Asia/Shanghai` | 容器时区，会影响任务日期与日记自然日期判断 |
| `PUBLIC_WEB_ORIGIN` | 空 | 反向代理或公网域名，用于生成正确的分享链接 |
| `JWT_SECRET` | 自动生成并持久化 | 登录、会话与部分加密回退；多实例部署时必须统一配置 |
| `BACKUP_DIR` | `/app/data/backups` | 自动备份目录 |
| `BACKUP_WEBDAV_ENCRYPTION_KEY` | 回退到 `JWT_SECRET` | 加密保存 WebDAV 凭据，生产环境建议单独配置 |
| `CORS_ORIGINS` | 内置原生客户端来源 | 额外允许的网页 Origin，逗号分隔 |
| `MAX_ATTACHMENT_SIZE_MB` | `100` | 单个附件大小上限 |
| `ATTACHMENT_STORAGE` | `local` | 设为 `s3` 后可接入 S3 / R2 / MinIO |
| `NOWEN_UPDATER_TOKEN` | 空 | 启用 Docker 在线升级代理 |

- [附件对象存储](./docs/object-storage.md)
- [WebDAV 远程备份](./docs/webdav-backup.md)
- [邮件备份配置](./docs/backup-email-smtp.md)

## 客户端与平台状态

| 平台 | 获取 / 构建方式 | 状态说明 |
| --- | --- | --- |
| **Web / Docker** | Docker Hub 或源码构建 | 推荐部署方式；镜像可构建 `amd64`、`arm64` 或多架构版本 |
| **Windows / macOS / Linux** | [GitHub Releases](https://github.com/cropflre/nowen-note/releases) 或 `npm run electron:build` | Electron 客户端可连接远程服务，也可使用本地后端 |
| **Android** | Releases APK 或在 `frontend/` 下使用 Capacitor 构建 | 正式维护；支持系统分享导入、Markdown 导入、沉浸式编辑、移动端知识树、图片手势预览、系统原生任务提醒，以及远程连接 NAS 服务登录 |
| **iOS** | Capacitor 工程与 GitHub Actions / TestFlight 流程 | 需要 Apple 签名与开发者账号，详见 [iOS 发布指南](./docs/iOS-Release.md) |
| **HarmonyOS** | 使用 DevEco Studio 打开 [`nowen-harmony/`](./nowen-harmony/) | ArkTS + ArkWeb MVP；部分原生能力仍在完善 |
| **fnOS** | Releases 中的 `.fpk` | 支持飞牛 NAS 安装；当前 `.fpk` 主要面向 x86_64，部署后可通过局域网或公网地址远程连接登录 |
| **绿联 UGOS** | Releases / 构建脚本中的 `.upk` | 支持绿联 NAS 安装，依赖具体设备架构与应用安装能力；部署后可通过局域网或公网地址远程连接登录 |
| **其他 NAS** | Docker Compose | 群晖、威联通、极空间等可按 Docker 方式部署 |

> 各平台实际发布的安装包以 [GitHub Releases](https://github.com/cropflre/nowen-note/releases) 为准。

## Code signing policy

Free code signing provided by SignPath.io, certificate by SignPath Foundation

- **Authors:** [cropflre](https://github.com/cropflre)
- **Reviewers:** [cropflre](https://github.com/cropflre)
- **Approvers:** [cropflre](https://github.com/cropflre)
- 只有本仓库 GitHub Actions 从已提交源码生成的正式 Windows artifact 才允许提交到 SignPath 请求签名；本地构建的未签名 Windows Full/Lite 包不能直接发布到 GitHub Release。
- 签名完成后，发布流程会再次验证 Authenticode 状态、证书发布者、更新元数据、SHA-512 和 blockmap，并在远端资产复核通过后才公开 Release。
- 隐私与第三方服务的数据处理边界请查看 [隐私政策](./docs/PRIVACY.md)。代码签名只处理构建产物，不会把用户笔记或账号数据发送给 SignPath。
- 从历史未签名/旧发布者版本迁移到首个 SignPath 签名版本时，Windows 用户需要从 GitHub Release 手动下载安装该桥接版本；从该版本开始，后续使用同一证书发布者的版本可恢复应用内自动更新。

## 本地开发

要求 Node.js 20+、npm、Git。Electron 和原生依赖构建还需要对应平台的编译工具链。

```bash
git clone https://github.com/cropflre/nowen-note.git
cd nowen-note
npm install
npm run install:all
npm run dev
```

也可以分别启动：

```bash
npm run dev:backend
npm run dev:frontend
```

访问 `http://localhost:5173`。

常用命令：

```bash
npm run build:all                 # 构建前端与后端
npm run electron:dev              # Electron 开发
npm run electron:build            # Electron 打包
(cd backend && npm test)          # 后端测试
(cd frontend && npm run test:run) # 前端测试
```

Android：

```bash
cd frontend
npm run cap:build
npx cap open android
```

> Capacitor 8 的 Android 发布工具链要求 Node.js 22+；日常 Web / Electron 开发仍可使用项目当前 Node.js 20+ 基线。

iOS：

```bash
npm run cap:sync:ios
npm run cap:open:ios
```

## 技术架构

| 层 | 主要技术 |
| --- | --- |
| **前端** | React 18、TypeScript、Vite 5、Tailwind CSS、Tiptap 3、CodeMirror 6、Yjs、IndexedDB |
| **后端** | Node.js 20、Hono 4、WebSocket、better-sqlite3、FTS5、sqlite-vec、sharp |
| **桌面端** | Electron 33、electron-builder、electron-updater |
| **移动端** | Capacitor 8（Android / iOS）、ArkTS + ArkWeb（HarmonyOS） |
| **存储与备份** | SQLite、本地附件、S3 / Cloudflare R2 / MinIO、邮件与 WebDAV；PostgreSQL 处于适配验证阶段 |
| **开放能力** | OpenAPI 3.0、TypeScript SDK、CLI、MCP Server、Webhook |

## 项目结构

```text
nowen-note/
├── frontend/       # React Web 与 Capacitor 客户端
├── backend/        # Hono API、数据库、同步与后台任务
├── electron/       # Electron 主进程与打包配置
├── packages/       # SDK、CLI、MCP 等开发者包
├── nowen-harmony/  # HarmonyOS ArkTS / ArkWeb 客户端
├── docs/           # 部署、教程与设计文档
└── scripts/        # 构建、迁移、打包与发布脚本
```

## 文档导航

- [教程与帮助中心](./docs/tutorials/README.md)
- [MCP Server 安装与使用](./docs/tutorials/mcp.md)
- [完整部署指南](./docs/deployment.md)
- [Docker 在线升级与恢复](./docs/docker-online-update.md)
- [WebDAV 远程备份](./docs/webdav-backup.md)
- [附件对象存储](./docs/object-storage.md)
- [邮件备份配置](./docs/backup-email-smtp.md)
- [ARM64 部署](./docs/deploy-arm64.md)
- [iOS 发布指南](./docs/iOS-Release.md)
- [隐私策略](./docs/PRIVACY.md)
- [浏览器剪藏扩展](https://chromewebstore.google.com/detail/nowen-note-web-clipper/nglkodhfdbnfielchjpkjhenfaecafpg)
- OpenAPI：服务启动后访问 `/api/openapi.json`

## 当前边界

- **数据库**：SQLite 是当前默认且完整支持的生产方案；PostgreSQL 已有适配器、Schema 和部分双库测试，但尚未开放正式切换。
- **格式互转**：Markdown 与富文本互转会尽量保留主要结构，但高度定制的 HTML、复杂扩展节点或第三方语法仍可能需要人工检查。
- **AI 隐私**：使用在线 Embedding 或在线大模型时，相关文本会发送到用户自行配置的服务商；敏感信息建议使用本地模型或不要存储。
- **WebDAV**：用于上传已经完成的备份文件，不是实时同步、数据库运行目录或附件在线存储后端。
- **Docker 在线升级**：只支持官方 Compose 受管部署，不支持任意容器、任意镜像或 NAS 应用包。
- **macOS**：安装包若未经过 Apple 公证，首次打开可能需要执行 `xattr` 解除隔离，详见 [桌面端教程](./docs/tutorials/desktop.md)。
- **移动端**：Android 维护最完整；iOS 与 HarmonyOS 的分发、签名和部分原生桥接能力仍受平台工具链限制。
- **快速迭代**：功能和安装包更新较快，请以 Releases、应用内版本信息和 [CHANGELOG.md](./CHANGELOG.md) 为准。

## 版本与更新

README 维护稳定的产品定位、能力范围、近期版本和部署方式；完整提交历史请查看更新日志。

- [查看最新 Release](https://github.com/cropflre/nowen-note/releases)
- [查看完整更新日志](./CHANGELOG.md)
- [查看 Issues 与开发进度](https://github.com/cropflre/nowen-note/issues)

## 参与贡献

欢迎提交 Issue、功能建议和 Pull Request。提交代码前建议至少完成：

```bash
npm run build:all
(cd backend && npm test)
(cd frontend && npm run test:run)
```

反馈入口：

- [GitHub Issues](https://github.com/cropflre/nowen-note/issues)
- QQ 群：`1093473044`

## 支持作者

如果 Nowen Note 对你有帮助，欢迎扫码请作者喝杯咖啡。感谢每一份支持，它会帮助项目持续维护和迭代。

<table align="center">
  <tr>
    <th>微信赞赏</th>
    <th>支付宝赞赏</th>
  </tr>
  <tr>
    <td align="center"><img src="./frontend/src/assets/sponsor/weixin.jpg" alt="微信赞赏码" width="260" /></td>
    <td align="center"><img src="./frontend/src/assets/sponsor/zhifubao.png" alt="支付宝赞赏码" width="260" /></td>
  </tr>
</table>

也可以阅读 [作者感言](./AUTHOR_STORY.md)。

## License

Nowen Note 基于 [GNU General Public License v3.0](./LICENSE) 开源。

<!-- CHANGELOG:BEGIN -->
<!-- 详细版本记录请查看 CHANGELOG.md；README 仅维护稳定能力与近期重点增强。 -->
<!-- CHANGELOG:END -->
