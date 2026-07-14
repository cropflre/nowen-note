# nowen-note

> A self-hosted private knowledge base, inspired by Synology Note Station.
>
> 自托管的私有知识库。[中文 README](./README.md) · [Author's Note](./AUTHOR_STORY.en.md) · [Live Demo](https://note.nowen.cn/)

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/Node-20%2B-green.svg)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED.svg?logo=docker&logoColor=white)](./Dockerfile)

## Features

- **Dual editor engines**: Tiptap 3 (rich text) + CodeMirror 6 (Markdown), sharing AI, version history, comments and other capabilities
- **AI assistant**: Works with Qwen / OpenAI / Gemini / DeepSeek / Doubao / Ollama — writing assist, title generation, tag suggestion, RAG Q&A
- **Knowledge management**: Unlimited-depth notebooks, color tags, tasks, mind maps, moments, FTS5 full-text search
- **Collaboration & history**: Shared links with 4 permission tiers (view / comment / edit / edit-with-login), guest comments, password / expiry, version rollback
- **File manager**: Image thumbnails (sharp webp at 240/480/960, ~100x bandwidth saving on dense galleries), "My uploads" view (referenced / unreferenced), orphan cleanup
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

## Live Demo

Don't want to self-host yet? Try the official demo site maintained by the author:

- URL: <https://note.nowen.cn/>
- Username: `demo`
- Password: `demo123456`

> ⚠ The demo account is for read-only evaluation. Data may be reset periodically — please do not store anything sensitive or important. For real use, self-host it via the Quick Start below.

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
- Attachment object storage (S3 / R2 / MinIO): [docs/object-storage.md](./docs/object-storage.md)
- fnOS .fpk packaging: [scripts/fpk/README.md](./scripts/fpk/README.md)
- ARM64 details: [docs/deploy-arm64.md](./docs/deploy-arm64.md)
- Email backup configuration: [docs/backup-email-smtp.md](./docs/backup-email-smtp.md)
- Editor mode switch: [docs/editor-mode-switch.md](./docs/editor-mode-switch.md)
- Privacy policy: [docs/PRIVACY.md](./docs/PRIVACY.md)
- OpenAPI: once running, visit `/api/openapi.json`

> 📚 **Tutorial Center**: [docs/tutorials/](./docs/tutorials/) — complete tutorials from quick start to advanced features

- **Getting Started**: [5-Minute Quick Start](./docs/tutorials/quick-start.md) · [UI Overview](./docs/tutorials/ui-overview.md) · [Create Your First Note](./docs/tutorials/first-note.md)
- **Note Management**: [Document Tree / Notebooks](./docs/tree-tutorial.md) · [Tags & Favorites](./docs/tutorials/tags-favorites.md) · [Search](./docs/tutorials/search.md)
- **Editor**: [Rich Text Editor](./docs/tutorials/editor-rich-text.md) · [Markdown Editor](./docs/tutorials/editor-markdown.md) · [Slash Commands](./docs/tutorials/slash-commands.md)
- **AI Features**: [AI Configuration](./docs/tutorials/ai-setup.md) · [AI Title & Tag Generation](./docs/tutorials/ai-title-tags.md) · [AI Summary](./docs/tutorials/ai-summary.md)
- **Mind Maps**: [Getting Started](./docs/tutorials/mindmap-intro.md) · [Generate from Note](./docs/tutorials/mindmap-from-note.md) · [Export](./docs/tutorials/mindmap-export.md)
- **Deployment**: [Docker](./docs/tutorials/docker-deploy.md) · [NAS](./docs/tutorials/nas-deploy.md) · [Backup & Migration](./docs/tutorials/backup-migrate.md)

## FAQ

### macOS: first launch error / won't start / "ERR_DLOPEN_FAILED"

Because this app is not Apple-notarized, macOS applies a quarantine attribute to the `.app` downloaded from the DMG, which causes the native `better-sqlite3` module to fail loading. The backend then hangs for 30 seconds and reports a startup timeout.

Run this one-liner in Terminal to remove the quarantine (adjust the path to wherever you placed the app):

```bash
sudo xattr -dr com.apple.quarantine "/Applications/Nowen Note.app"
# or
sudo xattr -dr com.apple.quarantine ~/Downloads/Nowen\ Note.app
```

After that, double-click to open it again. Apple Silicon users who downloaded the x64 build will need Rosetta 2 (the system will prompt you to install it automatically).

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

### v1.3.4 - 2026-07-13

### 🐛 修复

- **桌面端**: 避免失效令牌登录循环 (e647d03)
- **附件**: 为上传与文件列表签发访问地址 (d51d603)
- **笔记**: 重命名时携带服务端版本 (69dbabe)

### v1.3.3 - 2026-07-13

### ✨ 新增

- **统计**: 重设计仪表盘概览 (14bd5ec)
- **sync**: expose failed queue diagnostics and retries (#208) (827bcd3)
- 思维导图折叠按钮显示子节点数量，移除 CSP 中的 frame-ancestors 限制 (6ed0f9c)
- **tasks**: 完善任务与习惯统计视图 (a77091a)
- **mobile**: install Android startup request coalescer (#237) (7804729)
- **mobile**: collapse Android cold-start reads (#237) (e795f05)
- **mobile**: mount compact startup snapshot (#237) (15f303f)
- **mobile**: add compact Android startup snapshot (#237) (c51286d)
- **导入**: 提升 H4-H6 标题级别保真 (4f98153)
- **export**: route image exports through reliable preview renderer (#221) (b717c6f)
- **export**: mount note image export center (#221) (2b11a07)
- **android**: add export file picker and native sharing (#221) (0289bc5)
- **android**: support gallery, files, share and open for exports (#221) (f231993)
- **export**: add cross-platform image export center (#221) (4bdb7b6)
- **export**: render faithful raster and SVG note exports (#221) (4eb4d15)
- **export**: add note image export request bridge (#221) (7e2e7a2)
- **desktop**: support multi-server profiles and safe NAS migration (#207) (3ebe73f)
- **siyuan**: 安全补齐导入保真并修复表格属性丢失 (#224) (6823598)
- **media**: enable attachment range responses (#214) (426ca86)
- **media**: mount mobile media experience bridge (#214) (c183e33)
- **media**: add mobile media picker and inline video UX (#214) (a4698a7)
- **media**: add mobile media selection helpers (#214) (f48e25e)
- **media**: report video upload lifecycle (#214) (5008cfb)
- **media**: report image upload lifecycle (#214) (bf828f7)
- **media**: expose per-file upload lifecycle (#214) (2314895)
- **media**: stream attachment video ranges (#214) (852f132)
- **media**: add strict single-range parser (#214) (9a76986)
- **android**: mount share import center (#220) (de83a1c)
- **android**: add system share import sheet (#220) (d5e43c5)
- **android**: build safe note content for shared items (#220) (a1f7498)
- **android**: expose native share import bridge (#220) (438f00a)
- **android**: register share and open-with targets (#220) (72e8dcb)
- **android**: route share intents into Nowen (#220) (0cab0a8)
- **android**: receive and stream shared files (#220) (a99f287)
- **android**: add share import validation helpers (#220) (08e38b6)
- **folder-sync**: add stop-tracking conflict control (#222) (bf80024)
- **folder-sync**: stop tracking edited notes on conflict (#222) (329e96b)
- **folder-sync**: expose detached conflict result (#222) (3546f3b)
- **folder-sync**: add stop-tracking conflict policy (#222) (3c04dd5)
- **folder-sync**: expose safety and conflict controls (#222) (f333ff9)
- **folder-sync**: process conflicts renames and source deletion (#222) (1648937)
- **folder-sync**: add conflict and deletion policies (#222) (c1d2b0f)
- **folder-sync**: harden incremental scanner and rename tracking (#222) (fb5f5dc)
- **folder-sync**: add conflict-aware transport (#222) (5a8547b)
- **folder-sync**: add advanced sync preferences (#222) (4c0c23d)
- **ai**: mount reliability UI shells (#218) (2a64b21)
- **ai**: add explicit manual configuration switch (#218) (33a7db5)
- **ai**: expose context modes and diagnostics in chat (#218) (d326db5)
- **ai**: add reliable ask client and diagnostics parser (#218) (0206e9e)
- **ai**: mount reliable context routes (#218) (ad20cf4)
- **ai**: add explainable reliable ask pipeline (#218) (621b0ed)
- **ai**: add explainable context preparation (#218) (216bf4f)
- **clipper**: persist image limits and reset account state (#217) (667c57f)
- **clipper**: expose lazy image limits and reset controls (#217) (aed4113)
- **clipper**: add quick note and target picker UI (#217) (a7646e2)
- **clipper**: redesign popup as unified capture entry (#217) (f50d15e)
- **clipper**: mount enhanced background entry (#217) (9aa1fce)
- **clipper**: implement unified quick note and clip pipeline (#217) (a8a282c)
- **clipper**: support workspace targets and note metadata (#217) (c2a9cab)
- **clipper**: define unified capture protocol (#217) (888bb2a)
- **clipper**: persist account-scoped capture preferences (#217) (933fe88)
- **clipper**: add bounded image localization pipeline (#217) (9a67963)
- **data**: mount full system transfer controls (ad0f6c3)
- **data**: replace database-only transfer with full system archive (ef4527f)
- **tasks**: enable image-aware transfer center (#206) (dd60910)
- **tasks**: expose full backup with task images (#206) (71969f1)
- **tasks**: add image-aware task backup archive (#206) (b8fb1f2)
- **tasks**: mount task data transfer center (#206) (08615b3)
- **tasks**: add responsive import export center (#206) (2b737ba)
- **tasks**: add task backup and import engine (#206) (e7a099c)
- **android**: mount mobile drawer UX bridge (7b56924)
- **auth**: mount persistent 2FA challenge center (#158) (3a3fe36)
- **auth**: add resilient 2FA challenge center (#158) (8d03e0a)
- **images**: 保留图片旋转/翻转状态并修复图片节点 inline 模式 (206344e)
- **updater**: mount desktop update center (#202) (8530330)
- **updater**: add global in-app update center (#202) (4be7f34)
- **updater**: add update presentation helpers (#202) (f6c76bb)
- **updater**: add consent-driven in-app update state machine (#202) (8e048b2)
- **images**: mount persistent editor transform bridge (#201) (86b712b)
- **images**: add compact editor transform controls (#201) (6579bf0)
- **images**: add persistent image transform attributes (#201) (00f30df)

### 🐛 修复

- **任务提醒**: 修复鉴权与路由匹配 (44640e0)
- **editor**: let IME composition commit through slash fallback (#213) (3884c83)
- **editor**: reset and scope slash command menu (#213) (53a8619)
- **editor**: make slash activation transaction-driven (#213) (de85615)
- **同步**: 改善冲突队列与删除后清理 (1535ba3)
- **tasks**: 加固任务统计历史与兼容性 (#244) (ebbd1c6)
- **sync**: keep queue replay compatible with CORS allowlist (#208) (9f48bf0)
- **sync**: report pending queue and refresh authoritative snapshot (#208) (d4954e4)
- **sync**: preserve failed queue items and serialize flush (#208) (f339f9f)
- **sync**: add stable mutation ids to queue replay (#208) (76f34f5)
- 下载附件时使用附件访问桥，确保跨域场景也能正确下载 (e7cbbac)
- **mermaid**: 禁用 htmlLabels 使用原生 SVG text，避免 DOMPurify 清空节点文字 (4c6d499)
- **markdown**: include H4-H6 in editor outline (#236) (b54c09a)
- **ai**: 优化 AI 连接测试逻辑，允许模型未返回文本时也判定连接成功 (b850f8a)
- **export**: install reliable download bridge (#235) (3005f79)
- **export**: bridge all browser exports to HTTP downloads (#235) (6a2fb32)
- **export**: enforce bounded requests and one-time cleanup (#235) (45853cb)
- **export**: add bounded reliable export routes (#235) (9cba9c4)
- **export**: harden reliable export jobs (#235) (b2683fc)
- **mobile**: coalesce NAS startup reads in mobile web (#237) (886d4b8)
- **导出**: 让 PDF 和 Word 使用真实下载地址 (6ca71fa)
- **导出**: 覆盖单篇笔记附件流式下载 (18e37a0)
- **导出**: 使用后端流式任务避免压缩卡在99% (c975d58)
- **sharing**: authorize shared note attachments (#216) (45b91f0)
- **media**: recover legacy video MIME for playback (#214) (48ac1c1)
- **media**: infer missing video MIME from filenames (#214) (de7ee48)
- **media**: type file picker cancel events (#214) (36ee1e9)
- **media**: keep byte-range responses uncompressed (#214) (6ec3c53)
- **media**: treat prevented editor drops as handled (#214) (1310dbb)
- **android**: reject untrusted MIME header injection (#220) (f8c87f7)
- **android**: preserve legacy note formats during share import (#220) (d5ac04d)
- **android**: guard missing share import plugin (#220) (04500c2)
- **android**: accept open-with intents without MIME (#220) (e5f5832)
- **android**: harden shared executable detection (#220) (3ce0596)
- **android**: neutralize shared raw HTML in markdown (#220) (be78ac9)
- **folder-sync**: store desktop attachments under userData (#222) (966c237)
- **folder-sync**: detach entries removed from configured scope (#222) (55bd20d)
- **folder-sync**: protect notes when sync scope narrows (#222) (c2e3e8d)
- **folder-sync**: normalize root-compatible double-star rules (#222) (4bc8cf0)
- **folder-sync**: persist rename metadata despite unchanged hash (#222) (ec1174a)
- **auth**: invalidate cached identity before issuing sessions (#223) (14cb276)
- **ai**: harden scoped retrieval and full-note budgeting (#218) (e0e63a0)
- **clipper**: migrate username-scoped capture preferences (#217) (cd96777)
- **tasks**: use safe PNG for missing-image placeholders (#206) (9d989ad)
- **tasks**: keep fallback marker type-safe (#206) (6a668e3)
- **tasks**: install missing-image backup fallback (#206) (95946e0)
- **tasks**: tolerate missing images during backup export (#206) (8ad94ad)
- **tasks**: refine task transfer UX and observer cost (#206) (a277746)
- **tasks**: harden task backup integrity and imports (#206) (f692bb3)
- **android**: improve drawer search and safe top controls (6b8e342)
- **notebooks**: narrow nested sort resolver type (#190) (496285c)
- **notebooks**: apply inherited sort to nested notes (#190) (d7ab88c)
- **notebooks**: inherit root sort through nested tree (#190) (e81eee3)
- **auth**: cap pending 2FA challenges at five minutes (#158) (d1a541c)
- **auth**: preserve safe redirect after 2FA login (#158) (61adc42)
- **auth**: avoid extra CORS headers in 2FA verification (#158) (ac65c07)
- **auth**: harden 2FA challenge storage access (#158) (bc5aa5e)
- **auth**: let pending 2FA bypass quick login (#158) (ea43acd)
- **auth**: persist pending 2FA login challenges (#158) (5b107ed)
- **search**: keep Android sidebar focus during search transition (#203) (8450bca)
- **search**: hydrate remounted sidebar from bridge state (#203) (dfa2cc8)
- **search**: restore query after sidebar remount (#203) (c9c98fe)
- **search**: unify mobile sidebar and full search state (#203) (379f33c)
- **search**: decouple sidebar input from synthetic events (#203) (691fe1c)
- **search**: add mobile sidebar search state bridge (#203) (2aec04f)
- **search**: keep IME fallback compatible with older webviews (#203) (639ba47)
- **search**: commit IME text without synthetic input loss (#203) (5a7a9e5)
- **search**: preserve IME composition in sidebar search (#203) (3c5fa6c)
- **import**: route siyuan zip by suffix (480bc77)
- **images**: keep drag resize aligned after rotation (#201) (298d37c)
- **images**: preserve transforms in markdown exports (#201) (1ecf1b3)
- **images**: keep legacy replacement payloads stable (#201) (f68f74e)
- **images**: avoid symbol-key type errors in transform bootstrap (#201) (7619a8a)
- **images**: preserve transforms when replacing images (#201) (fdd7703)

### ♻️ 重构

- **export**: fold hardening into compatibility service (#235) (4ecc794)
- **media**: reuse pure video MIME helper (#214) (9673d8b)
- **media**: isolate video MIME inference (#214) (8df5142)
- **ai**: preserve user preference routes for reliability wrapper (#218) (4807345)

### 📝 文档

- **统计**: 明确仪表盘重设计方案 (9e4898f)
- 设计同步冲突处理流程 (ba1d63e)
- **export**: document reliable note image export (#221) (8559a6b)
- **media**: document mobile image and video workflow (#214) (ab8f6f0)
- **android**: clarify pending share retention budget (#220) (c7bc35b)
- **android**: document system share import (#220) (a3c277f)
- **folder-sync**: document conflict detach behavior (#222) (efaa4a7)
- **folder-sync**: document safe one-way sync v2 (#222) (c62f8e1)
- **clipper**: document unified capture workflow (#217) (737f9c9)
- add image editor regression screenshot (46acaf4)

### 💄 样式

- **clipper**: polish unified capture popup (#217) (9edbdf2)

### ✅ 测试

- **editor**: 兼容新版文本输入回调 (dda9472)
- **editor**: cover repeated slash command activation (#213) (8f359dd)
- **sync**: cover queue races, preservation and idempotency (#208) (eecec45)
- **export**: cover reliable download compatibility bridge (#235) (fe3d24a)
- **export**: cover quotas and one-time downloads (#235) (5dde2cf)
- **export**: preserve legacy helper coverage (#235) (50fb353)
- **mobile**: cover compact startup filtering and sorting (#237) (affcccd)
- **export**: cover safe long-image and pagination planning (#221) (36c6188)
- **sharing**: stabilize shared attachment validation (#216) (847e56f)
- **media**: cover lazy repair of legacy video MIME (#214) (af07a2d)
- **media**: verify empty mobile video MIME normalization (#214) (d90863a)
- **media**: isolate video MIME helper coverage (#214) (9436220)
- **media**: cover mobile video MIME inference (#214) (130f6fb)
- **media**: cover mobile media preparation helpers (#214) (c37119b)
- **media**: cover strict HTTP range parsing (#214) (329fee3)
- **media**: cover attachment video byte ranges (#214) (c23d12d)
- **android**: cover malicious shared MIME metadata (#220) (84d7d56)
- **android**: cover legacy note formats and unsafe share text (#220) (96f53d8)
- **android**: cover disguised executable shares (#220) (9bb7d8d)
- **android**: align share filename normalization (#220) (b591e90)
- **android**: cover shared note content fidelity (#220) (947dcd3)
- **android**: cover shared file validation (#220) (0dfa305)
- **folder-sync**: cover Electron attachment storage path (#222) (aafe59a)
- **folder-sync**: cover exclusion scope matching (#222) (6c72f42)
- **folder-sync**: cover advanced preference normalization (#222) (e5b53a6)
- **folder-sync**: cover stop-tracking conflict flow (#222) (b0d2f0a)
- **folder-sync**: cover hash-stable source rename (#222) (59e9a39)
- **folder-sync**: preserve sync marker in manual edit fixture (#222) (31c4383)
- **folder-sync**: cover conflict and source deletion policies (#222) (c96edd0)
- **folder-sync**: cover safety rename and advanced preferences (#222) (f681515)
- **auth**: cover fresh session cache invalidation (#223) (e36c08e)
- **ai**: cover disabled configuration guard and restore (#218) (6a85b97)
- **ai**: cover full note conversion and visible truncation (#218) (e0324be)
- **notes**: cover attachment cleanup on permanent deletion (0eabf88)
- **tasks**: assert PNG placeholder bytes (#206) (1d1a711)
- **tasks**: stabilize missing-image fallback assertions (#206) (14352e2)
- **tasks**: cover missing-image export fallback (#206) (11b4519)
- **tasks**: cover image backup archive parsing (#206) (775212a)
- **tasks**: cover backup integrity and import rollback (#206) (19119c9)
- **tasks**: cover cyclic hierarchy and note-link warnings (#206) (56d5fdf)
- **tasks**: cover task backup CSV and validation (#206) (43b897e)
- **android**: cover drawer search completion and safe controls (e1fb200)
- **notebooks**: cover nested sort inheritance (#190) (82a00b2)
- **auth**: enforce five-minute 2FA challenge cap (#158) (e3a08e9)
- **auth**: cover persistent 2FA login challenges (#158) (346ee2b)
- **search**: cover sidebar remount state (#203) (260b269)
- **search**: cover mobile sidebar bridge routing (#203) (e818ce9)
- **search**: cover sidebar IME event routing (#203) (177de30)
- **updater**: cover update state presentation (#202) (c28a31f)
- **images**: cover transformed markdown exports (#201) (3b1ac4b)
- **images**: preserve transforms during replacement (#201) (24c86b3)
- **images**: cover persistent editor transforms (#201) (948c95b)

### 🤖 CI

- add one-shot PR 236 fix trigger (f4bcdd8)

### 🔧 其他

- **ci**: bootstrap issue 221 export integration (43ae00f)
- **media**: rely on DOM cancel event typing (#214) (41485f6)
- 更新浏览器剪藏插件0.2.0发布包 (2df0ab3)
- **clipper**: publish manifest 0.2.0 (#217) (51b564d)
- **clipper**: bump unified capture release to 0.2.0 (#217) (c1ccf3f)
- remove unused issue 201 verification workflow (1c7a092)
- remove unused issue 201 patch script (9b2a97d)
- apply and verify image transform implementation (#201) (9958f76)
- stage image transform implementation (#201) (01a4645)

### 📌 杂项

- 统一桌面开发与网页端本地数据源 (2652eb5)
- 修复桌面端本地登录后导航被拦截 (ce0384e)
- 修复本地迁移登录会话失效 (a239c5c)
- 修复桌面端原生模块 ABI 不匹配 (343270c)
- 修复客户端登录后个人笔记未加载 (4ab392f)
- 调整服务端入口至左侧导航栏 (9d2b5e3)
- 修复桌面端导航栏与窗口按钮重叠 (d10c3f6)
- 修复桌面端左上角展示和原生模块兼容 (1c28cfd)
- Add siyuan directory (bc3ada5)
- testability(media): export video MIME inference (#214) (4d15d0f)

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

<!-- CHANGELOG:END -->
