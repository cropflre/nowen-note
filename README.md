<div align="center">
  <img src="./electron/icon.png" alt="Nowen Note" width="104" />
  <h1>Nowen Note（弄文笔记）</h1>
  <p><strong>开源、自托管的知识库、每日记录与任务协作工作台</strong></p>
  <p>
    统一知识树 · 富文本 / Markdown 双编辑器 · 离线工作区 · AI RAG 问答 · 每日记录 · 任务中心 · 多端协作
  </p>
  <p>
    <a href="./README.en.md">English</a> ·
    <a href="https://cropflre.github.io/">官方网站 / 帮助中心</a> ·
    <a href="http://nowen.cn/">nowen.cn（维护中）</a> ·
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

## v1.4.16 已发布

v1.4.16 聚焦 **笔记切换稳定性、视频附件授权、Markdown / 代码块编辑体验与桌面发布链路**，继续提升 Nowen Note 在多端编辑、局域网媒体访问和桌面客户端分发场景下的可靠性。

- **笔记切换更稳定**：阻止旧富文本保存回执在快速切换后重新抢回激活笔记，并补充“提交后迟到回执”回归覆盖。
- **视频首次打开更可靠**：首次进入包含视频的笔记前会提前准备附件签名，减少播放器先启动、授权尚未就绪导致的首次加载失败。
- **Android / 局域网视频授权修复**：局域网附件授权改用原生 HTTP 链路，改善 Android 客户端访问 NAS / 局域网服务时的视频加载稳定性。
- **编辑器细节修复**：优化代码块全选快捷键逻辑，并重新清理历史 Markdown 块标记，减少旧内容残留标记对编辑体验的影响。
- **桌面发布链路增强**：完善 Windows SignPath 测试 / 正式签名、Authenticode 严格校验、签名后更新元数据，以及 macOS 双架构产物完整性检查。
- **分享兼容性**：修复 Edge 浏览器分享链接复制兼容性，并补充剪贴板回归测试。

查看：[v1.4.16 Release](https://github.com/cropflre/nowen-note/releases/tag/v1.4.16) · [完整更新日志](./CHANGELOG.md)

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
| **统一知识树** | 文件夹、富文本与 Markdown 文档混合组织；支持根目录文档、无限层级、拖拽排序与层级调整、统一创建菜单、全部展开 / 收起、筛选搜索、数量统计、回收站和共享目录；三栏布局可展示子文件夹与层级范围。 |
| **富文本与 Markdown** | Tiptap 3、CodeMirror 6、格式互转、实时预览与分屏、大纲、斜杠命令、表格、代码块、KaTeX、Mermaid、脚注、Callout、媒体嵌入、跨笔记格式粘贴、标题重复前缀提示、评论和版本历史。 |
| **可靠保存与离线工作区** | Yjs 持久化确认、未确认修改补传、IndexedDB 草稿恢复、富文本串行版本保存；支持个人空间、共享目录和工作区离线副本，并针对误冲突、重复副本和格式转换状态做保护；离线附件支持损坏 Blob 校验、隔离与恢复。 |
| **性能与加载** | 工作区、编辑器、任务、日记、文件管理、AI 等功能按需加载；静态资源支持缓存验证、Gzip / Brotli 预压缩，减少首屏依赖和重复传输。 |
| **知识组织与检索** | 彩色标签、收藏、置顶、全文搜索、当前目录笔记搜索、文内查找替换、双向链接、块引用、反向链接、知识图谱，以及“全部笔记”固定入口。 |
| **AI 能力** | OpenAI 兼容接口、通义千问、Gemini、DeepSeek、豆包与 Ollama；支持续写、改写、翻译、标题与标签生成、总结、Embedding 索引和 RAG 知识问答。 |
| **每日记录** | 统一“瞬间 / 日历 / 日记”入口，支持短内容、心情、图片、视频、AI 周报 / 月报、自然日期命令、日记实体归档、历史目录整理和工作区共享日记。 |
| **任务与习惯** | 树形任务、列表、看板、日历、甘特图 / 时间轴、依赖关系、重复规则、提醒和模板；支持 My Day、标签、保存视图、预估时长、时间块、Inbox、快速捕获、离线任务 / 习惯，以及 Android 原生任务提醒调度，并补齐创建端时区、全天截止与服务端解析一致性。 |
| **协作、权限与分享** | Yjs + WebSocket 实时协作、工作区角色、目录级 ACL、Restricted 受限模式、显式允许 / 拒绝规则、权限继承、所有权转移、分享密码与有效期、访客评论、公开知识空间，以及富文本 / Markdown 划词批注。 |
| **导入、导出与迁移** | 支持 Markdown、Word / DOCX、网页 URL、微信公众号、SingleFile HTML、思源、Obsidian、小米笔记等；支持选择导入为 Markdown 或富文本，并提供后台任务、进度、重试、远程图片本地化和 Markdown 图片 / 脚注导出；团队空间单篇 ZIP 会按笔记真实工作区执行权限校验。 |
| **附件与存储** | 本地附件按 `YYYY/MM` 归档；支持缩略图、引用检查、孤儿扫描 / 清理、已有附件复用、手动上传文件保护，以及本地磁盘、S3、R2、MinIO，并强化移动端图片 / 视频文件身份与 multipart 上传稳定性。 |
| **备份与恢复** | 本地自动备份、后台完整 ZIP 任务、流式归档与校验、浏览器原生下载、邮件备份、凭据加密的 WebDAV 远程备份、Docker 在线升级前备份与失败回滚检查。 |
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

当前正式可用方式为源码构建：安装 Node.js 20+，构建 `packages/nowen-mcp`，在 Nowen Note 创建 restricted Personal API Token，再把 `packages/nowen-mcp/bin/nowen-mcp.mjs` 的绝对路径配置到客户端。`dist/scoped-entry.js` 是启动器加载的内部构建入口，不应直接配置给客户端。

## v1.4.16 重点更新

### 笔记切换与编辑稳定性

- 快速切换笔记后，旧富文本保存回执不会再把上一条笔记重新设为当前激活笔记。
- 新增“提交后迟到保存回执”回归测试，继续收紧笔记切换竞态边界。
- 优化代码块全选快捷键逻辑，减少代码块与整篇文档选择行为冲突。
- 重新清理历史 Markdown 块标记，降低旧数据残留标记对当前编辑与渲染的影响。

### 视频、Android 与局域网访问

- 首次打开包含视频附件的笔记前会先准备附件签名，避免播放器早于授权信息初始化。
- Android / 局域网附件授权改用原生 HTTP 链路，提升 NAS、局域网 IP 等场景的视频访问稳定性。
- 为“首次打开前附件授权准备”和“Android 局域网附件授权”补充回归测试。

### 桌面客户端发布与分发

- Windows 正式发布链路接入并强化 SignPath 签名，包括测试签名、正式签名配置校验和 Authenticode 严格验证。
- 补充签名后 Windows 更新元数据重建 / 刷新流程，确保发布产物与自动更新元数据一致。
- 强化 macOS 发版产物完整性门禁，并兼容双架构压缩包的发布与校验。
- Release 说明进一步明确桌面平台矩阵，降低不同系统下载与安装时的歧义。

### 分享兼容性

- 修复 Edge 浏览器分享链接复制兼容性，并增加剪贴板兼容性回归测试。

完整记录请查看 [CHANGELOG.md](./CHANGELOG.md) 和 [v1.4.16 Release](https://github.com/cropflre/nowen-note/releases/tag/v1.4.16)。

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

- 当前官方网站 / 帮助中心：<https://cropflre.github.io/>
- 后续官网：<http://nowen.cn/>（维护中）
- 在线体验：<http://note.nowen.cn/>
- 账号：`demo`
- 密码：`demo123456`

> `nowen.cn` 仍在维护中。当前请以 <https://cropflre.github.io/> 作为 Nowen 官方帮助与使用文档入口。

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
NOWEN_IMAGE_TAG=v1.4.16 docker compose up -d
```

> v1.4.16 重点改善笔记切换稳定性、视频首次打开与 Android / 局域网附件授权、Markdown / 代码块编辑细节，以及桌面客户端签名与发布完整性。升级后建议重点检查快速切换笔记、首次视频播放、Android 连接 NAS / 局域网视频、代码块全选和分享链接复制。镜像回滚不等于数据库回滚，生产环境必须保留独立备份。

### Docker 在线升级（可选）

在线升级仅支持仓库内的官方 [`docker-compose.yml`](./docker-compose.yml)，且默认关闭。主应用容器不会挂载 Docker Socket；只有独立、内网隔离并受限运行的 updater 容器拥有 Docker Engine 权限。

```bash
cp .env.example .env
printf '\nNOWEN_UPDATER_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env
NOWEN_IMAGE_TAG=v1.4.16 docker compose --profile updater up -d
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
  cropflre/nowen-note:v1.4.16
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

- [Nowen 官方帮助中心](https://cropflre.github.io/#/note)
- [仓库内教程索引](./docs/tutorials/README.md)
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