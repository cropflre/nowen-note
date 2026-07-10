# nowen-note

> 自托管的私有知识库，对标群晖 Note Station。
>
> A self-hosted private knowledge base. [English README](./README.en.md) · [作者感言](./AUTHOR_STORY.md) · [在线体验](http://note.nowen.cn/)

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/Node-20%2B-green.svg)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED.svg?logo=docker&logoColor=white)](./Dockerfile)

## 功能概览

- **富文本 + Markdown 双引擎**：Tiptap 3 + CodeMirror 6，共享 AI、版本历史、评论等上层能力；支持表格（单元格水平/垂直居中）、图片、附件
- **AI 助手**：支持通义千问 / OpenAI / Gemini / DeepSeek / 豆包 / Ollama，覆盖写作辅助、生成标题、推荐标签、RAG 知识问答；AI 思考过程自动过滤，仅展示最终回答
- **知识管理**：无限层级笔记本、彩色标签、收藏、回收站（笔记锁定，禁止编辑/收藏/锁定操作）、FTS5 全文搜索
- **待办事项**：任务中心支持树形任务、看板视图、日历视图、甘特图 / 时间轴、任务依赖、重复任务、AI 拆任务、提醒系统、任务模板
- **思维导图**：节点拖拽 / 多选 / 复制粘贴、文件夹管理、导图模板、全屏编辑、滚轮缩放、从笔记生成、收藏与搜索
- **说说 / 动态**：轻量社交化笔记，支持图文混排
- **分享与权限**：4 档权限（仅查看 / 可评论 / 可编辑 / 可编辑需登录）+ 访客留言 + 密码 / 有效期 + 分享链接可撤销、版本回溯
- **实时同步**：基于 Yjs + WebSocket 的多端实时协作，删除 / 回收站操作跨端即时同步；IndexedDB 本地离线缓存
- **文件管理**：图片缩略图（webp 三档自适应，密集图床场景流量降至 1/100）、「我的上传」分类（已引用 / 未引用细分）、孤儿清理；附件按 `YYYY/MM` 分目录存储
- **导出**：Markdown / PDF / Word / PNG / JPG 多格式导出；Android 导出图片可直接保存到系统相册
- **备份与恢复**：定时自动备份、邮件备份推送、一键恢复；Docker / NAS 部署开箱即用
- **多端**：Web / Electron（Win/macOS/Linux）/ Android（Capacitor）
- **自动化**：沙箱插件系统、Webhook、审计日志
- **开发者生态**：MCP Server、TypeScript SDK、CLI、[浏览器剪藏扩展](https://chromewebstore.google.com/detail/nowen-note-web-clipper/nglkodhfdbnfielchjpkjhenfaecafpg)、OpenAPI 3.0（见 [`packages/`](./packages)）

## 技术栈

| 层 | 技术 |
| --- | --- |
| **前端** | React 18 + Vite + TypeScript + Tailwind CSS + Tiptap 3 + CodeMirror 6 |
| **后端** | Hono + better-sqlite3 + WebSocket + Yjs + sharp + sqlite-vec |
| **桌面端** | Electron（Win / macOS / Linux） |
| **移动端** | Capacitor Android |
| **存储** | SQLite（FTS5 全文搜索） + 本地附件目录 + S3 / R2 / MinIO 对象存储 |
| **同步** | 实时同步（Yjs + WebSocket） + IndexedDB 本地离线缓存 |
| **导出** | Markdown / PDF / Word / PNG / JPG |

## 截图

### 桌面端

| AI 写作助手 | AI 服务商配置 |
| :---: | :---: |
| ![桌面 AI 写作](./docs/screenshots/desktop-ai-writing.png) | ![AI 设置](./docs/screenshots/settings-ai.png) |

### 移动端（Android / Capacitor）

| 侧边栏 | 笔记列表 | 编辑器 |
| :---: | :---: | :---: |
| ![移动端侧边栏](./docs/screenshots/mobile-sidebar.png) | ![移动端列表](./docs/screenshots/mobile-list.png) | ![移动端编辑器](./docs/screenshots/mobile-editor.png) |

## 在线体验

不想本地部署？可以直接打开作者维护的官方体验站点：

- 地址：<https://note.nowen.cn/>
- 账号：`demo`
- 密码：`demo123456`

> ⚠ 体验账号为只读演示用途，数据可能被定期重置，请勿存放任何敏感或重要内容。生产使用请按下方「快速开始」自托管部署。

## 快速开始

> 默认管理员：`admin` / `admin123`，首次登录后请立即修改密码。

### Docker（推荐）

```bash
git clone https://github.com/cropflre/nowen-note.git
cd nowen-note
docker-compose up -d
```

访问 `http://<你的IP>:3001`。

### 本地开发

需要 Node.js 20+。

```bash
git clone https://github.com/cropflre/nowen-note.git
cd nowen-note
npm run install:all
npm run dev:backend   # 后端 :3001
npm run dev:frontend  # 前端 :5173
```

访问 `http://localhost:5173`。

### 桌面端 / 移动端

```bash
npm run electron:dev      # Electron 开发
npm run electron:build    # 打包 Windows / macOS / Linux
```

Android 可直接从 [Releases](https://github.com/cropflre/nowen-note/releases) 下载 APK，或 `npx cap sync android && npx cap open android` 自行构建。

### 飞牛 fnOS（.fpk 一键安装）

从 [Releases](https://github.com/cropflre/nowen-note/releases) 下载最新 `nowen-note-x.y.z.fpk`，在飞牛 NAS 「应用中心 → 设置 → 手动安装应用」选中文件即可。安装后桌面出现「弄文笔记」图标，浏览器打开 `http://<飞牛IP>:3001`。

> 当前 .fpk 仅支持 x86_64 飞牛设备（`platform=x86`）。手动打包参见 [scripts/fpk/README.md](./scripts/fpk/README.md)。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3001` | 服务端口 |
| `DB_PATH` | `/app/data/nowen-note.db` | 数据库文件路径 |
| `TZ` | `Asia/Shanghai` | Docker 容器时区；海外用户可改为 `Europe/London`、`America/Los_Angeles` 等 |
| `OLLAMA_URL` | — | 本地 Ollama 地址（可选） |

数据持久化：容器需将 **`/app/data`** 映射到宿主机（不是 `/data`）。镜像已声明 `VOLUME ["/app/data"]`，主流 NAS 面板会自动预填该路径。

Docker 镜像内置 `tzdata`，`docker-compose.yml` 默认设置 `TZ=Asia/Shanghai`，用于保证待办「今日 / 本周 / 逾期」等后端日期判断按本地时区刷新。海外用户可在项目根目录创建 `.env` 并写入自己的时区，例如 `TZ=Europe/London`。

备份策略：自动备份默认写入 `/app/data/backups`，与数据在同一个卷。建议按 3-2-1 原则把 `/app/backups` 另挂到独立磁盘，并设置 `BACKUP_DIR=/app/backups`，详见 [`docker-compose.yml`](./docker-compose.yml) 内的注释。

## 数据目录说明

`/app/data`（本地开发时为项目根目录下的 `data/`）的典型结构如下：

```
data/
├── nowen-note.db          # SQLite 主数据库
├── backups/               # 自动备份文件
├── attachments/           # 所有附件（笔记图片、文件、任务附件等）
│   ├── 2026/06/           # 新附件按 YYYY/MM 分目录存储
│   │   └── <uuid>.<ext>
│   ├── <uuid>.<ext>       # 旧附件平铺路径，仍兼容读取
│   └── .thumbs/           # 缩略图缓存（webp），不要手动删除
└── fonts/                 # 自定义字体
```

- **新附件路径**：`data/attachments/YYYY/MM/<uuid>.<ext>`，按年月自动归档
- **旧附件兼容**：历史版本平铺在 `attachments/` 根目录的文件仍可正常读取，无需迁移
- **`.thumbs` 目录**：缩略图缓存，由系统自动生成和管理。删除后会在下次访问时重新生成，但会导致短暂的缩略图缺失，不建议手动删除
- **`task_attachments`**：待办任务的图片/附件与普通笔记附件共用同一个 `ATTACHMENTS_DIR`，通过数据库关联区分归属

## 文档

- 浏览器剪藏扩展（Chrome / Edge）：[Chrome Web Store](https://chromewebstore.google.com/detail/nowen-note-web-clipper/nglkodhfdbnfielchjpkjhenfaecafpg)
- 部署指南（本地 / Docker / 桌面 / 移动 / 群晖 / 绿联 / 威联通 / 飞牛 / 极空间 / ARM64）：[docs/deployment.md](./docs/deployment.md)
- 附件对象存储（S3 / R2 / MinIO）：[docs/object-storage.md](./docs/object-storage.md)
- 飞牛 .fpk 应用打包：[scripts/fpk/README.md](./scripts/fpk/README.md)
- ARM64 详解：[docs/deploy-arm64.md](./docs/deploy-arm64.md)
- 邮件备份配置：[docs/backup-email-smtp.md](./docs/backup-email-smtp.md)
- 编辑器模式切换：[docs/editor-mode-switch.md](./docs/editor-mode-switch.md)
- 多设备同步验证：[docs/multi-device-sync-validation.md](./docs/multi-device-sync-validation.md)
- iOS 版本说明：[docs/iOS-Release.md](./docs/iOS-Release.md)
- 隐私策略：[docs/PRIVACY.md](./docs/PRIVACY.md)
- OpenAPI：运行后访问 `/api/openapi.json`

> 📚 **教程中心**：[docs/tutorials/](./docs/tutorials/) — 从快速上手到高级功能的完整教程

- **快速上手**：[5 分钟快速上手](./docs/tutorials/quick-start.md) · [界面概览](./docs/tutorials/ui-overview.md) · [创建第一篇笔记](./docs/tutorials/first-note.md)
- **笔记管理**：[文档树 / 笔记本](./docs/tree-tutorial.md) · [标签和收藏](./docs/tutorials/tags-favorites.md) · [搜索](./docs/tutorials/search.md) · [回收站与恢复](./docs/tutorials/trash-recover.md) · [批量管理](./docs/tutorials/batch-manage.md)
- **编辑器**：[富文本编辑器](./docs/tutorials/editor-rich-text.md) · [Markdown 编辑器](./docs/tutorials/editor-markdown.md) · [斜杠命令](./docs/tutorials/slash-commands.md) · [高级块](./docs/tutorials/advanced-blocks.md) · [附件管理](./docs/tutorials/attachments.md) · [导入导出](./docs/tutorials/import-export.md)
- **AI 功能**：[AI 配置](./docs/tutorials/ai-setup.md) · [AI 生成标题和标签](./docs/tutorials/ai-title-tags.md) · [AI 总结](./docs/tutorials/ai-summary.md)
- **思维导图**：[入门](./docs/tutorials/mindmap-intro.md) · [从笔记生成](./docs/tutorials/mindmap-from-note.md) · [导出](./docs/tutorials/mindmap-export.md) · [Mermaid 图表](./docs/tutorials/mermaid.md)
- **待办事项**：[任务中心](./docs/tutorials/tasks.md)
- **说说 / 动态**：[说说功能](./docs/tutorials/diary.md)
- **分享与协作**：[分享](./docs/tutorials/sharing.md) · [实时协作](./docs/tutorials/realtime-collab.md) · [版本历史](./docs/tutorials/version-history.md) · [工作区](./docs/tutorials/workspace.md)
- **多端**：[桌面端](./docs/tutorials/desktop.md) · [移动端](./docs/tutorials/mobile.md) · [Android](./docs/tutorials/android.md) · [鸿蒙](./docs/tutorials/harmony.md) · [Web](./docs/tutorials/web.md)
- **部署与运维**：[Docker](./docs/tutorials/docker-deploy.md) · [NAS](./docs/tutorials/nas-deploy.md) · [备份与迁移](./docs/tutorials/backup-migrate.md) · [安全](./docs/tutorials/security.md)
- **开发者**：[API](./docs/tutorials/api.md) · [SDK](./docs/tutorials/sdk.md) · [CLI](./docs/tutorials/cli.md) · [MCP](./docs/tutorials/mcp.md) · [Webhook](./docs/tutorials/webhook.md) · [剪藏扩展](./docs/tutorials/clipper.md)
- **常见问题**：[附件问题](./docs/tutorials/faq-attachment.md) · [登录问题](./docs/tutorials/faq-login.md) · [性能问题](./docs/tutorials/faq-performance.md) · [同步问题](./docs/tutorials/faq-sync.md)

## 常见问题

### macOS 首次打开报错 / 无法启动 / "ERR_DLOPEN_FAILED"

由于本应用未做 Apple 公证（notarization），系统会把 dmg 里下载来的 `.app`
打上 quarantine 隔离属性，导致内部的 `better-sqlite3` 原生模块加载失败、
后端启动卡住 30 秒后报"后端启动超时"。

终端执行一行命令解除隔离即可（路径换成你实际拖过去的位置）：

```bash
sudo xattr -dr com.apple.quarantine "/Applications/Nowen Note.app"
# 或
sudo xattr -dr com.apple.quarantine ~/Downloads/Nowen\ Note.app
```

执行后双击重新打开即可。Apple Silicon 用户若用了 x64 版本，需要 Rosetta 2
（系统会自动提示安装）。

## 问题反馈

QQ 群：`1093473044`

## 支持作者

如果这个项目对你有帮助，欢迎扫码请作者喝杯咖啡 ☕

<p align="center">
  <img src="./weixin.jpg" alt="微信赞赏码" width="280" />
</p>

## 开源协议

[GPL-3.0](./LICENSE) — 派生作品对外分发时须同样以 GPL-3.0 开源并保留原作者版权声明。

## 最近重要更新

以下为近期完成的功能与修复，按类别整理。

### 移动端体验

- **Android 导出图片保存到相册**：导出为 PNG / JPG 后可直接写入系统相册，无需手动转存
- **移动端编辑器单图保存到相册**：长按编辑器中的单张图片，一键保存到设备相册

### 存储与附件

- **附件按 YYYY/MM 分目录存储**：新上传的附件自动归入 `data/attachments/YYYY/MM/` 目录，避免单目录文件数过多；旧附件平铺路径仍兼容读取
- **待办图片 orphan 清理误删修复**：修复任务附件被孤儿清理逻辑误判为未引用而删除的问题

### 跨端同步

- **删除 / 回收站跨端实时同步**：笔记删除、移入回收站、从回收站恢复等操作通过 WebSocket 实时推送至所有在线客户端
- **笔记列表更新时间开关**：笔记列表支持切换显示「更新时间」或「创建时间」，设置持久化

### 编辑器

- **表格单元格水平 / 垂直居中**：表格工具栏新增单元格对齐选项，支持水平居中和垂直居中
- **回收站笔记锁定**：回收站中的笔记自动进入只读状态，禁止编辑、收藏、锁定等操作，防止误操作

### 思维导图

- **思维导图滚轮缩放修复**：Ctrl + 滚轮缩放改为原生事件监听，修复部分浏览器下页面整体缩放的问题

### 分享

- **笔记本分享链接可撤销**：已生成的分享链接支持一键撤销，撤销后访客立即无法访问

### 搜索与 AI

- **搜索结果误报修复**：修复全文搜索在特定关键词下返回不相关结果的问题
- **AI 思考内容过滤**：AI 回答中的 `<think>` 思考过程不再展示给用户，仅显示最终回答内容

<!-- CHANGELOG:BEGIN -->
## 更新日志

> 最近 5 个版本的更新内容，完整历史见 [CHANGELOG.md](./CHANGELOG.md)。

### v1.3.2 - 2026-07-10

### ✨ 新增

- **images**: mount mobile and share image experience (#199) (553eb59)
- **images**: add compact mobile sheet and share lightbox controls (#199) (8a6a873)
- **images**: add mobile sheet and lightbox helpers (#199) (882614c)
- **markdown**: mount experience bridge (#198) (176894c)
- **markdown**: bridge live preview and split sync (#198) (37791f9)
- **markdown**: unify preview tasks code and anchors (#198) (95ee809)
- **markdown**: add block live preview extension (#198) (e2865b5)
- **markdown**: add mapped split scroll sync (#198) (befcd6b)
- **markdown**: add shared enhanced code block (#198) (15cb544)
- **sidebar**: replace notebook icon picker (#170) (3bd414a)
- **ui**: add searchable emoji picker with recents (#170) (2cf7066)
- **emoji**: add comprehensive local emoji dataset (#170) (fae2995)
- **markdown**: safely render imported HTML and sandboxed iframes (#196) (a9a3968)
- **ai**: mount AI profile switcher bridge (#197) (6ad8151)
- **ai**: manage multiple AI service profiles (#197) (8d9b583)
- **ai**: add chat profile switcher (#197) (e9f8fdd)
- **ai**: add AI profile client (#197) (bb76db1)
- **ai**: add reusable AI profiles and model discovery (#197) (a13e2c6)
- **search**: mount persistent search center (#166) (34327fa)
- **search**: return match counts and notebook metadata (#166) (7c1edef)
- **search**: add full-width search center (#166) (2dc53ea)
- **notes**: mount note icon feature bridge (#171) (fedc653)
- **notes**: add note icon picker and list rendering (#171) (f1fb17a)
- **notes**: add batched note icon client store (#171) (ed692a5)
- **notes**: add persistent note icon metadata API (#171) (b5859a9)
- **notes**: add rename action to note context menus (#172) (772e912)
- **notes**: add context menu rename dialog (#172) (c6276f8)
- **tasks**: add habit check-in module (#191) (18da154)

### 🐛 修复

- **build**: accept missing image action grids (ab2637d)
- **build**: narrow active note before rename update (eebee72)
- **sync**: mark only confirmed detail responses as cached (#200) (c6267b2)
- **sync**: preserve cache detail markers on metadata writes (#200) (02c848d)
- **sync**: preserve offline base fingerprints across queue acknowledgements (#200) (4676c75)
- **sync**: limit safety snapshots to destructive overwrites (#200) (fcb0401)
- **sync**: require complete server note responses (#200) (92a18a6)
- **sync**: require server identity fields for cached details (#200) (e27caa6)
- **sync**: reject list placeholders as note details (#200) (b216739)
- **sync**: distinguish cached details from list placeholders (#200) (2698bd0)
- **sync**: install complete note response guard (#200) (860ae6a)
- **sync**: reject incomplete update responses (#200) (065c8ae)
- **sync**: reject incomplete note detail cache writes (#200) (433fd17)
- **sync**: validate offline base content fingerprints (#200) (79f028b)
- **sync**: fingerprint offline note bases (#200) (1f1dd73)
- **sync**: finalize stale-base validation and conflict drafts (#200) (e6b2ffa)
- **sync**: mark identical draft rebases as conflicts (#200) (7b2b1e5)
- **sync**: preserve conflicted draft base revisions (#200) (86de7c0)
- **sync**: install revision safety trigger (#200) (a8a2e20)
- **sync**: preserve every overwritten note revision (#200) (204b67b)
- **sync**: install note write safety before render (#200) (4b22240)
- **sync**: guard stale and unconfirmed note writes (#200) (91b02ed)
- **sync**: stop blind conflict replays (#200) (68ca026)
- **sync**: distinguish offline note snapshots (#200) (fb97b2c)
- **markdown**: provide live block decorations from state field (#198) (7f23848)
- **images**: install mobile image focus guard (#199) (d1911d1)
- **images**: blur editor when mobile image sheet opens (#199) (3d71a49)
- **images**: use a strict-safe lightbox guard key (#199) (922912d)
- **images**: keep lightbox rotation during zoom (#199) (55a1480)
- **images**: preserve lightbox rotation across zoom updates (#199) (c52b8bc)
- **markdown**: align preview when split mode opens (#198) (1025238)
- **markdown**: stabilize bridge persistence and observers (#198) (2d2425e)
- **siyuan**: bound metadata scans and align document mapping (#196) (db045b5)
- **siyuan**: index assets referenced from imported HTML (#196) (1a47d2b)
- **siyuan**: preserve notebook order and emoji metadata (#196) (7f23f72)
- **siyuan**: preserve emoji and iframe nodes during markdown conversion (#196) (8975f9a)
- **ai**: preserve connection testing for profiles (#197) (fe0c164)
- **ai**: keep profile switcher compact on mobile (#197) (98e25a0)
- **ai**: normalize AI profile request headers (#197) (c6af9fe)
- **ai**: harden profile persistence and preserve icon validation (#197) (7be2687)
- **ai**: reload profiles when chat opens (#197) (d70b413)
- **android**: limit native bridge to JSON reads (d39b27a)
- **android**: install native-first API bridge (e690f83)
- **android**: prefer native HTTP for API reads (64ca208)
- **search**: preserve destination notebook after opening a result (#166) (8f06e93)
- **notes**: show rename in notebook tree context menu (e92279d)
- **notes**: make icon picker race-safe and keyboard friendly (#171) (1c25488)
- **notes**: recreate note icon table after database reset (#171) (e20e4b7)
- **habits**: respect read-only workspace permissions (816827a)
- **habits**: preserve history and validate check-in dates (b24db8c)
- **ui**: load global overlay layer contract (#192) (6558af4)
- **ui**: define settings modal overlay layer (#192) (9c56278)

### ♻️ 重构

- **siyuan**: preserve legacy import implementations (#196) (b243f34)
- **notes**: remove superseded note icon bridge (#171) (6f83dd2)
- **notes**: use stable note icon bridge (#171) (769d3a1)
- **notes**: make note icon DOM integration idempotent (#171) (c8314e8)
- **notes**: isolate note icon picker dialog (#171) (c5aa0db)

### 📝 文档

- add share lightbox control reference (cc4a0e7)
- add mobile image menu issue evidence (0a6653e)
- add live-preview reference screenshot for issue #198 (b1b7021)
- add code-block reference screenshot for issue #198 (e3e98ac)
- add task-list screenshot for issue #198 (16f4e4f)
- add screenshot for issue #198 (dd6853f)

### ✅ 测试

- **sync**: preserve same-revision offline fingerprints (#200) (01fcfd1)
- **sync**: exercise large-body shrink threshold (#200) (1a6d22d)
- **sync**: cover scoped destructive snapshots (#200) (dd804fd)
- **sync**: require identity fields in update responses (#200) (520a818)
- **sync**: require server identity fields for detail cache (#200) (52ca0c9)
- **sync**: distinguish cached details and placeholders (#200) (95f2dca)
- **sync**: reject incomplete cached note details (#200) (08defa4)
- **sync**: reject incomplete update acknowledgements (#200) (c4fa4f3)
- **sync**: cover same-version body mismatches (#200) (9d0fbdd)
- **sync**: use live timestamps for conflict drafts (#200) (e3e3400)
- **sync**: update optimistic-lock expectations (#200) (d5d3d01)
- **sync**: verify guarded note writes end to end (#200) (24582b3)
- **sync**: preserve draft conflict baselines (#200) (9cf3e71)
- **sync**: cover automatic pre-overwrite snapshots (#200) (2c8e376)
- **sync**: cover note write confirmation and conflicts (#200) (ca2ea5d)
- **sync**: prevent blind optimistic-lock replays (#200) (06198d4)
- **markdown**: cover live block decoration installation (#198) (bbbcf26)
- **images**: cover mobile image focus release (#199) (e068437)
- **images**: cover mobile sheet and lightbox navigation (#199) (17a39b9)
- **markdown**: cover tasks and enhanced code blocks (#198) (fd83cb3)
- **markdown**: cover mapped scroll interpolation (#198) (84eafd0)
- **emoji**: start issue 170 validation (c9f0b2d)
- **emoji**: cover categories search and recents (#170) (022a16c)
- **markdown**: isolate HTML preview globals (#196) (7d2c968)
- **markdown**: cover sanitized HTML and iframe rendering (#196) (6427be1)
- **siyuan**: cover order emoji HTML and iframe fidelity (#196) (e498496)
- **ai**: assert normalized profile request headers (#197) (237558f)
- **ai**: cover AI profile client (#197) (4f01866)
- **ai**: cover profiles and model discovery (#197) (24fd351)
- **android**: keep binary API reads on fetch (f4613cf)
- **android**: cover native-first API transport (7ac3627)
- **search**: cover match counts and result metadata (#166) (abf42df)
- **notes**: cover note icon metadata permissions (#171) (d84ec1f)
- **habits**: cover archived stats and validation regressions (2cce98d)

### 🔧 其他

- simplify question issue form (e53f492)
- simplify feature request form (0abd199)
- simplify bug issue form (74da975)
- remove unused issue 198 workflow (5a1256b)
- remove unused issue 198 codemod (b94f4c0)
- run issue 198 implementation and validation (bdd6c56)
- add one-shot markdown experience codemod (#198) (a119e85)
- remove issue 170 validation workflow (39f80a0)
- run one-shot sidebar emoji picker codemod (#170) (bd6960e)
- add one-shot sidebar emoji picker codemod (#170) (b8e759c)
- add usage question issue form (ba24df6)
- add structured feature request form (907cf41)
- add structured bug report form (6448da8)
- configure GitHub issue templates (38a408b)
- remove unused issue #171 PR workflow (37ac2b2)
- remove unused issue #171 apply workflow (26dc740)
- add one-shot PR trigger for issue #171 (659a4c2)
- apply issue #171 implementation (8743075)

### v1.3.1 - 2026-07-09

### ✨ 新增

- **editor**: 优化分屏拖拽 UI 并添加国际化支持 (b0fd101)
- **editor**: 支持分屏宽度拖拽调整、GFM任务复选框交互，优化标题保存逻辑 (96fe728)
- **editor**: 新增分屏拖拽和GFM任务复选框工具模块及测试 (da43c6f)
- **notebooks**: support drag reorder and per-level sort in notebook tree (50eeb2b)
- **notebooks**: add notebook tree sorting (c5b33ec)
- **tasks**: support delayed quick-add reminders (ff023b7)
- **editor**: add canvas image editor (62e627a)
- **editor**: add image action toolbar (a4e62b1)
- **tasks**: smart quick-add recognition (2e0ea40)
- **import**: safely preserve advanced Siyuan rich-text nodes (62e10c2)
- **import**: preserve Siyuan tables in rich-text import (19aab69)
- **import**: improve Siyuan rich-text tiptap fidelity (696e2c4)
- prompt for desktop data directory on first run (#168) (eab97d2)

### 🐛 修复

- **editor**: support line breaks in code blocks (d03a828)
- **editor**: copy image address with origin (c9e0852)
- **editor**: place image toolbar outside image (c179ae9)
- **editor**: keep note sort menu content aligned (327f392)
- **editor**: harden canvas image loading (57bf39c)
- **editor**: guard image replace target (f60fd65)
- **tasks**: require separators for smart recognition (a01d99c)
- 优化思源包导入服务与测试 (a88eb1f)
- guard siyuan zip entry and decompressed size budgets (4418a2c)
- add upload size limits for siyuan package import (891953a)
- keep backend bundle compatible with unzipper s3 helper (c3ed8c3)
- **import**: surface siyuan downgrade report and clean temp artifacts (9d81832)
- **import**: improve md rendering and downgrade reporting (a6c9781)
- **import**: support RT/MD siyuan media rendering (0305b28)
- **ci**: sync backend lockfile for npm ci (0b8551b)

### ✅ 测试

- cover backend siyuan package import (b5fe890)

### 🔧 其他

- 将开发期错误日志加入忽略列表 (84547a1)
- commit all local changes (b80bc3b)

### 📌 杂项

- 功能: 新增用户偏好设置接口与前端集成 (37a24b2)
- 功能: 接口层增加 Android 原生 HTTP 回退机制 (1a08701)
- 功能: AI 设置面板新增自定义 API 预设并优化 Ollama 预设 (8682237)

### v1.3.0 - 2026-07-07

_本版本无可展示的 commit 变更（可能全部是合并 / 工作流修改）_

### v1.2.9 - 2026-07-07

### ✨ 新增

- support custom desktop data directory (#168) (82babec)

### v1.2.8 - 2026-07-07

### ✨ 新增

- combine notebook tree expand toggle (5a283c6)
- add notebook tree expand collapse actions (#162) (add6eba)
- 标题输入框增加 IME 输入法状态感知，避免拼音串被误保存为标题 (9051ece)
- add browser-side size check and asset reference filtering for Siyuan import (fd6879a)

### 🐛 修复

- align notebook tree toggle icon state (3d37362)
- restore cross-device editor sync (da772b4)
- scroll markdown preview outline headings (#163) (b385fb9)
- support markdown default preview and siyuan callouts (#164) (4e94e0a)

<!-- CHANGELOG:END -->
