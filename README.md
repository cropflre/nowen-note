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

### v1.3.9 - 2026-07-17

### 🐛 修复

- **release**: 发版前校验环境与登录状态 (bb7879a)

### 🤖 CI

- remove temporary PostgreSQL permissions validation (e4dd96e)
- add temporary PostgreSQL permissions validation (91fbc00)

### 🔧 其他

- **ci**: remove temporary PostgreSQL batch B validator (162d9f6)
- **ci**: expose latest PostgreSQL validation result (fa02ec7)
- **ci**: validate PostgreSQL unified batch B (4939808)

### v1.3.8 - 2026-07-17

### ✨ 新增

- **sdk**: attach binary APIs to NowenClient (#148) (f593438)
- **cli**: register attachment commands (#148) (aacd8b8)
- **cli**: add attachment commands (#148) (44de067)
- **cli**: add attachment client (#148) (9324c04)
- **sdk**: export attachment client (#148) (72a2f58)
- **sdk**: expose attachment API client (#148) (52e809a)
- **share**: publish runtime origin to all link builders (#318) (c588191)
- **share**: share runtime origin across all public links (#318) (6f0b018)
- **share**: let admins configure public origin in modal (#318) (1e3fe19)
- **share**: load runtime public origin into site config (#318) (1302344)
- **share**: resolve and explain public link origin (#318) (69e851c)
- **share**: expose runtime public origin setting (#318) (13978dd)
- **share**: resolve runtime public web origin (#318) (4e08054)
- **sync**: serialize versioned note updates (#319) (3fdb7f0)
- **sync**: add latest-only versioned save queue (#319) (488b7dc)
- **import**: route Word imports through safe worker pipeline (#76) (1bf4059)
- **import**: mount global DOCX import center (#76) (241c24d)
- **import**: add DOCX progress, cancel, and retry center (#76) (9871562)
- **import**: add verified attachment-backed DOCX import (#76) (b8061fe)
- **import**: add cancellable DOCX import task coordinator (#76) (3e0df44)
- **import**: parse DOCX files off the main thread (#76) (7903d0b)
- **import**: add DOCX safety and integrity guards (#76) (dfacd40)
- **import**: embed WeChat favorites export guide (340d6bb)
- **import**: restructure import hub sources (#310) (a302b86)
- **sharing**: complete sharing management workflows (#308) (63d483e)
- **workspace**: reuse emoji picker in admin workspace editor (#309) (d922f58)
- **workspace**: select emoji icons in create and edit dialogs (#309) (39dca86)
- **workspace**: persist and broadcast emoji icons (#309) (251e4b5)
- **workspace**: add reusable emoji icon field (#309) (ca02760)
- **workspace**: validate emoji workspace icons (#309) (5a4e789)
- **db**: add imported note origin mapping schema (#303) (ea125ee)
- **import**: expose WeChat favorites in migration hub (#303) (5abe02d)
- **import**: add WeChat favorites import UI (#303) (922a05a)
- **import**: add WeChat favorites import client (#303) (d1543d1)
- **import**: mount WeChat favorites package endpoint (#303) (27e7791)
- **import**: add streaming WeChat favorites import route (#303) (8ca32e8)
- **import**: implement WeChat favorites package import (#303) (c07e442)
- **import**: add WeChat favorites package adapter (#303) (fd2b3f2)
- **import**: expose Obsidian Vault migration in data manager (#195) (e642299)
- **import**: add Obsidian Vault import UI (#195) (c80175a)
- **import**: import Obsidian notes and attachments (#195) (dde475e)
- **import**: resolve and rewrite Obsidian attachment links (#195) (5171cae)
- **import**: scan Obsidian folders and ZIP archives (#195) (b6e238a)
- **import**: add Obsidian path and media helpers (#195) (8c524be)
- **import**: add Obsidian import data model (#195) (b4346b2)
- **knowledge**: complete backlink UX, graph and block embeds (#165) (e9d86e0)
- **editor**: localize remote images and warn on risky paste colors (#302) (863544e)
- **knowledge**: add universal block links and MCP block tools (#165) (6381781)
- **postgres**: add API token resource scope schema (b92015e)
- **mcp**: wire knowledge tool scope context (31b20bb)
- **mcp**: inject notebook scope into knowledge tool (f95cf6d)
- **mcp**: allow notebook-scoped knowledge ask (fdb65fb)
- **settings**: manage token notebook resources (31bbc7e)
- **auth**: mount API token resource enforcement (721292f)
- **tokens**: manage notebook resource grants (f2cd75a)
- **auth**: persist API token resource mode (07202f0)
- **auth**: enforce API token notebook resources (4a5aef7)
- **mcp**: enable scoped token entrypoint (ed359a3)
- **mcp**: enforce scoped token requests (8cf351b)
- **mcp**: add notebook scope policy (d186155)
- **publication**: surface public space in signed-in workspace (#215) (9fe3bae)
- **publication**: add signed-in public-space entry (#215) (6fb4de3)
- **audit**: classify notebook publication events (#215) (c21c211)
- **publication**: mount public knowledge-space routes (#215) (5cf1fe8)
- **publication**: expose public modes and directory permissions (#215) (946ceb2)
- **publication**: add public notebook knowledge-site view (#215) (7cb3bd7)
- **publication**: add notebook publishing API client (#215) (7a6d8ad)
- **publication**: activate notebook publishing routes (#215) (ea3f70a)
- **publication**: add public notebook publishing and directory ACL (#215) (b344923)
- **permissions**: support directory comment and manage overrides (#215) (00df2fd)
- **permissions**: inherit notebook ACL through directory tree (#215) (d153519)
- **publication**: authorize notebook publication attachments (#215) (a6bb1e8)
- **code-block**: load wrapping overrides (#287) (98289a3)
- **code-block**: enable automatic line wrapping (#287) (0b4ed2d)
- **ai**: resolve AI settings by user (482e572)
- **ai**: add per-user AI settings storage (ec45751)
- **backup**: activate automatic full backups (#291) (7d07948)
- **backup**: make automatic backups attachment-safe (#291) (05b6463)
- **ai**: mount embedding settings in AI preferences (d01e31d)
- **ai**: add embedding settings panel (f86b5b3)
- preserve SiYuan custom icons on import (#245) (a033eec)

### 🐛 修复

- **cli**: normalize attachment query typing (#148) (ae21ad6)
- **sdk**: normalize attachment query typing (#148) (9474c03)
- **editor**: resolve list rendering regressions (#322) (c3a93e2)
- **export**: preserve native Markdown in single-note exports (#320) (4d826ea)
- **tasks**: 修复任务详情模块编译错误 (4909726)
- **share**: warn when public links use protected origin (#318) (7061e18)
- **sync**: install per-note update serialization (#319) (d212ede)
- **editor**: install global NodeView mutation guard (#317) (8d7ae28)
- **editor**: guard all NodeView mutations in read-only mode (#317) (223e21f)
- **editor**: enforce code block read-only toolbar permissions (#317) (c64e6ab)
- **editor**: block code dissolve transactions in read-only mode (#317) (49d251f)
- **editor**: define code block read-only action policy (#317) (3cd02e7)
- **tasks**: save custom repeat rules with current values (#315) (ef3ec24)
- **tasks**: install task update safety bridge (#315) (2601594)
- **tasks**: normalize repeat requests and surface update failures (#315) (1397c9c)
- **tasks**: centralize custom repeat rule construction (#315) (98029a1)
- **import**: return void from DOCX progress cleanup (#76) (88c2dde)
- **import**: keep DOCX worker compatible with bundled JSZip types (#76) (51871b4)
- **import**: accept optional normalized format snapshot (#76) (1993ffe)
- **import**: tolerate block whitespace during DOCX verification (#76) (b90686c)
- **import**: verify normalized DOCX persistence safely (#76) (55bae5b)
- **import**: distinguish DOCX semantic and persistence checks (#76) (7818bfa)
- **export**: normalize image export timestamps as UTC (#314) (94d03b8)
- **export**: preserve wide table columns in note images (#312) (b2d4d61)
- **editor**: stabilize outline heading navigation (#313) (0d6dc30)
- **editor**: keep table and text bubble menus mutually exclusive (#311) (8962262)
- **sharing**: keep counted sessions valid at view limit (#308) (020cf60)
- **sharing**: enforce share security and lifecycle (#308) (942236a)
- **sharing**: enforce public notebook read-only permissions (d74015c)
- **ci**: fetch issue 165 branches with explicit refspecs (2764eb7)
- **ci**: source issue 165 patches from preserved branch (19098dd)
- **ci**: apply issue 165 on latest main tree (51cdf41)
- **editor**: make issue 302 patch resume from diagnostics (d462dd9)
- **ci**: capture issue 165 patch failures (c727bd6)
- **knowledge**: preserve markdown block links and HTML notes (#165) (3b8fccb)
- **knowledge**: correct block idempotency and shared test fixture (e44705e)
- **knowledge**: align issue 165 migration and backlink types (6aad2f8)
- **knowledge**: structurally rewrite backlink excerpt patch (56e23ab)
- **knowledge**: correct backlink panel patch nesting (beb91e5)
- **knowledge**: normalize content format block patch spacing (0632b2b)
- **knowledge**: repair issue 165 client fixer syntax (eae9f06)
- **knowledge**: make issue 165 MCP search patch structural (cbc28cc)
- **editor**: preserve async insert position after dividers (#301) (7075187)
- **auth**: preserve compatibility and restricted boundaries (62b5af4)
- **test**: initialize token scope fixtures without top-level await (24a193a)
- **frontend**: include ES2022 library typings (1717ff1)
- bug (2a63fbf)
- **tasks**: 排除已删除任务的统计动态 (a8b402b)
- **frontend**: 使用 pdf.js 预览 PDF 附件 (ac543eb)
- **frontend**: 修正公开笔记本预览导入 (fcd42ef)
- **notes**: 保持置顶分组手动排序一致 (ff22434)
- **publication**: normalize public note formats and server URLs (#215) (d418b63)
- **publication**: keep public reader build-safe and responsive (#215) (11e84f8)
- **frontend**: 修正浏览器定时器类型 (9f4952c)
- **notes**: 同步置顶笔记到所有视图 (f3eba84)
- **ai**: normalize embedding fallback values (6a0c6d0)
- **ai**: prevent embedding queue starvation (e4948e0)
- **ai**: preserve defaults and safe migration boundaries (b86cab9)
- **ai**: isolate task and embedding configuration (137ef94)
- **editor**: 恢复视频控件交互 (9bdd0ef)
- **ai**: isolate settings and profiles by user (db28ef2)
- **backup**: avoid private-member typing in runtime tests (#291) (3c4439a)
- **backup**: keep automatic full-backup patch type-safe (#291) (d837416)
- **notebooks**: cover legacy parent updates in reconciliation (#211) (7e21011)
- **notebooks**: activate database tree guards (#211) (dc16019)
- **notebooks**: enforce tree integrity at database boundary (#211) (21756a9)
- **notebooks**: reconcile tree and note scope after moves (#211) (52ffb73)
- **notebooks**: invalidate tree after confirmed moves (#211) (902c411)
- **notebooks**: add authoritative tree invalidation event (#211) (6b1dcec)
- align SiYuan imported previews (#284) (a6f98e7)

### ♻️ 重构

- **sdk**: use public client entry (#148) (20ec838)
- **share**: keep origin resolver storage-lazy (#318) (f176a26)
- **import**: align Youdao component name (#310) (697a021)
- **import**: preserve Youdao folder importer alongside Obsidian (#195) (f01b405)

### 📝 文档

- **attachments**: document SDK and CLI workflows (#148) (a281a2b)
- **docker**: expose runtime public share origin (#318) (87e445b)
- **import**: write complete WeChat Favorites export tutorial (109a125)
- **import**: document WeChat favorites migration (#303) (82cde11)
- **mcp**: update for server token resource scopes (8feb232)
- **mcp**: document server-enforced token resources (a2aaaf0)
- **mcp**: document token notebook scopes (38c5e13)
- 添加删除任务动态过滤实现计划 (06bce80)
- 记录删除任务动态过滤设计 (3237f9d)
- 添加置顶实时重排实现计划 (d1f4708)
- 设计置顶笔记实时重排 (6d6c894)
- 规划视频控件事件修复 (0f86e91)
- 设计视频控件事件隔离 (ba2f33a)
- align AI isolation migration version (fcdec71)
- 规划用户 AI 配置隔离 (eb6dad0)
- 设计用户 AI 配置隔离 (4bc5a77)

### 💄 样式

- **share**: use supported warning background opacity (#318) (7bbcd8b)

### ✅ 测试

- **sdk**: add attachment contract test script (#148) (ace8a96)
- **sdk**: cover attachment API workflows (#148) (3f20048)
- **share**: cover shared runtime origin registry (#318) (21b760c)
- **share**: cover runtime public origin priority (#318) (8418ad8)
- **share**: cover public web origin resolution (#318) (837065b)
- **sync**: cover latest-only versioned save queue (#319) (cad79e9)
- **editor**: cover global NodeView read-only guard (#317) (7b24051)
- **editor**: type code block transaction regression (#317) (ab83581)
- **editor**: cover code block read-only mutations (#317) (19ff130)
- **tasks**: verify repeat payload object at API boundary (#315) (89ba532)
- **tasks**: cover custom repeat current-value regression (#315) (1ec4d58)
- **import**: cover safe DOCX conversion and integrity (#76) (9fd3d43)
- **export**: cover UTC image export timestamps (#314) (e1f2d96)
- **workspace**: cover emoji icon validation and permissions (#309) (12e464a)
- **import**: initialize WeChat import schema after test DB setup (#303) (a61bf6c)
- **import**: cover WeChat favorites adapter and idempotency (#303) (62248b0)
- **import**: cover Obsidian paths and attachment rewrites (#195) (f01f21e)
- **editor**: record issue 302 implementation diagnostics (146ed9b)
- **knowledge**: update issue 165 implementation diagnostics (d854162)
- **knowledge**: record issue 165 implementation diagnostics (fb2d972)
- **editor**: record issue 301 fix diagnostics (988c8c3)
- **auth**: record final token boundary validation (066d695)
- **auth**: cover restricted boundaries and legacy compatibility (40f38ab)
- **mcp**: record Phase 2-3 revalidation (0e04395)
- **mcp**: record final Phase 2-3 validation (bab2dc5)
- **auth**: cover API token notebook resource enforcement (042881f)
- **mcp**: record Phase 2-3 validation (5fe8965)
- **mcp**: cover notebook scope policy (49e3003)
- **tasks**: 确保初始化失败时清理临时库 (a09e362)
- **tasks**: 确保活动路由测试清理临时库 (724888f)
- **tasks**: 复现删除任务动态残留 (1dbd71a)
- **permissions**: cover inherited directory ACL overrides (#215) (1c52a8c)
- **editor**: 覆盖视频 NodeView 事件链 (1fbb2aa)
- **backup**: cover automatic full backup retention (#291) (91a0a87)
- **notebooks**: cover confirmed tree invalidation (#211) (b0f5763)
- **notebooks**: cover root moves and tree safety (#211) (e97d78e)

### 🔧 其他

- **ci**: remove temporary PostgreSQL unified validator (6d74d2b)
- **ci**: validate packaged PostgreSQL parity migration (a2f46df)
- **ci**: trigger PostgreSQL validation by PR command (7711dd4)
- **ci**: report PostgreSQL unified validation to PR (b59a230)
- **ci**: trigger unified PostgreSQL validation on PR edits (8d25c2b)
- **ci**: validate PostgreSQL unified branch (10b138d)
- **issue-322**: expose validation diagnostics (643542a)
- **issue-322**: use PR event runner (34586ec)
- **ci**: execute issue #322 migration (19c5501)
- **issue-322**: register deterministic runner (813315d)
- **issue-322**: add deterministic main migration (29eeff0)
- **ci**: run issue #322 implementation (6a5e883)
- **ci**: simplify issue #322 runner (bf55ed8)
- **ci**: diagnose issue #322 patch application (7356a38)
- **ci**: enable issue #322 command trigger (f1a4ca8)
- **ci**: apply issue #322 on main (ac79974)
- **issue-322**: stage regression tests (e349bc7)
- **issue-322**: stage export css patch (9601917)
- **issue-322**: stage list css patch (6aa4686)
- **issue-322**: stage editor patch (afee353)
- **ci**: remove issue 320 trigger (a3279c8)
- **ci**: remove unused issue 320 workflow (88adfa5)
- **ci**: allow PR-triggered issue 320 validation (b719f6d)
- **ci**: trigger issue 320 validation (1062bd8)
- **ci**: add one-shot issue 320 validation (0dcf096)
- **ci**: remove issue 319 trigger file (78b8f8c)
- **ci**: remove issue 319 trigger workflow (bd52153)
- **ci**: remove issue 319 apply workflow (105751b)
- **ci**: trigger issue 319 validation (ab32d56)
- **ci**: add issue 319 workflow trigger (cb46f9e)
- **ci**: apply and validate issue 319 fix (e6a3554)
- **issue-76**: remove inactive validation trigger (c2e3c5e)
- **issue-76**: remove inactive validation workflow (9ca91f4)
- **issue-76**: trigger DOCX import validation (db4bf1b)
- **issue-76**: stage DOCX import validation (1823fd3)
- clean issue 314 trigger (b4199e4)
- remove unused issue 314 workflow (a4596d9)
- retrigger issue 314 implementation (96415d9)
- trigger issue 314 implementation (3ac3c8f)
- stage issue 314 validation workflow (bec45fe)
- stage issue 312 implementation (ff58fb5)
- trigger issue 313 implementation (18a53b7)
- stage issue 313 validation workflow (7ab80d1)
- **import**: validate inline WeChat favorites guide (69666e3)
- **import**: stage inline WeChat favorites guide (2de144a)
- **issue-311**: make fix validation observable (06991ea)
- **issue-311**: add deterministic bubble fix script (769914b)
- **issue-310**: remove final one-time workflow log (cd4cc86)
- **issue-310**: capture import hub migration failure (12624a7)
- **issue-310**: remove one-time validation workflow (276833b)
- **issue-310**: remove one-time migration script (23bc621)
- **issue-310**: remove duplicate-run diagnostic (73c46d5)
- **issue-310**: make migration validation observable (982d650)
- **issue-310**: run validated import hub migration (f151475)
- **issue-311**: run robust bubble fix validation (2b8a2b5)
- **issue-310**: stage import hub IA migration script (7abd873)
- **issue-311**: diagnose failed bubble fix run (b34dd49)
- **issue-311**: stage bubble menu fix validation (83332c4)
- **issue-311**: capture selection handler excerpt (be11521)
- **issue-311**: inspect editor selection handling (0cf94e0)
- **issue-308**: validate final share-session consistency (6f9f0f6)
- **issue-308**: stage final session-limit consistency fix (f714beb)
- **issue-308**: rerun sharing validation with public comment alignment (0aa8024)
- **issue-308**: align public comment form patch (301a1bf)
- **issue-308**: record sharing management validation failure (c0fe1c8)
- **issue-308**: rerun sharing validation with literal-safe patch (1b07238)
- **issue-308**: finalize literal type patch helper (6e4a9d3)
- **issue-308**: preserve literal escapes in type patch (0795544)
- **issue-308**: rerun sharing validation with fixed helper syntax (150422c)
- **issue-308**: fix scoped type patch syntax (d885d4a)
- **issue-308**: rerun sharing validation with scoped type patch (0577af3)
- **issue-308**: narrow share-link type patch (40c66f8)
- **issue-308**: validate sharing management implementation (4ca1af1)
- **issue-308**: preserve share-link repository async API (757754d)
- **issue-308**: stage sharing management implementation (6c98469)
- **issue-308**: rerun backend validation with migration repair (0bde7c5)
- **issue-308**: repair migration sequence for validation (cd44469)
- **issue-308**: record backend validation failure (54f551b)
- **issue-308**: rerun backend validation with type fixes (d79ed21)
- **issue-308**: fix validation type surfaces (f7acfc4)
- **issue-308**: rerun backend validation with publication alignment (2793b6b)
- **issue-308**: align publication scope patch (bf98a6f)
- **issue-308**: rerun backend validation with PG alignment (bee32cf)
- **issue-308**: align PostgreSQL patch markers (032e55d)
- **issue-308**: persist backend validation diagnostics (9f21e3f)
- **issue-308**: validate share security implementation (fe421d8)
- **issue-308**: stage share security implementation (786682f)
- **ci**: remove stale branch cleanup workflow (8aff574)
- **ci**: trigger stale branch cleanup (2c5181b)
- **ci**: add one-shot stale branch cleanup (4862936)
- **ci**: trigger public notebook read-only fix (aa63272)
- **ci**: stage public notebook read-only fix (d8f3068)
- **ci**: trigger validated issue 165 promotion (2706a3a)
- **ci**: promote validated issue 165 feature tree (9df14fd)
- **ci**: retry issue 165 explicit branch fetch (3f4289e)
- **ci**: rerun issue 165 from preserved patch branch (89d38c6)
- **ci**: run issue 165 against latest main (dd8838b)
- **ci**: retry repaired issue 165 normalizer (11dec1f)
- **ci**: retry escaped issue 165 patch (db2a42e)
- **ci**: retrigger issue 302 implementation (5368b5f)
- **ci**: resume validated issue 302 implementation (00e4382)
- **ci**: retry structural Markdown note-link patch (c31fdaa)
- **ci**: retry normalized issue 165 patches (47523f6)
- **ci**: retrigger issue 165 with patch diagnostics (91f0b9d)
- **ci**: trigger issue 165 remaining-feature runner (406a90a)
- **ci**: add issue 165 remaining-feature runner (3598316)
- **ci**: trigger issue 302 implementation (5975b56)
- **ci**: validate and apply issue 302 (73fc7a4)
- **editor**: add issue 302 implementation script (951999e)
- **ci**: trigger issue 165 markdown HTML follow-up (16c4d10)
- **ci**: validate issue 165 markdown and HTML follow-up (966260a)
- **knowledge**: add issue 165 markdown follow-up patch (9b576ea)
- **ci**: trigger final issue 165 validation (85c0cb9)
- **ci**: retry issue 165 final backend assertions (fda837f)
- **ci**: trigger compile-fixed issue 165 patch (c0000ca)
- **ci**: retry issue 165 after compile fixes (5a0b96b)
- **ci**: trigger structural issue 165 patch (d407eab)
- **ci**: retry issue 165 with structural client patches (9991aa4)
- **ci**: trigger backlink-corrected issue 165 patch (4a787a6)
- **ci**: retry issue 165 after backlink patch fix (f27e838)
- **ci**: trigger normalized issue 165 patch (d858666)
- **ci**: retry issue 165 after patch normalization (c63b127)
- **ci**: retrigger issue 165 implementation (95dc3c6)
- **ci**: retry issue 165 implementation workflow (37b2f7a)
- **ci**: trigger issue 165 implementation (7ee80a1)
- **ci**: add issue 165 implementation workflow (7dc8b37)
- **knowledge**: add issue 165 client patch script (b1f1c69)
- **knowledge**: add issue 165 backend patch script (c7aa293)
- **ci**: trigger deterministic issue 301 fix (fb06f09)
- **ci**: add deterministic issue 301 apply workflow (51ff88a)
- **editor**: add deterministic issue 301 patch script (1729a26)
- **ci**: trigger issue 301 fix diagnostics (178db0c)
- **ci**: add issue 301 fix diagnostics (5ce042c)
- **ci**: retrigger direct fix for issue 301 (8e8be29)
- **ci**: trigger direct fix for issue 301 (5b72769)
- **ci**: add direct main fix workflow for issue 301 (a438539)
- **ci**: trigger final token boundary validation (4871786)
- **ci**: add final token boundary validation (786e706)
- **auth**: remove completed compatibility workflow (2e59294)
- **auth**: remove completed compatibility trigger (f7f0167)
- **auth**: retrigger compatibility boundary patch (d6be5ff)
- **auth**: include restricted tag boundary patch (a53d065)
- **auth**: trigger unrestricted compatibility patch (9363753)
- **auth**: add one-shot unrestricted compatibility patch (2357cae)
- **ci**: trigger Phase 2-3 revalidation (2229dda)
- **ci**: add Phase 2-3 revalidation (429ea3f)
- **mcp**: remove completed closeout workflow (75e52c2)
- **mcp**: remove completed closeout trigger (8cf6790)
- **ci**: trigger final Phase 2-3 validation (1e505a9)
- **ci**: add final Phase 2-3 validation (a8e4707)
- **mcp**: retrigger Phase 2-3 closeout (134cb35)
- **mcp**: trigger Phase 2-3 closeout (7a181a4)
- **mcp**: add one-shot Phase 2-3 closeout patch (428da1e)
- **ci**: trigger Phase 2-3 validation (924bfb4)
- **ci**: add one-shot Phase 2-3 validation (c4150d5)
- **auth**: trigger token scope mount (ed3c4e8)
- **auth**: add one-shot token scope patch workflow (5d29f5f)
- **db**: remove temporary unified regression patch workflow (b0d679c)
- **db**: trigger unified regression patch from validation PR (303f405)
- **db**: patch unified migration regression conflicts (9528dcb)
- **db**: remove PostgreSQL unified branch bootstrap workflow (586016b)
- **db**: bootstrap unified PostgreSQL migration branch (3b30b7c)

### v1.3.7 - 2026-07-14

### ✨ 新增

- **标签栏**: 添加全部标签快速切换 (88ec3ac)
- **笔记体验**: 添加打印与紧凑侧栏布局 (e414baf)

### 🐛 修复

- **notebooks**: apply inherited sort to notes (6d6bfc5)
- **editor**: 全端关闭文档拼写检查（任务 1） (04ff8a4)
- 修复反代部署附件刷新后变成 127.0.0.1 裂图 (#295) (f02f14a)
- **export**: 延迟释放导出文件地址 (c243d06)
- **export**: 允许浏览器重试下载 (dfecf4f)
- **标签栏**: 完善标签列表收起与焦点行为 (e43ea81)

### 📝 文档

- 规划笔记排序继承修复 (eac2edc)
- 设计笔记排序继承修复 (e8b0ec2)
- 添加全端关闭拼写检查实现计划 (38de780)
- 设计全端关闭文档拼写检查 (b7d844e)
- **export**: 添加浏览器下载重试计划 (dbe91ba)
- **export**: 设计浏览器下载重试修复 (27b87ba)
- **计划**: 记录顶部标签快速切换实现步骤 (6706849)
- **设计**: 记录顶部标签快速切换方案 (31e4154)

### ✅ 测试

- **notebooks**: cover sidebar sort inheritance (96249db)

### 🔧 其他

- **git**: 忽略本地工作树 (15c73f0)

### v1.3.6 - 2026-07-14

### 🐛 修复

- 完成版本冲突处理闭环并停止重复弹窗 (#274) (b10c2cb)
- 简化全局同步状态，隐藏普通用户队列概念 (#275) (c222bfb)
- 修复安卓主题切换抖动与图片旋转缩放 (#270) (7510060)

### v1.3.5 - 2026-07-13

### ✨ 新增

- 用户偏好跟随账号同步 (#209) (1cc78c6)
- **移动端**: 优化图片操作菜单（任务 2/3） (bd6b701)

### 🐛 修复

- **Android**: 修复笔记列表轻触无响应 (f0ad5ce)
- **search**: rebuild stale FTS index on upgrade (#212) (1d1ab84)
- **search**: require explainable matches and cover metadata (#212) (a0bb18a)
- **search**: normalize literal query terms (#212) (8e32aeb)
- **移动端**: 提供 Markdown 预览入口 (b1da1f0)
- **Markdown**: 渲染行内与块级公式 (e70c612)
- **移动端**: 消除图片菜单切换闪烁 (04b3629)
- **移动端**: 兼容通用编辑器选区类型（任务 3/3） (ed0a91c)
- **移动端**: 保持图片操作菜单可见（任务 1/3） (3749ece)

### 📝 文档

- **移动端**: 记录图片菜单实现计划 (c633e03)
- **移动端**: 记录图片操作菜单设计 (c51c5fe)

### 💄 样式

- **移动端**: 缩小图片操作面板 (6f77dc6)

### ✅ 测试

- **search**: cover query normalization (#212) (b6168da)
- **search**: cover reliable full-text retrieval (#212) (ee6ddde)

<!-- CHANGELOG:END -->
