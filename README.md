<div align="center">
  <img src="./electron/icon.png" alt="Nowen Note" width="104" />
  <h1>Nowen Note（弄文笔记）</h1>
  <p><strong>开源、自托管的知识库、协作笔记与任务工作台</strong></p>
  <p>
    统一知识树 · 富文本 / Markdown 双编辑器 · AI 知识问答 · 实时协作 · 任务与思维导图 · 全平台客户端
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

## 让 AI 连接 Nowen Note

Nowen Note 仍然完整支持 MCP Server，可让 Claude Code、Cursor、VS Code 等 AI 客户端在授权范围内搜索、读取、创建和更新笔记。

- [MCP Server 中文安装教程](./docs/tutorials/mcp.md)
- [MCP Server English guide](./docs/tutorials/mcp.en.md)
- [nowen-mcp 独立包说明](./packages/nowen-mcp/README.md)

当前正式可用方式为源码构建：安装 Node.js 20+，构建 `packages/nowen-mcp`，在 Nowen Note 创建 restricted Personal API Token，再把 `dist/scoped-entry.js` 的绝对路径配置到客户端。教程已覆盖 Windows、macOS、Linux / WSL、NAS 地址、Claude Code、Cursor、VS Code、连接验证、升级和排障。

## 为什么选择 Nowen Note

| | |
| --- | --- |
| **数据真正属于你** | 支持 Docker / NAS 自托管，数据库、附件和备份均由你管理；附件可接入 S3、Cloudflare R2 与 MinIO，备份可同步到邮件或 WebDAV。 |
| **一棵树管理全部内容** | 文件夹、富文本和 Markdown 文档统一组织，根目录也能直接创建文档，支持拖拽、排序、导入、全部展开 / 收起、权限继承、密码保护和共享展示。 |
| **两种编辑格式自由切换** | 富文本与 Markdown 可按笔记互转，保留代码块、链接和主要结构；适合日常记录、技术文档和长文写作。 |
| **个人使用与团队协作兼顾** | 从标签、任务、AI 到工作区、笔记本权限、实时协作、公开分享和访客评论，无需在多套工具之间来回切换。 |

## 核心能力

| 模块 | 当前能力 |
| --- | --- |
| **统一知识树** | 文件夹、富文本与 Markdown 文档混合组织；根目录直接创建内容、无限层级、拖拽排序、统一“+”创建菜单、全部展开 / 收起、Markdown 文件拖入 / 选择导入、筛选搜索、笔记数量统计、回收站与共享目录展示。 |
| **目录安全与访问控制** | 文件夹支持设置、修改与解锁密码；服务端签发短期 JWT 解锁令牌，并在受保护笔记本导入、导出时复用解锁状态。 |
| **富文本与 Markdown** | Tiptap 3 富文本、CodeMirror 6 Markdown、笔记格式互转、实时预览与分屏、可拖拽大纲栏、格式刷、斜杠命令、表格、代码块、KaTeX、Mermaid、脚注、Callout、媒体嵌入、评论与版本历史。 |
| **长文与编辑稳定性** | 大文档复杂度识别、Worker 分析、视口渲染、窗口化编辑和增量保存；大纲可定位尚未加载的章节，Markdown 隐藏块标记与光标同步经过容错处理。 |
| **图片创作** | 支持图片裁剪、文字、画笔、箭头、形状与马赛克，并可将历史网络图片迁移到本地附件或对象存储。 |
| **知识组织与检索** | 彩色标签、收藏、置顶、全文搜索、文内查找替换、双向链接、块引用、反向链接与知识图谱。 |
| **AI 能力** | OpenAI 兼容接口、通义千问、Gemini、DeepSeek、豆包与 Ollama；支持续写、改写、翻译、标题与标签生成、总结、Embedding 索引及 RAG 知识问答。 |
| **任务与可视化** | 树形任务、列表、看板、日历、甘特图 / 时间轴、依赖关系、重复规则、提醒、模板与 AI 拆解；另含说说 / 时间线和思维导图。 |
| **协作、权限与分享** | Yjs + WebSocket 实时协作、工作区与成员角色、钉钉式笔记本访问管理、目录级 ACL、所有权转移、集中分享管理、分享密码与有效期、访客评论和公开知识空间。匿名访客评论前可填写昵称并在评论区正确展示。 |
| **同步与编辑保护** | 支持增量同步与版本检测；版本冲突可按最新写入策略静默处理，并在同步过程中保留待提交编辑与本地快照，减少冲突弹窗和输入丢失。 |
| **导入、导出与迁移** | 支持 Markdown、Word / DOCX、网页 URL、微信公众号文章、SingleFile HTML、思源 ZIP 与 Callout 等导入路径；支持 Markdown、PDF、Word、图片和完整 ZIP 导出，并提供权限映射、冲突预检、报告与受控撤销。导出内容会记录 `contentFormat`，重新导入时可恢复原编辑格式。 |
| **附件与存储** | 本地附件按 `YYYY/MM` 归档；编辑器可从文件管理器搜索并复用已有附件，插入可迁移的相对链接；支持缩略图、笔记归属、引用检查、孤儿重新扫描 / 清理，可使用本地磁盘或 S3 / R2 / MinIO。 |
| **账号与安全** | 多账号登录历史、记住账号 / 自动登录、远程服务连接、会话有效性校验与撤销、2FA、Personal API Token 权限范围、审计日志与安全化附件访问。 |
| **备份、自动化与开放能力** | 本地自动备份、完整 ZIP、邮件备份、凭据加密的 WebDAV 远程备份、Docker 在线升级与回滚检查、Webhook、插件系统、OpenAPI、TypeScript SDK、CLI、[MCP Server](./docs/tutorials/mcp.md) 与浏览器剪藏扩展。 |
| **多端访问** | Web、Electron（Windows / macOS / Linux）、Android、iOS 工程、HarmonyOS 工程，以及 Docker / NAS 部署；移动端支持 Markdown 导入、最近优先、逐层目录、树形目录和可切换紧凑模式。 |

## 近期重点增强

### v1.4.4 · 2026-07-30

- 知识树节点菜单支持将单篇笔记在 Markdown 与富文本之间互转，导出和重新导入时可恢复原格式。
- 桌面端与移动端浏览视图新增“全部展开 / 全部收起”，并改善知识树加载失败提示和错误详情展示。
- 移动端设置新增知识树紧凑模式，可按需缩小目录行高，兼顾可读性与大量笔记的展示密度。
- 公开分享评论会先让匿名访客填写昵称，并在已有评论和新评论中正确展示访客身份。
- 修复格式转换后富文本编辑器交互被 Markdown 模式影响的问题，编辑模式改为按笔记隔离。
- 优化窗口化富文本大纲定位、右键子菜单视口定位、中文输入法斜杠菜单和 Markdown 光标稳定性。
- 修复权限管理在部分后端入口提示 `Not Found`、根文档下创建子节点结构异常等问题。

此前 v1.4.3 已加入文件夹密码保护、附件库复用、WebDAV 远程备份、根目录文档、移动端 Markdown 导入和新版笔记本权限管理。

完整版本记录请查看 [CHANGELOG.md](./CHANGELOG.md) 与 [GitHub Releases](https://github.com/cropflre/nowen-note/releases)。

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

在线升级仅支持仓库内的官方 [`docker-compose.yml`](./docker-compose.yml)，且默认关闭。主应用容器不会挂载 Docker Socket；只有独立、内网隔离并受限运行的 updater 容器拥有 Docker Engine 权限。

```bash
cp .env.example .env
printf '\nNOWEN_UPDATER_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env

# 建议将 vX.Y.Z 替换为 Releases 中的稳定版本
NOWEN_IMAGE_TAG=vX.Y.Z docker compose --profile updater up -d
```

启用后，管理员可在「设置 → 关于 → 版本信息」执行升级前检查、完整备份、升级、健康验证和失败回滚。

> 镜像回滚不等于数据库回滚。生产环境必须保留独立备份。

完整说明见 [Docker 在线升级与恢复](./docs/docker-online-update.md)。

### 仅运行主应用

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
- 第三方图床上传链路已退役，新图片统一进入附件系统；历史网络图片可按需迁移到本地或对象存储。
- PostgreSQL 适配和迁移仍在验证中，当前正式部署与恢复流程继续以 SQLite 为默认基线。

### 常用环境变量

完整模板见 [`.env.example`](./.env.example)。

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `NOWEN_PORT` | `3001` | Compose 对外暴露端口 |
| `TZ` | `Asia/Shanghai` | 容器时区，会影响待办日期判断 |
| `PUBLIC_WEB_ORIGIN` | 空 | 反向代理或公网域名，用于生成正确的分享链接 |
| `JWT_SECRET` | 自动生成并持久化 | 登录、会话与部分加密回退；多实例部署时必须统一配置 |
| `BACKUP_DIR` | `/app/data/backups` | 自动备份目录 |
| `BACKUP_WEBDAV_ENCRYPTION_KEY` | 回退到 `JWT_SECRET` | 加密保存 WebDAV 备份凭据，生产环境建议单独配置 |
| `CORS_ORIGINS` | 内置原生客户端来源 | 额外允许的网页 Origin，逗号分隔 |
| `MAX_ATTACHMENT_SIZE_MB` | `100` | 单个附件大小上限 |
| `ATTACHMENT_STORAGE` | `local` | 设为 `s3` 后可接入 S3 / R2 / MinIO |
| `CALENDAR_EXPORT_ENCRYPTION_KEY` | 空 | 加密日历 S3 镜像导出凭据 |
| `NOWEN_UPDATER_TOKEN` | 空 | 启用 Docker 在线升级代理 |

- [附件对象存储](./docs/object-storage.md)
- [WebDAV 远程备份](./docs/webdav-backup.md)
- [邮件备份配置](./docs/backup-email-smtp.md)

## 客户端与平台状态

| 平台 | 获取 / 构建方式 | 状态说明 |
| --- | --- | --- |
| **Web / Docker** | Docker Hub 或源码构建 | 推荐部署方式；镜像可构建 `amd64`、`arm64` 或多架构版本 |
| **Windows / macOS / Linux** | [GitHub Releases](https://github.com/cropflre/nowen-note/releases) 或 `npm run electron:build` | Electron 客户端可连接远程服务，也可使用本地后端；便携版已优化启动解压与启动提示 |
| **Android** | Releases APK 或在 `frontend/` 下使用 Capacitor 构建 | 正式维护；支持系统分享导入、Markdown 文件导入、沉浸式编辑和移动端知识树 |
| **iOS** | Capacitor 工程与 GitHub Actions / TestFlight 流程 | 需要 Apple 签名与开发者账号，详见 [iOS 发布指南](./docs/iOS-Release.md) |
| **HarmonyOS** | 使用 DevEco Studio 打开 [`nowen-harmony/`](./nowen-harmony/) | ArkTS + ArkWeb MVP；部分原生能力仍在完善 |
| **fnOS** | Releases 中的 `.fpk` | 当前 `.fpk` 主要面向 x86_64 |
| **绿联 UGOS** | Releases / 构建脚本中的 `.upk` | 依赖具体设备架构与应用安装能力 |
| **其他 NAS** | Docker Compose | 群晖、威联通、极空间等可按 Docker 方式部署 |

> 各平台实际发布的安装包以 [GitHub Releases](https://github.com/cropflre/nowen-note/releases) 为准。

## 本地开发

要求 Node.js 20+、npm、Git。Electron 和原生依赖构建还需要对应平台的编译工具链。

```bash
git clone https://github.com/cropflre/nowen-note.git
cd nowen-note
npm install
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
| **存储与备份** | SQLite、本地附件、S3 / Cloudflare R2 / MinIO、邮件与 WebDAV 备份；PostgreSQL 处于适配验证阶段 |
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

- [MCP Server 安装与使用](./docs/tutorials/mcp.md)
- [MCP Server installation guide](./docs/tutorials/mcp.en.md)
- [教程与帮助中心](./docs/tutorials/README.md)
- [官网功能帮助中心](http://nowen.cn/docs/nowen-note-features)
- [官网安装与问题解答](http://nowen.cn/docs/nowen-note-help)
- [官网 API 文档](http://nowen.cn/docs/nowen-note-api)
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
- **WebDAV**：用于上传已经完成的备份文件，不是实时同步、数据库运行目录或附件在线存储后端；远端文件生命周期需由 WebDAV 服务或管理员管理。
- **Docker 在线升级**：只支持官方 Compose 受管部署，不支持任意容器、任意镜像或 NAS 应用包。
- **第三方图床**：上传能力已退役，保留的是历史配置清理与存量图片迁移能力。
- **macOS**：安装包若未经过 Apple 公证，首次打开可能需要执行 `xattr` 解除隔离，详见 [桌面端教程](./docs/tutorials/desktop.md)。
- **移动端**：Android 维护最完整；iOS 与 HarmonyOS 的分发、签名和部分原生桥接能力仍受平台工具链限制。
- **快速迭代**：功能和安装包更新较快，请以 Releases、应用内版本信息和 [CHANGELOG.md](./CHANGELOG.md) 为准。

## 版本与更新

README 维护稳定的项目定位、能力范围、近期重点增强和部署方式；完整提交历史不在首页重复展开。

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
    <td align="center"><img src="./frontend/public/weixin.jpg" alt="微信赞赏码" width="260" /></td>
    <td align="center"><img src="./frontend/public/zhifubao.png" alt="支付宝赞赏码" width="260" /></td>
  </tr>
</table>

也可以阅读 [作者感言](./AUTHOR_STORY.md)。

## License

Nowen Note 基于 [GNU General Public License v3.0](./LICENSE) 开源。

<!-- CHANGELOG:BEGIN -->
<!-- 详细版本记录请查看 CHANGELOG.md；README 仅维护稳定能力与近期重点增强。 -->
<!-- CHANGELOG:END -->
