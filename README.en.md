# nowen-note

> A self-hosted private knowledge base, inspired by Synology Note Station.
>
> 自托管的私有知识库。[中文 README](./README.md)

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/Node-20%2B-green.svg)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED.svg?logo=docker&logoColor=white)](./Dockerfile)

## Features

- **Dual editor engines**: Tiptap 3 (rich text) + CodeMirror 6 (Markdown), sharing AI, version history, comments and other capabilities
- **AI assistant**: Works with Qwen / OpenAI / Gemini / DeepSeek / Doubao / Ollama — writing assist, title generation, tag suggestion, RAG Q&A
- **Knowledge management**: Unlimited-depth notebooks, color tags, tasks, mind maps, moments, FTS5 full-text search
- **Collaboration & history**: Shared links (password / expiry / permission / comments), version rollback
- **Automation**: Sandboxed plugin system, Webhooks, audit log, scheduled auto-backup
- **Cross-platform**: Web / Electron (Win/macOS/Linux) / Android (Capacitor)
- **Developer ecosystem**: MCP Server, TypeScript SDK, CLI, [browser clipper extension](https://chromewebstore.google.com/detail/nowen-note-web-clipper/nglkodhfdbnfielchjpkjhenfaecafpg), OpenAPI 3.0 — see [`packages/`](./packages)

## Stack

React 18 · TypeScript · Vite 5 · Tiptap 3 · Tailwind · Hono 4 · SQLite(FTS5) · JWT · Electron 33 · Capacitor 8

## Screenshots

### Desktop

| AI writing assistant | AI provider settings |
| :---: | :---: |
| ![Desktop AI writing](./docs/screenshots/desktop-ai-writing.png) | ![AI settings](./docs/screenshots/settings-ai.png) |

### Mobile (Android / Capacitor)

| Sidebar | Note list | Editor |
| :---: | :---: | :---: |
| ![Mobile sidebar](./docs/screenshots/mobile-sidebar.png) | ![Mobile list](./docs/screenshots/mobile-list.png) | ![Mobile editor](./docs/screenshots/mobile-editor.png) |

## Quick Start

> Default admin: `admin` / `admin123`. Please change the password immediately after first login.

### Docker (recommended)

```bash
git clone https://github.com/cropflre/nowen-note.git
cd nowen-note
docker-compose up -d
```

Open `http://<your-ip>:3001`.

### Local development

Requires Node.js 20+.

```bash
git clone https://github.com/cropflre/nowen-note.git
cd nowen-note
npm run install:all
npm run dev:backend   # backend on :3001
npm run dev:frontend  # frontend on :5173
```

Open `http://localhost:5173`.

### Desktop / Mobile

```bash
npm run electron:dev      # Electron dev
npm run electron:build    # Package for Windows / macOS / Linux
```

For Android, download the APK directly from [Releases](https://github.com/cropflre/nowen-note/releases), or build it yourself with `npx cap sync android && npx cap open android`.

### fnOS (one-click .fpk install)

Grab the latest `nowen-note-x.y.z.fpk` from [Releases](https://github.com/cropflre/nowen-note/releases). On your fnOS NAS, open **App Center → Settings → Install app manually** and pick the file. After installation, click the "Nowen Note" icon on the desktop or open `http://<nas-ip>:3001` in your browser.

> The .fpk currently targets x86_64 fnOS only (`platform=x86`). To build it yourself, see [scripts/fpk/README.md](./scripts/fpk/README.md).

## Configuration

| Env var | Default | Description |
| --- | --- | --- |
| `PORT` | `3001` | Service port |
| `DB_PATH` | `/app/data/nowen-note.db` | Database file path |
| `OLLAMA_URL` | — | Local Ollama endpoint (optional) |

Data persistence: mount **`/app/data`** from the container to the host (not `/data`). The image declares `VOLUME ["/app/data"]`, so mainstream NAS panels will prefill this path.

Backup policy: auto-backups are written to `/app/data/backups` by default, sharing the same volume as the data. Following the 3-2-1 rule, it is strongly recommended to mount `/app/backups` to a separate disk and set `BACKUP_DIR=/app/backups` — see the inline notes in [`docker-compose.yml`](./docker-compose.yml).

## Documentation

- Browser clipper extension (Chrome / Edge): [Chrome Web Store](https://chromewebstore.google.com/detail/nowen-note-web-clipper/nglkodhfdbnfielchjpkjhenfaecafpg)
- Deployment guide (Local / Docker / Desktop / Mobile / Synology / UGREEN / QNAP / fnOS / ZSpace / ARM64): [docs/deployment.md](./docs/deployment.md)
- fnOS .fpk packaging: [scripts/fpk/README.md](./scripts/fpk/README.md)
- ARM64 details: [docs/deploy-arm64.md](./docs/deploy-arm64.md)
- Email backup configuration: [docs/backup-email-smtp.md](./docs/backup-email-smtp.md)
- Editor mode switch: [docs/editor-mode-switch.md](./docs/editor-mode-switch.md)
- Privacy policy: [docs/PRIVACY.md](./docs/PRIVACY.md)
- OpenAPI: once running, visit `/api/openapi.json`

## Support

QQ group: `1093473044`

## Sponsor

If this project helps you, feel free to scan the QR code and buy the author a coffee.

<p align="center">
  <img src="./weixin.jpg" alt="WeChat sponsor QR" width="280" />
</p>

## License

[GPL-3.0](./LICENSE) — derivative works must also be distributed under GPL-3.0 and preserve the original copyright notice.

<!-- CHANGELOG:BEGIN -->
## 更新日志

> 最近 5 个版本的更新内容，完整历史见 [CHANGELOG.md](./CHANGELOG.md)。

### v1.1.4 - 2026-05-20

_本版本无可展示的 commit 变更（可能全部是合并 / 工作流修改）_

### v1.1.3 - 2026-05-20

### ✨ 新增

- **trash**: 笔记本删除改为软删，回收站恢复自动还原祖先笔记本链 (aeba393)

### v1.1.2 - 2026-05-19

### ✨ 新增

- **editor**: 弱网防丢字 + 字号颜色 + Mermaid 放大预览 + 列表切换优化 (0ce7da6)

### 🐛 修复

- **import**: /export/import 返回 version=1，避免有道云附件回填触发 VERSION_REQUIRED (331bea7)
- bug (a701dd2)
- **release**: 体检加 lockfile 时间戳兜底，新增依赖自动 npm install (9cd7847)
- **release**: 白名单补 @tiptap/extension-text-style 防 TS2307 (a17aacb)
- 放大图片 (935a5e4)

### v1.1.1 - 2026-05-18

### ✨ 新增

- **mobile**: 移动端编辑器体验大改造 + 修复输入回退/Failed to fetch/点笔记没反应 (10b3e59)
- **backup**: P0~P1 backup/export/import improvements (0764826)

### 🐛 修复

- **ai**: scope knowledge-base notebook by workspace on import (9fd5138)

### v1.1.0 - 2026-05-15

### ✨ 新增

- enhance FileManager, SharedNoteView, clipboard & image host formats (ae28579)

### 🐛 修复

- **backend**: Buffer→Uint8Array<ArrayBuffer> 拷贝包装，彻底兼容 TS 5.7 类型 (ac1cd51)
- **backend**: 改用 Hono c.body() 替代 new Response()，彻底绕开 BodyInit 类型摩擦 (25ace00)
- **backend**: TS 5.7+ 下用 Blob 包装 Response body 修 BodyInit 不兼容 (51ca0c2)
- **backend**: 修复 attachments 缩略图 Response 在新版 TS 下的 BodyInit 类型错 (d5daecb)
- **mobile**: 优化移动端导航与任务中心布局 (592b18e)
- **share**: 路由正则支持 base64url 字符集；评论/分享/文件管理等多项改动 (6760199)
- **share**: 分享页图片在 IP+自定义端口部署上 https 误判导致全部 ERR (6139c1a)
- **release**: 发布时同步 bump backend/package.json 的 version (d73b747)

### 📝 文档

- 更新 README 用桌面端/移动端/AI 设置展示截图 (9865c92)


## Unreleased

### ✨ 新增

- **share**: 笔记分享支持未登录访客评论 + 新增「可编辑（需登录）」权限档
  - 权限选项扩到 4 档：`仅查看 / 可评论 / 可编辑 / 可编辑（需登录）`
    - `可评论`：未登录访客填昵称即可留言；评论对所有访客可见（留言板模式）
    - `可编辑`：原匿名编辑能力（沿用，访客填昵称即可）
    - `可编辑（需登录）`（新档 `edit_auth`）：必须登录账号才能写入；未登录用户点击「开始编辑」会被引导跳到 `/login?redirect=/share/<token>`，登录成功后自动回到分享页
  - 评论数据修正：v12 之前匿名评论的 `userId` 被强行写成笔记主 id（绕过 `NOT NULL` 约束），现 schema 迁移 `v13` 把 `share_comments.userId` 改 nullable + 新增 `guestName / guestIpHash` 列，访客昵称真正持久化、审计字段不再失真
  - 反垃圾基础措施：评论长度 ≤1000、同 IP 每分钟 ≤30 条、honeypot 字段
  - 用户注销改为 `ON DELETE SET NULL`：留言历史不再随账号销毁而蒸发，前端用 `displayName` 兜底展示
  - 安全：登录回跳的 `?redirect=` 仅接受相对路径，杜绝开放重定向



### ✨ 新增

- **files**: 文件管理新增「我的上传」分类
  - 顶层多了一个 `我的上传` tab，仅展示用户从文件管理页直接上传的文件（编辑器粘贴、Tiptap 内联抽取的不计入）
  - 二级子筛选三选一：`全部 / 已引用 / 未引用`，分别对应「上传过的全部 / 已经被某条笔记真正用上 / 还放在这里没插任何笔记」
  - 后端 `GET /api/files` 新增 `filter=myUploads` + `myUploadsRef=referenced|unreferenced`，复用 `attachment_references` 倒排表（`EXISTS / NOT EXISTS` 子查询），避免全表扫 `notes.content`
  - `GET /api/files/stats` 响应增 `myUploads: { total, referenced, unreferenced }` 用于 tab 徽标
  - 与 `孤儿(unreferenced)` 视图的区别：前者在用户**自己上传**的子集内细分；后者是全集合的"没人引用"（含编辑器粘贴又删除的，且有 24h 宽限期）

### 🐛 修复

- **files**: 「我的上传」分支字面量大小写错配，导致筛选完全失效
  - 现象：`?filter=myUploads` 走到后端后被 `.toLowerCase()` 转成 `myuploads`，再与字面量 `"myUploads"`（驼峰）比较 → 永远 false，整个 myUploads 分支变成 dead code，列表退化为返回 scope 全集，「我的上传」展示了 1300+ 张所有附件
  - 修复：把字面量也改成全小写 `"myuploads"`；同时给该分支加注释说明 filter 已 lowercased，避免再次踩坑
  - 教训：query 参数解析阶段统一 lowercased 后，下游所有 case 都必须用小写字面量；驼峰命名的 filter 名（如 `myUploads`）是高危区
  - 配套调试工具：
    - 后端 `GET /api/files` 增加可选调试日志——开启后每次列表请求会打印 `raw`（原始 query）/ `parsed`（解析后小写值）/ `whereSql` / `paramCount`，下次再遇到"前端传了 filter 但后端像没收到"的现象可一眼比对。生产默认关闭，零开销
    - 双源开关：环境变量 `DEBUG_FILES_QUERY=1`（运维侧旁路，需重启）；或 `system_settings.debug_files_query='true'`（运行时持久化，写库后 30s 内全节点生效）
    - 可视化入口：「设置 → 开发者」面板（仅管理员可见）新增 toggle，无需登服务器即可一键开关
    - 后端字段级闸门：`/api/settings` PUT 中 `debug_files_query` 仅 admin 可写，普通用户即使构造请求也会被 403
- **files**: 「我的上传」展示历史脏数据（含浏览器图标 / 误粘贴 / 测试上传等几十张非用户主动上传的图）
  - 根因：旧口径靠 `attachments.noteId == holderNoteId`（"未归档文件"占位笔记），但任何走过 `POST /api/files/upload` 的内容（含 FileManager 页全局 paste 监听器抓到的浏览器图）都会落进同一个 holder，导致"我的上传" tab 把历史粘贴 / 测试数据全部算上
  - 修复：DB 迁移 v12 给 `attachments` 加 `uploadSource TEXT`，仅 `POST /api/files/upload` 写入时标 `'file_manager'`；编辑器粘贴 / 内联抽取等其它路径保持 NULL；老附件**不回填**——历史脏数据自动从「我的上传」中清出
  - dedup 边界：当用户从文件管理主动上传一份内容已存在的文件时，会把命中的老行 `uploadSource` 升级为 `'file_manager'`（这是用户的主动行为，应当被识别）
  - 兼容：老附件仍在「全部 / 图片 / 文件 / 孤儿」等其它 tab 里可见，没有任何数据丢失；holder note（"未归档文件"）保留作为外键容器，不再用作筛选依据

### ⚡ 性能

- **files**: 文件管理图片密集场景全链路优化（图床卡顿专项）
  - 后端新增 `sharp` webp 缩略图服务（`backend/src/services/thumbnails.ts`），按需生成 240/480/960 三档宽度并落盘缓存到 `ATTACHMENTS_DIR/.thumbs/`，与原图共享 `Cache-Control: immutable, 1y`
  - `/api/attachments/:id` 新增 `?w=` 查询参数；`toFileOut` 给 raster 图片下发 `thumbnailUrl`
  - 前端 `GridCard` 用 `React.memo` + 父级派生 `isCopied`/`isDownloading`/`selected` 三个 boolean prop，消除 60+ 张卡的整体重渲
  - `<img>` 优先用 `thumbnailUrl`，加 `decoding="async"` + `fetchpriority="low"`；破图自动回退原图
  - `loadList` 加 30s TTL 模块级缓存，删除/上传/重命名/孤儿清理后清缓存
  - `downloadItem` 用 ref 同步 `downloadingId`，砍掉 useCallback 依赖，避免下载状态变化打穿 memo
  - 附件删除/孤儿清理时连带清缩略图缓存；孤儿扫描跳过 `.thumbs/` 隐藏目录
  - 预期：单页流量 ~200MB → ~2-4MB（100×），交互重渲 60 → 1-2（30×）

<!-- CHANGELOG:END -->
