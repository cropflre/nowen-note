<div align="center">
  <img src="./electron/icon.png" alt="Nowen Note" width="104" />
  <h1>Nowen Note（弄文笔记）</h1>
  <p><strong>面向个人与小团队的开源、自托管知识库与任务工作台</strong></p>
  <p>
    富文本与 Markdown 双编辑器 · 实时协作 · AI 知识问答 · 待办与思维导图 · 多端客户端
  </p>
  <p>
    <a href="./README.en.md">English</a> ·
    <a href="https://nowen.cn/">官方网站</a> ·
    <a href="https://note.nowen.cn/">在线体验</a> ·
    <a href="https://github.com/cropflre/nowen-note/releases">下载客户端</a> ·
    <a href="./docs/tutorials/README.md">教程中心</a> ·
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

> Nowen Note 的目标不是只做一个编辑器，而是提供一套数据可控、可在 NAS / 服务器长期运行，并能通过桌面和移动客户端访问的个人知识基础设施。

## 核心能力

| 模块 | 当前能力 |
| --- | --- |
| **笔记与编辑器** | Tiptap 3 富文本、CodeMirror 6 Markdown、实时预览与分屏、表格、代码块、KaTeX、Mermaid、图片与附件、评论、版本历史 |
| **知识组织** | 无限层级笔记本、彩色标签、收藏、回收站、全文搜索、双向链接、块引用、反向链接与知识图谱 |
| **任务管理** | 树形任务、列表、看板、日历、甘特图 / 时间轴、任务依赖、重复规则、提醒、模板与 AI 拆解 |
| **AI 能力** | OpenAI 兼容接口、通义千问、Gemini、DeepSeek、豆包、Ollama；支持写作辅助、标题与标签、总结、Embedding 与 RAG 知识问答 |
| **协作与发布** | Yjs + WebSocket 实时同步、工作区、成员权限、分享密码与有效期、访客评论、公开知识空间与目录权限 |
| **导入与导出** | Markdown、Word / DOCX、Obsidian Vault、微信收藏等迁移入口；支持 Markdown、PDF、Word、PNG、JPG 等导出 |
| **附件与存储** | 本地附件目录、按 `YYYY/MM` 归档、图片缩略图、引用检查与孤儿清理；可接入 S3、Cloudflare R2、MinIO 和第三方图床 |
| **自动化与开发者能力** | 自动备份、邮件备份、Webhook、审计日志、插件系统、OpenAPI、TypeScript SDK、CLI、MCP Server、浏览器剪藏扩展 |
| **多端访问** | Web、Electron（Windows / macOS / Linux）、Android、iOS 工程、HarmonyOS 工程 |

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

- 官方网站：<https://nowen.cn/>
- 在线体验：<https://note.nowen.cn/>
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

> 首次登录后请立即修改默认密码。公网部署还应配置 HTTPS、备份、正确的公开访问地址，并按需收紧 CORS 与旧版公开附件访问。

查看运行状态和日志：

```bash
docker compose ps
docker compose logs -f --tail=200 nowen-note
```

手动更新镜像：

```bash
docker compose pull
docker compose up -d
```

### Docker 在线升级（可选）

在线升级仅支持仓库内的官方 [`docker-compose.yml`](./docker-compose.yml)，默认关闭。主应用容器不会挂载 Docker Socket；只有独立、内网隔离的 updater 容器拥有受限的 Docker Engine 权限。

```bash
cp .env.example .env
printf '\nNOWEN_UPDATER_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env

# 建议把 vX.Y.Z 替换为 Releases 中的稳定版本
NOWEN_IMAGE_TAG=vX.Y.Z docker compose --profile updater up -d
```

启用后，管理员可在「设置 → 关于 → 版本信息」执行升级前检查、完整备份、升级和失败回滚。数据库发生不可逆迁移时，镜像回滚不等于数据回滚，生产环境必须保留独立备份。

完整说明见 [Docker 在线升级与恢复](./docs/docker-online-update.md)。

### 仅运行主应用

不需要在线升级时，也可以直接运行镜像：

```bash
docker run -d \
  --name nowen-note \
  --restart unless-stopped \
  -p 3001:3001 \
  -e TZ=Asia/Shanghai \
  -v /opt/nowen-note/data:/app/data \
  cropflre/nowen-note:latest
```

## 数据、备份与配置

### 持久化目录

容器内的持久化根目录是 **`/app/data`**，不是 `/data`。默认 Compose 使用名为 `nowen-note-data` 的 Docker Volume。

典型内容：

```text
/app/data/
├── nowen-note.db
├── attachments/
├── backups/
├── fonts/
└── .jwt_secret
```

- 默认数据库为 SQLite，主文件是 `/app/data/nowen-note.db`。
- 附件默认存储在 `/app/data/attachments`，新文件按 `YYYY/MM` 分目录。
- 自动备份默认位于 `/app/data/backups`。
- 生产环境建议把 `BACKUP_DIR` 映射到独立物理磁盘，并遵循 3-2-1 备份原则。
- PostgreSQL 适配与迁移工作仍在持续推进；当前正式部署与恢复流程仍以 SQLite 为默认基线。

### 常用环境变量

绝大多数变量都不是必填项，完整模板见 [`.env.example`](./.env.example)。

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `NOWEN_PORT` | `3001` | Compose 对外暴露端口 |
| `TZ` | `Asia/Shanghai` | 容器时区，会影响待办日期判断 |
| `PUBLIC_WEB_ORIGIN` | 空 | 反向代理或公网域名，用于生成正确的分享链接 |
| `JWT_SECRET` | 自动生成并持久化 | 登录与 sudo token 签名；多实例部署时必须统一配置 |
| `BACKUP_DIR` | `/app/data/backups` | 自动备份目录 |
| `CORS_ORIGINS` | 内置原生客户端来源 | 额外允许的网页 Origin，逗号分隔 |
| `MAX_ATTACHMENT_SIZE_MB` | `100` | 单个附件大小上限 |
| `ATTACHMENT_STORAGE` | `local` | 设为 `s3` 后可接入 S3 / R2 / MinIO |
| `IMAGE_HOSTING_ENCRYPTION_KEY` | 空 | 加密第三方图床密钥 |
| `NOWEN_UPDATER_TOKEN` | 空 | 启用 Docker 在线升级代理 |

对象存储配置见 [附件对象存储](./docs/object-storage.md)。

## 客户端与平台状态

| 平台 | 获取 / 构建方式 | 状态说明 |
| --- | --- | --- |
| **Web / Docker** | Docker Hub 或源码构建 | 推荐部署方式；镜像可构建 `amd64`、`arm64` 或多架构版本 |
| **Windows / macOS / Linux** | [GitHub Releases](https://github.com/cropflre/nowen-note/releases) 或 `npm run electron:build` | Electron 客户端可连接远程服务，也可使用本地后端 |
| **Android** | Releases APK 或 `frontend/` 下使用 Capacitor 构建 | 正式维护 |
| **iOS** | Capacitor 工程与 GitHub Actions / TestFlight 流程 | 需要 Apple 签名与开发者账号，详见 [iOS 发布指南](./docs/iOS-Release.md) |
| **HarmonyOS** | 使用 DevEco Studio 打开 [`nowen-harmony/`](./nowen-harmony/) | ArkTS + ArkWeb MVP；部分原生能力仍在完善 |
| **fnOS** | Releases 中的 `.fpk` | 当前 `.fpk` 主要面向 x86_64 |
| **绿联 UGOS** | Releases / 构建脚本中的 `.upk` | 依赖具体设备架构与应用安装能力 |
| **其他 NAS** | Docker Compose | 群晖、威联通、极空间等均可按 Docker 方式部署 |

> 各平台实际发布的安装包以 [GitHub Releases](https://github.com/cropflre/nowen-note/releases) 为准。

## 本地开发

要求 Node.js 20+、npm、Git。Electron 和原生依赖构建还需要对应平台的编译工具链。

```bash
git clone https://github.com/cropflre/nowen-note.git
cd nowen-note

# 根目录依赖（Electron、Capacitor、构建脚本）
npm install

# 安装前后端依赖并重建原生模块
npm run install:all
```

分别启动两个终端：

```bash
npm run dev:backend
```

```bash
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
| **存储** | SQLite、本地附件、S3 / R2 / MinIO、第三方图床 |
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

- [教程中心](./docs/tutorials/README.md)
- [完整部署指南](./docs/deployment.md)
- [Docker 在线升级与恢复](./docs/docker-online-update.md)
- [附件对象存储](./docs/object-storage.md)
- [邮件备份配置](./docs/backup-email-smtp.md)
- [ARM64 部署](./docs/deploy-arm64.md)
- [iOS 发布指南](./docs/iOS-Release.md)
- [隐私策略](./docs/PRIVACY.md)
- [浏览器剪藏扩展](https://chromewebstore.google.com/detail/nowen-note-web-clipper/nglkodhfdbnfielchjpkjhenfaecafpg)
- OpenAPI：服务启动后访问 `/api/openapi.json`

## 当前边界

- **数据库**：SQLite 是当前默认且完整支持的生产方案；PostgreSQL 迁移仍在开发和验证中。
- **Docker 在线升级**：只支持官方 Compose 受管部署，不支持任意容器、任意镜像或 NAS 应用包。
- **macOS**：安装包若未经过 Apple 公证，首次打开可能需要执行 `xattr` 解除隔离，详见 [桌面端教程](./docs/tutorials/desktop.md)。
- **移动端**：Android 维护最完整；iOS 与 HarmonyOS 的分发、签名和部分原生桥接能力仍受平台工具链限制。
- **快速迭代**：功能和安装包更新较快，请以 Releases、应用内版本信息和 [CHANGELOG.md](./CHANGELOG.md) 为准。

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

<details>
<summary><strong>最近版本更新</strong></summary>

<!-- CHANGELOG:BEGIN -->
## 更新日志

> 完整历史见 [CHANGELOG.md](./CHANGELOG.md)。
<!-- CHANGELOG:END -->

</details>

## 支持作者

如果这个项目对你有帮助，欢迎扫码请作者喝杯咖啡。

<p align="center">
  <img src="./weixin.jpg" alt="微信赞赏码" width="280" />
</p>

也可以阅读 [作者感言](./AUTHOR_STORY.md)。

## 开源协议

[GPL-3.0](./LICENSE)。对外分发派生作品时，需要继续使用 GPL-3.0 并保留原作者版权声明。
