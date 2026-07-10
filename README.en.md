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
