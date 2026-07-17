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
