<div align="center">
  <img src="./electron/icon.png" alt="Nowen Note" width="104" />
  <h1>Nowen Note</h1>
  <p><strong>An open-source, self-hosted knowledge base and task workspace for individuals and small teams</strong></p>
  <p>
    Rich text and Markdown · Real-time collaboration · AI knowledge Q&A · Tasks and mind maps · Cross-platform clients
  </p>
  <p>
    <a href="./README.md">简体中文</a> ·
    <a href="http://nowen.cn/">Official Website</a> ·
    <a href="http://note.nowen.cn/">Live Demo</a> ·
    <a href="https://github.com/cropflre/nowen-note/releases">Downloads</a> ·
    <a href="./docs/tutorials/README.md">Tutorials</a> ·
    <a href="./CHANGELOG.md">Changelog</a>
  </p>
</div>

<div align="center">

[![GitHub Release](https://img.shields.io/github/v/release/cropflre/nowen-note?display_name=tag&sort=semver)](https://github.com/cropflre/nowen-note/releases)
[![Docker Pulls](https://img.shields.io/docker/pulls/cropflre/nowen-note?logo=docker&logoColor=white)](https://hub.docker.com/r/cropflre/nowen-note)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](./LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Compose%20v2-2496ED?logo=docker&logoColor=white)](./docker-compose.yml)

</div>

> Nowen Note is more than an editor. It is designed as private knowledge infrastructure that you control, can run long-term on a server or NAS, and can access from desktop and mobile clients.

## Highlights

| Area | Current capabilities |
| --- | --- |
| **Notes and editors** | Tiptap 3 rich text, CodeMirror 6 Markdown, live preview and split view, tables, code blocks, KaTeX, Mermaid, images, attachments, comments, and version history |
| **Knowledge organization** | Unlimited notebook hierarchy, colored tags, favorites, trash, full-text search, backlinks, block references, and a knowledge graph |
| **Task management** | Tree tasks, list, Kanban, calendar, Gantt/timeline, dependencies, recurring rules, reminders, templates, and AI task breakdown |
| **AI** | OpenAI-compatible APIs, Qwen, Gemini, DeepSeek, Doubao, and Ollama; writing tools, title/tag generation, summaries, embeddings, and RAG Q&A |
| **Collaboration and publishing** | Yjs + WebSocket real-time sync, workspaces, member roles, password/expiry-protected sharing, guest comments, and public knowledge spaces |
| **Import and export** | Migration paths for Markdown, Word/DOCX, Obsidian Vault, WeChat Favorites, and more; exports to Markdown, PDF, Word, PNG, and JPG |
| **Files and storage** | Local attachments organized by `YYYY/MM`, thumbnails, reference checks, orphan cleanup, S3/R2/MinIO, |
| **Automation and developer tools** | Automatic and email backups, Webhooks, audit logs, plugins, OpenAPI, TypeScript SDK, CLI, MCP Server, and a browser clipper |
| **Platforms** | Web, Electron for Windows/macOS/Linux, Android, an iOS project, and a HarmonyOS project |

## Screenshots

### Desktop

| AI writing assistant | AI provider settings |
| :---: | :---: |
| ![Desktop AI writing](./docs/screenshots/desktop-ai-writing.png) | ![AI settings](./docs/screenshots/settings-ai.png) |

### Mobile

| Sidebar | Note list | Editor |
| :---: | :---: | :---: |
| ![Mobile sidebar](./docs/screenshots/mobile-sidebar.png) | ![Mobile list](./docs/screenshots/mobile-list.png) | ![Mobile editor](./docs/screenshots/mobile-editor.png) |

## Official website and live demo

- Official website: <http://nowen.cn/>
- Live demo: <http://note.nowen.cn/>
- Username: `demo`
- Password: `demo123456`

> The demo is for evaluation only and may be reset periodically. Do not store sensitive or important data there.

## Quick Start

### Docker Compose (recommended)

Docker Engine and Docker Compose v2 are required.

```bash
git clone https://github.com/cropflre/nowen-note.git
cd nowen-note
docker compose up -d
```

Open `http://<server-ip>:3001`.

Default administrator:

```text
Username: admin
Password: admin123
```

> Change the default password immediately. For an Internet-facing deployment, also configure HTTPS, backups, the correct public origin, and stricter CORS/legacy attachment settings where appropriate.

Status and logs:

```bash
docker compose ps
docker compose logs -f --tail=200 nowen-note
```

Manual image update:

```bash
docker compose pull
docker compose up -d
```

### Docker online updates (optional)

Online updates only work with the official [`docker-compose.yml`](./docker-compose.yml) and are disabled by default. The application container never mounts the Docker socket. A separate, internal-only updater container receives restricted Docker Engine access.

```bash
cp .env.example .env
printf '\nNOWEN_UPDATER_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env

# Replace vX.Y.Z with a stable version from Releases
NOWEN_IMAGE_TAG=vX.Y.Z docker compose --profile updater up -d
```

Administrators can then use **Settings → About → Version information** for preflight checks, a full backup, upgrade, and failed-upgrade rollback. Image rollback is not the same as database rollback when a migration is irreversible, so an independent production backup remains mandatory.

See [Docker online update and recovery](./docs/docker-online-update.md).

### Run only the main application

```bash
docker run -d \
  --name nowen-note \
  --restart unless-stopped \
  -p 3001:3001 \
  -e TZ=Asia/Shanghai \
  -v /opt/nowen-note/data:/app/data \
  cropflre/nowen-note:latest
```

## Data, backups, and configuration

### Persistent data

The persistent container path is **`/app/data`**, not `/data`. The default Compose file uses the `nowen-note-data` Docker volume.

```text
/app/data/
├── nowen-note.db
├── attachments/
├── backups/
├── fonts/
└── .jwt_secret
```

- SQLite is the default database; the main file is `/app/data/nowen-note.db`.
- Attachments are stored under `/app/data/attachments`, with new files organized by `YYYY/MM`.
- Automatic backups are stored under `/app/data/backups` by default.
- In production, mount `BACKUP_DIR` on a separate physical disk and follow the 3-2-1 backup rule.
- PostgreSQL adaptation and migration are still in progress. Current production and recovery workflows continue to use SQLite as the supported baseline.

### Common environment variables

See [`.env.example`](./.env.example) for the complete template.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NOWEN_PORT` | `3001` | Host port used by Compose |
| `TZ` | `Asia/Shanghai` | Container timezone and task date calculations |
| `PUBLIC_WEB_ORIGIN` | empty | Public reverse-proxy/domain origin used to build share links |
| `JWT_SECRET` | generated and persisted | Login and sudo-token signing; must be shared by multi-instance deployments |
| `BACKUP_DIR` | `/app/data/backups` | Automatic backup directory |
| `CORS_ORIGINS` | native client origins | Extra browser origins, comma-separated |
| `MAX_ATTACHMENT_SIZE_MB` | `100` | Maximum size of one attachment |
| `ATTACHMENT_STORAGE` | `local` | Set to `s3` for S3, R2, or MinIO |
| `CALENDAR_EXPORT_ENCRYPTION_KEY` | empty | Encrypts third-party image-host credentials |
| `NOWEN_UPDATER_TOKEN` | empty | Enables the Docker online updater |

See [object storage](./docs/object-storage.md).

## Client and platform status

| Platform | Distribution / build | Notes |
| --- | --- | --- |
| **Web / Docker** | Docker Hub or source build | Recommended deployment path; images can be built for `amd64`, `arm64`, or multiple architectures |
| **Windows / macOS / Linux** | [GitHub Releases](https://github.com/cropflre/nowen-note/releases) or `npm run electron:build` | Electron client can connect to a remote server or use its local backend |
| **Android** | Release APK or Capacitor build from `frontend/` | Actively maintained |
| **iOS** | Capacitor project and GitHub Actions/TestFlight workflow | Requires Apple signing and a developer account; see the [iOS release guide](./docs/iOS-Release.md) |
| **HarmonyOS** | Open [`nowen-harmony/`](./nowen-harmony/) in DevEco Studio | ArkTS + ArkWeb MVP; some native bridges are still being completed |
| **fnOS** | `.fpk` package in Releases | Current `.fpk` packaging mainly targets x86_64 |
| **UGREEN UGOS** | `.upk` from Releases/build scripts | Availability depends on device architecture and app installation support |
| **Other NAS platforms** | Docker Compose | Synology, QNAP, ZSpace, and other Docker-capable NAS devices |

> The actual package matrix for each version is defined by [GitHub Releases](https://github.com/cropflre/nowen-note/releases).

## Local development

Requires Node.js 20+, npm, and Git. Electron/native dependencies also require the appropriate platform build toolchain.

```bash
git clone https://github.com/cropflre/nowen-note.git
cd nowen-note
npm install
npm run install:all
```

Start two terminals:

```bash
npm run dev:backend
```

```bash
npm run dev:frontend
```

Open `http://localhost:5173`.

Common commands:

```bash
npm run build:all                 # Build frontend and backend
npm run electron:dev              # Electron development
npm run electron:build            # Package Electron clients
(cd backend && npm test)          # Backend tests
(cd frontend && npm run test:run) # Frontend tests
```

Android:

```bash
cd frontend
npm run cap:build
npx cap open android
```

iOS:

```bash
npm run cap:sync:ios
npm run cap:open:ios
```

## Architecture

| Layer | Main technologies |
| --- | --- |
| **Frontend** | React 18, TypeScript, Vite 5, Tailwind CSS, Tiptap 3, CodeMirror 6, Yjs, IndexedDB |
| **Backend** | Node.js 20, Hono 4, WebSocket, better-sqlite3, FTS5, sqlite-vec, sharp |
| **Desktop** | Electron 33, electron-builder, electron-updater |
| **Mobile** | Capacitor 8 for Android/iOS, ArkTS + ArkWeb for HarmonyOS |
| **Storage** | SQLite, local attachments, S3/R2/MinIO, third-party image hosts |
| **Developer surface** | OpenAPI 3.0, TypeScript SDK, CLI, MCP Server, Webhooks |

## Repository layout

```text
nowen-note/
├── frontend/       # React Web app and Capacitor clients
├── backend/        # Hono API, database, sync, and background jobs
├── electron/       # Electron main process and packaging
├── packages/       # SDK, CLI, MCP, and developer packages
├── nowen-harmony/  # HarmonyOS ArkTS / ArkWeb client
├── docs/           # Deployment, tutorials, and design documents
└── scripts/        # Build, migration, packaging, and release scripts
```

## Documentation

- [Tutorial center](./docs/tutorials/README.md)
- [Online feature help center](http://nowen.cn/docs/nowen-note-features)
- [Online installation and troubleshooting](http://nowen.cn/docs/nowen-note-help)
- [Online API documentation](http://nowen.cn/docs/nowen-note-api)
- [Complete deployment guide](./docs/deployment.md)
- [Docker online update and recovery](./docs/docker-online-update.md)
- [Attachment object storage](./docs/object-storage.md)
- [Email backup configuration](./docs/backup-email-smtp.md)
- [ARM64 deployment](./docs/deploy-arm64.md)
- [iOS release guide](./docs/iOS-Release.md)
- [Privacy policy](./docs/PRIVACY.md)
- [Browser clipper](https://chromewebstore.google.com/detail/nowen-note-web-clipper/nglkodhfdbnfielchjpkjhenfaecafpg)
- OpenAPI: visit `/api/openapi.json` after starting the service

## Current boundaries

- **Database**: SQLite is the default, fully supported production path. PostgreSQL migration is still under development and validation.
- **Docker online updates**: available only for the official managed Compose deployment, not arbitrary containers, images, or NAS app packages.
- **macOS**: if a build is not Apple-notarized, the first launch may require removing quarantine with `xattr`; see the [desktop guide](./docs/tutorials/desktop.md).
- **Mobile**: Android currently has the most complete maintenance path. iOS and HarmonyOS distribution, signing, and some native bridges remain constrained by their platform toolchains.
- **Fast iteration**: features and package availability change quickly. Refer to Releases, in-app version information, and [CHANGELOG.md](./CHANGELOG.md).

## Contributing

Issues, feature proposals, and pull requests are welcome. Before submitting code, run at least:

```bash
npm run build:all
(cd backend && npm test)
(cd frontend && npm run test:run)
```

Support:

- [GitHub Issues](https://github.com/cropflre/nowen-note/issues)
- QQ group: `1093473044`

<details>
<summary><strong>Recent releases</strong></summary>

<!-- CHANGELOG:BEGIN -->
## 更新日志

> 最近 5 个版本的更新内容，完整历史见 [CHANGELOG.md](./CHANGELOG.md)。

### v1.4.2 - 2026-07-27

### ✨ 新增

- 支持多账号登录历史切换 (88976e3)
- **frontend**: improve knowledge tree scrollbar performance and settings UX (b8a0e69)
- **tree**: create documents inline without modal (9ebbe49)
- **tree**: add inline create draft helpers (63fd495)
- **layout**: enforce unified-tree-only desktop and mobile navigation (15ae19f)
- **layout**: migrate legacy notebook-list preferences at startup (113dc45)
- **layout**: define unified-tree-only navigation policy (35bb333)
- **mobile**: expose global note search in nav rail (26992bb)
- **mobile**: add note search launcher helper (1aba32f)
- **frontend**: add knowledge tree sort control (0bcad89)
- **frontend**: apply selected sort mode to knowledge tree listings (2311939)
- **frontend**: add unified knowledge tree sort model (8d0d7bb)
- **editor**: integrate safe one-shot format painter (251305e)
- **editor**: add safe format painter transaction helper (df86790)
- **android**: extend immersive editing to Markdown (68cd545)
- **android**: add immersive mobile editing mode (44e8d09)
- **knowledge-tree**: add capability-aware node context menu (d04f510)
- **knowledge-tree**: make the unified tree the only Sidebar hierarchy (#467) (2f96915)
- **knowledge-tree**: coordinate legacy Notes/Notebooks hierarchy writes (#465) (00c864b)
- **knowledge-tree**: show shared mixed content in the unified tree (#463) (c0540c7)
- **navigation**: make the unified knowledge tree the primary Sidebar hierarchy (#461) (ef307e8)
- **shortcuts**: integrate customization runtime and settings (066ec9e)
- **shortcuts**: resolve overrides and validate bindings (0c70d8c)
- **shortcuts**: mark configurable commands (e969c10)
- **settings**: add shortcut customization panel (5ff7dc1)
- **shortcuts**: execute customizable rich-text bindings (3f199bc)
- **shortcuts**: add platform-scoped override storage (a06157c)
- **shortcuts**: add unified registry and help center (#456) (9edf24d)
- **issue-370**: implement P0 permissions and P1 unified knowledge tree (0d65d43)
- **shares**: add centralized share management (#447) (fdabc64)
- **perf**: add issue 210 sign-off validator (4d7c70f)
- **perf**: install issue 210 sign-off runtime (92c0d06)
- **perf**: add issue 210 runtime sign-off collector (75fa180)
- **shares**: add centralized management page (#447) (a6a7df0)
- **shares**: add management presentation helpers (#447) (86385b4)
- **shares**: add management query service (#447) (940aed3)
- **issue-370**: harden and productize split editing (140e176)
- **issue-370**: productize layout commands (015cc32)
- **issue-370**: add workspace layout helpers (c2a04dd)
- **sidebar**: add shared notebook tree component (3938152)
- **editor**: route editors through initialization watchdog (1e4f4d7)
- **editor**: wrap Tiptap initialization (d4aa92a)
- **editor**: wrap Markdown initialization (5aaa46a)
- **editor**: watch editor readiness (e3ee89b)
- **editor**: add initialization timeout policy (3fd1e20)
- **images**: 历史笔记网络图片批量本地化 (#423) (c5828a3)
- **code-block**: expose MAXScript in language picker (dc70053)
- **editor**: register MAXScript before lowlight setup (6039400)
- 移除侧栏账号入口 (a6cc5ea)
- **markdown**: highlight MAXScript fences (e699921)
- **code-block**: share MAXScript lowlight setup (a403210)
- **code-block**: add MAXScript grammar (e18dd05)
- **import**: apply permission mappings in primary import flow (7c7e55c)
- **import**: mount permission transfer centers (1c29a67)
- 移除一次性数据迁移接口 (3eee71d)
- **import**: submit explicit permission mappings (28de8a4)
- **export**: add explicit permission export dialog (9b5d36d)
- 移除桌面端服务器资料凭据 (f3b3d91)
- **export**: add permission export bridge (27d54db)
- **import**: add permission mapping modal (c53cf6c)
- **import**: add permission mapping review queue (6896f7c)
- **import**: add permission account mapping panel (ce49ba3)
- 移除连接与迁移前端功能 (25fd9aa)
- **import**: expose permission-aware package endpoints (0406d76)
- **import**: integrate permission preview and apply (2c186a2)
- **export**: make permission manifest opt-in (a00128c)
- **import**: add guarded permission undo (b2cb360)
- **import**: add v2 permission transfer service (8be6ded)
- 将拆分文档移入更多菜单 (af4fddb)
- 增加窗口化性能签收标签 (8e57ad2)
- 增加跨章节安全回退与最新快照 (1de5278)
- 绑定子文档离线更新代际 (195fcac)
- 实现子文档代际冲突与结构重分段 (768bc7e)
- 增加子文档代际迁移 (a0a7859)
- 同步恢复导入后的 Block 权威状态 (16429cf)
- 增加 Block 权威跨库原子写入 (a63e235)
- 添加 Block 权威灰度主读 (dbfdbb7)
- 接入编辑器性能门禁与分段存储基础 (002ff0f)
- **editor**: 完成 Block 权威存储与 Subdocument 窗口化 (152706c)
- **editor**: validate inline image replacement snapshots (ea12df5)
- **blocks**: validate inline image replacement nodes (4c0c1b2)
- 增强块补丁与Tiptap编辑器性能分析能力 (782fa43)
- **ai**: discover and test embedding models (34fbc4c)
- **blocks**: persist scoped list item structure patches (27c8ebf)
- **editor**: enable list item structure planning (351e8af)
- **editor**: type scoped list item structure patches (1ac3e93)
- **editor**: plan controlled list item create and delete (6c9f4ce)
- **blocks**: apply scoped list item structure patches (6e157b1)
- **blocks**: plan list item structural indexes (81b4d6a)
- **ai**: bind embedding to a saved profile (8381a08)
- **blocks**: add controlled list item create and delete (e6d94a3)
- **editor**: type list subtree index responses (3825345)
- **blocks**: use incremental list subtree indexes (1e97c74)
- **blocks**: plan incremental list subtree indexes (0a80118)
- **tasks**: move completed tasks below pending tasks (c88fa23)
- **editor**: enable list hierarchy patch planning (fded464)
- **editor**: compose list hierarchy patch planning (51f54f3)
- **editor**: plan controlled list hierarchy moves (510fe54)
- **editor**: type controlled list item moves (bacf7ac)
- **blocks**: support controlled list hierarchy patches (eb1dede)
- **blocks**: add controlled list item moves (0517674)
- **mindmap**: add minimal borderless node style (d30eaad)
- **editor**: install empty Block identity dispatch (0516390)
- **editor**: reconcile empty Block IDs without history (c318aff)
- **editor**: patch empty Tiptap documents safely (d1a433c)
- **editor**: plan rich mixed structural patches (c61c1b8)
- **editor**: type mixed index update metadata (ac03a09)
- **blocks**: expose mixed index update kind (061428e)
- **editor**: type structural index update metadata (c94f926)
- **blocks**: expose structural index update kind (8153f72)
- **blocks**: expose patch index update mode (31ee6a4)
- **blocks**: plan incremental patch index updates (a98c34c)
- **attachments**: add safe legacy image-host migration (d9f43b8)
- **electron**: prevent data directory from being set to protected system paths (57c9e19)
- **import**: add permission mapping client API (bb41225)
- **import**: mount round-trip permission mapping routes (8badde8)
- **import**: add permission package and mapping endpoints (c68ee55)
- **import**: add guarded workspace permission mapping service (1375451)
- add persistent import reports and guarded undo (#380) (ee62e2c)
- **import**: add conflict-safe round-trip incremental sync (26271e7)
- **editor**: plan rich leaf block replacements (a96d370)
- **editor**: type rich block replacement operations (3933188)
- **editor**: validate rich block replacement snapshots (4027466)
- **blocks**: apply validated rich block replacements (e892153)
- **blocks**: validate rich block replacement nodes (7a21e8a)
- **editor**: grey-roll out Tiptap Block Patch saves (1a655e0)
- **editor**: define Block Patch grey rollout policy (41218fa)
- **blocks**: expose authoritative patch response (4f1d64a)
- **blocks**: return authoritative patch snapshot (f373323)
- **editor**: plan safe Tiptap block patches (39c9f80)
- **import**: safely merge round-trip packages into existing folders (55de099)
- **blocks**: add confirmed frontend patch client (3ffc91c)
- **import**: show round-trip preflight report (9ef0f15)
- **blocks**: add atomic batch patch route (8786188)
- **blocks**: add pure Tiptap batch patch engine (86763c4)
- **block-links**: resolve split redirects before navigation (49d935c)
- **block-links**: install split redirect resolver (5eb116e)
- **block-links**: expose split redirect resolver (a1b6c81)
- **block-links**: resolve blocks moved by note splitting (c9cca98)
- **import-export**: preserve tree and attachments round trip (c70d51b)
- **note-split**: support Tiptap previews and block-link confirmation (6e07707)
- **note-split**: expose rich-text block link warning (09561e7)
- **note-split**: expose Tiptap heading split entry (3bdc48b)
- **note-split**: preview Tiptap heading sections (b11fae0)
- **note-split**: register Tiptap split routes (ef5453d)
- **note-split**: add transactional Tiptap splitting (3c0b015)
- **note-split**: add Tiptap heading split planner (67d760b)
- **note-split**: choose chapters before splitting (1c21933)
- **note-split**: send selected section indexes (236c8ad)
- **note-split**: register selected-section routes first (4b86722)
- **note-split**: support selected chapter extraction (a714bbf)
- **note-split**: build partial split source safely (0b19c24)
- **note-split**: preserve attachment ownership across split and undo (8776a75)
- **note-split**: route editor through split runtime shell (6591282)
- **note-split**: expose split action in editor (f699013)
- **note-split**: add split preview and undo dialog (f831df4)
- **note-split**: add confirmed split api client (d9c3242)
- **note-split**: add client split preview planner (e6c6955)
- **note-split**: register note split routes (94d8e0b)
- **note-split**: add transactional split and undo routes (8d68f62)
- **note-split**: add markdown split planner (a127aa9)
- **markdown**: route large editor through incremental sync shell (6bca463)
- **markdown**: sync CodeMirror and Y.Text incrementally (9cf3c5f)
- **markdown**: track incremental collaboration runtime (3298669)
- **editor**: embed pasted bilibili video links (7a453ab)
- **markdown**: add incremental CodeMirror Y.Text mapping (18895c4)
- **markdown**: enable optimized editor from viewport tier (fb64b9b)
- **markdown**: route medium docs to viewport editor (37f9112)
- **markdown**: upgrade large docs to viewport editor (4a52fee)
- **markdown**: add stale-safe worker controller (e1e7869)
- **markdown**: run document analysis in worker (33ea398)
- **markdown**: add worker-safe document analysis (2a68c05)
- **editor**: route heavy nodes through runtime shells (5d5c5a5)
- **editor**: defer mermaid rendering by viewport (55f82f5)
- **editor**: lazy mount video and iframe node views (3fa9d60)
- **editor**: support interaction-gated heavy nodes (c1a2f35)
- **editor**: expose runtime mode notice and session restore (9c8f7a7)
- **editor**: add reusable heavy-node viewport hook (1f93df2)
- **editor**: explain emergency document protection reasons (f63f9f1)
- **editor**: route notes through progressive runtime policy (e536a29)
- **editor**: add runtime mode store and long-task escalation (b779eb2)
- **editor**: add progressive runtime mode policy (230ab27)
- **editor**: add unified document complexity profiler (20ba263)
- **search**: expose sidebar search pending state (ab7a705)
- **search**: add progressive query policy (b97e6fe)
- **editor**: add lightweight editor for huge Markdown notes (aa46b7b)
- **editor**: detect unsafe large Markdown documents (263cf0f)
- **settings**: load switch card styles (f3641e3)
- **settings**: redesign preference switches (167726f)
- **auth**: secure multi-server account profiles (#343) (7645fb4)
- **sync**: poll desktop collections for external writes (b57b488)
- **sync**: install workspace refresh bridge (01cb894)
- **sync**: add desktop workspace refresh bridge (6186955)
- **note-transfer**: expose rewritten link counts to clients (#325) (62651f5)
- **note-transfer**: support atomic local and object-storage transfers (#325) (c6504f2)
- **audit**: add note transfer category (#325) (cb34a36)
- **note-transfer**: mount cross-space transfer center (#325) (13042fc)
- **note-transfer**: add copy and move transfer center UI (#325) (559354a)
- **note-transfer**: add typed frontend transfer client (#325) (ca3261e)
- **note-transfer**: mount dedicated transfer router (#325) (8ef6616)
- **note-transfer**: expose preview and execute endpoints (#325) (60c1147)
- **note-transfer**: add safe cross-workspace note transfer service (#325) (71b6386)
- **settings**: mount Docker update center (#330) (8b97e1c)
- **settings**: add Docker online update experience (#330) (7cc9aeb)
- **updater**: add admin preflight backup and apply API (#330) (dd301ba)
- **settings**: mount administrator update control plane (#330) (5003fa5)
- **updater**: expose authenticated internal control plane (#330) (1213f28)
- **updater**: persist update jobs and rollback containers (#330) (54cb7ea)
- **updater**: add restricted Docker Engine adapter (#330) (b86233d)
- **docker**: split local build compose override (#330) (4f8c0e7)
- **docker**: package updater entrypoint and health metadata (#330) (b5cbb5e)
- **docker**: add managed updater deployment profile (#330) (43cdc4b)

### 🐛 修复

- **android**: improve share import multipart handling and safe-area layout (0bbb7cb)
- **release**: 支持 AppImage 内嵌 blockmap (9344371)
- **docker**: 修复多架构构建语法 (7bb77c5)
- md (6c27a83)
- **import**: preprocess browser-saved HTML documents (73a41e5)
- **import**: normalize SingleFile HTML before note conversion (cd08dce)
- **ai**: narrow embedding settings observer target (c976fa6)
- **ai**: keep index task copy bridge idempotent (89b7e7d)
- **tree**: install custom scrollbar bridge at startup (56630b8)
- **tree**: add runtime custom scrollbar for web and desktop (a80f487)
- **tree**: restore visible desktop scrollbar (b9cef05)
- **frontend**: restore sort button beside knowledge tree filter (a618125)
- **electron**: preserve markdown text encoding on open (a87d1cb)
- **electron**: decode Windows markdown encodings (5a73653)
- **editor**: preserve nested block structure in format painter (b6369bc)
- **issue-455**: add one-shot nested block safety workflow (f9618d6)
- **issue-455**: add nested block safety patch (7f9385d)
- **editor**: keep format painter hooks in component scope (8c2f665)
- **issue-455**: add one-shot hook scope repair (de3fb7a)
- **issue-455**: add hook scope correction (337e776)
- **editor**: keep format painter hooks unconditional (1311eb1)
- **issue-455**: add hook-order repair workflow (e69d914)
- **issue-455**: add hook-order correction (954455c)
- **android**: preserve editor focus in immersive toolbar (1c783f7)
- **knowledge-tree**: keep imported documents under selected tree parent (cc92910)
- **knowledge-tree**: remove duplicate child map declaration (df5cfac)
- **knowledge-tree**: repair context-menu panel JSX (9735f92)
- **knowledge-tree**: restore directory context-menu capabilities (a6c13ed)
- **knowledge-tree**: defer insert guard trigger and fix cross-scope parent mapping (4cbb244)
- **shortcuts**: remove stale tooltip hints after clearing bindings (a8b4eff)
- **shortcuts**: support generated heading commands (24489d3)
- **yjs**: avoid no-op version bump during flush (7792d1f)
- **knowledge-tree**: initialize schema once per database connection (1aa409e)
- **knowledge-tree**: activate tree subtree before restoring resources (e9f99d7)
- **postgres**: validate tree parents only on structural updates (7719ec5)
- **knowledge-tree**: retain structural guard after runtime ensure (0c2f56b)
- **knowledge-tree**: register v64 structural guard (9e0f6a2)
- **knowledge-tree**: validate parent scope only on structural changes (2881903)
- **postgres**: preserve document parents on legacy notebook updates (01b71dd)
- **knowledge-tree**: keep hardened sync triggers after runtime ensure (ce36ca8)
- **knowledge-tree**: register v63 legacy sync migration (04dd066)
- **knowledge-tree**: split legacy notebook parent and state triggers (7f4122a)
- **knowledge-tree**: restore deleted descendants with subtree recovery (8be01ed)
- **knowledge-tree**: restore complete deleted subtrees (4ea844c)
- **permissions**: preserve workspace role for newly created nodes (f2f8efc)
- **permissions**: keep workspace creators on inherited team roles (837f39d)
- **knowledge-tree**: route listing through qualified SQL implementation (ddde99f)
- **knowledge-tree**: use unambiguous mixed-tree title ordering (4f8219c)
- **knowledge-tree**: avoid migration bootstrap schema cycle (3712f52)
- **knowledge-tree**: ensure optional resource tables before tree queries (c999f0d)
- 完善笔记删除与附件清理逻辑 (1fdad04)
- 完善编辑器分屏镜像与多编辑器集成 (29bdc37)
- 优化编辑器分屏镜像同步逻辑 (7296fb1)
- 清理前端初始化与设置相关逻辑 (8a1795a)
- **collaboration**: render complete shared notebook tree (43750b4)
- **api**: harden note content view boundary (#355) (c59f04c)
- **api/editor**: hide Markdown block IDs and route by content format (#355) (0d397a1)
- **tags**: make tag creation idempotent by scope (8a3cebd)
- **tags**: register scoped tag uniqueness migration (9d6637a)
- **tags**: migrate tag names to scoped uniqueness (1785f78)
- **tags**: add idempotent scoped tag creation (8e06def)
- **sdk**: let server derive attachment note search text (478a26f)
- **sdk**: deduplicate concurrent attachment logins (6c8a316)
- **sdk**: copy typed arrays before creating blobs (d9d196a)
- **sdk**: include web platform types for public client (5d350da)
- **ci**: install SDK without missing lockfile cache (ac15412)
- **sdk**: expose note content format types (de815dc)
- **editor**: 修复大纲生成与跳转 (f36bbbf)
- **editor**: exclude explicit-only grammars from auto mode (2d07fca)
- **code-block**: preserve automatic detection subset (f54337e)
- **editor**: 移除轻量编辑模式提示 (7fd14c2)
- **editor**: 移除视口优化提示 (93640a2)
- **import**: preserve forbidden status in undo error (2e37e2a)
- **import**: recheck admin role before permission undo (0c1e4d6)
- **export**: honor data manager workspace scope (6697434)
- **import**: show invalid permission manifests in preflight (ab13f80)
- 清理遗留服务器资料数据 (734f5ad)
- **import**: harden legacy permission mapping (58bb44d)
- 修复超长笔记滚动区域 (51e6e06)
- 修复窗口化笔记滚轮失效 (dce9211)
- 收口 M6 M7 权威存储与窗口化一致性 (5811aa3)
- 重分段后立即回退单体编辑器 (435c34b)
- **clipper**: recover missing content script receivers (a344e48)
- **blocks**: enforce list item container compatibility (c13a742)
- **editor**: prove list structure Block identities (b13ad3f)
- **editor**: fall back after rejected list structure patches (ad9c660)
- **blocks**: reuse structural index plan type (53c484f)
- **editor**: plan list moves with large subtrees (76f211f)
- **editor**: preserve list attrs and choose equivalent moves (1c7a5df)
- **blocks**: preserve list attrs when sinking items (2accf67)
- **editor**: fall back after rejected list moves (21cf1b1)
- **ai**: keep vector status messaging consistent (e918dc9)
- **blocks**: track temporary structural Block identities (a1af567)
- **ai**: clarify vector indexing states (5272ff2)
- **ai**: install embedding queue hardening (ede3455)
- **ai**: harden embedding queue recovery (8a84ffb)
- **blocks**: narrow incremental leaf operations (4faf2c6)
- **blocks**: report actual indexed Block rows (baa958a)
- **blocks**: expose ancestor index updates (d762bff)
- **blocks**: refresh indexed ancestors for leaf patches (cec9019)
- **editor**: narrow rich replacement operation types (dbabd0b)
- **editor**: fall back on rejected rich block nodes (22a1578)
- **blocks**: preserve note history during patch saves (c4bfc0b)
- **editor**: scope Tiptap runtime policy to its note (4cf9295)
- **editor**: keep empty Tiptap docs on whole-save path (19a5a34)
- **editor**: isolate Block Patch AppContext usage (b47d29e)
- **editor**: serialize title saves behind Block Patch (234d98d)
- **blocks**: type list update broadcast payload (ccc21c8)
- **editor**: isolate stale Block Patch completions (dc3b624)
- **blocks**: reject cross-note idempotency key reuse (819c95b)
- harden attachment router bootstrap (b319734)
- **blocks**: preserve valid Tiptap containers after deletes (7701035)
- **blocks**: normalize source before atomic patch (6f4a7c6)
- **editor**: align runtime search plugin key typing (41d1639)
- **block-links**: enforce ACL across redirect chains (0f3a2fb)
- **block-links**: make redirect resolver route-order independent (0e39363)
- **block-links**: preserve moved block ids across redirect chains (b29eae2)
- **note-split**: keep Tiptap out of Markdown Yjs rooms (d981c87)
- **note-split**: refresh split availability after mutation (39a27a6)
- **note-split**: keep empty Tiptap chapters valid (c16a70a)
- **note-split**: keep Tiptap directory schema clean (d2408c7)
- **note-split**: strip persisted block ids from titles (ca0e85f)
- **note-split**: hide runtime block ids from titles (3fbc1d5)
- **note-split**: generate valid internal note links (56aaf95)
- **docker**: load hardened backend entrypoint for full backups (#352) (2690bb1)
- **desktop**: 修复视频全屏与打包校验 (1ac40e3)
- **editor**: avoid syncing note format as user preference (6aa2952)
- **note-split**: rollback on transactional version races (64691f4)
- **desktop**: respect markdown format when opening notes (f89cfbc)
- **desktop**: open markdown notes in markdown editor (2349ab7)
- **markdown**: skip conversion for emergency rich text (2b0ac4a)
- **markdown**: classify normalized content for large mode (4319446)
- **markdown**: keep analysis worker compatible with old webviews (ed45702)
- **build**: use browser timer handle types (ab29e74)
- **build**: cast runtime-only note metadata safely (88a04e1)
- **build**: use numeric Tiptap end selection (de1e637)
- **build**: type lowlight runtime test doubles (1a79680)
- **build**: align editor performance diagnostic types (972687f)
- **video**: correct desktop overlay guard syntax (#367) (cf41b24)
- **video**: keep desktop native controls interactive (#367) (6bad94f)
- **editor**: keep runtime notice compatible with older webviews (6ed11f6)
- **editor**: harden viewport highlight scheduling (8bec5ce)
- **editor**: use canonical empty decoration set (db9f00b)
- **editor**: preserve rich-text threshold compatibility (649c657)
- **editor**: avoid false large-document mode for compact rich text (b5a0255)
- **search**: animate full-text search loading spinner (ead4262)
- **search**: make sidebar loading spinner rotate (d66d51f)
- **search**: buffer sidebar typing and preserve focus (c4f0394)
- 删除不必要的文件 (a88fd22)
- **editor**: bypass Tiptap and Yjs for huge rich-text notes (c0a44c7)
- **search**: preserve intentional short queries (bc40fee)
- **search**: defer progressive short queries (7e8b0e0)
- **search**: cancel stale progressive requests (394fd8b)
- **editor**: route huge Markdown notes to safe mode (61bfd1a)
- **android**: 对齐 findLast 长度转换语义 (4b37273)
- **editor**: 区分 WebView 兼容错误与笔记结构异常 (e5be206)
- **android**: 在应用启动前加载运行时兼容层 (639ddb9)
- **android**: 补齐旧版 WebView findLast 兼容 (1d15943)
- **editor**: remove task list DOM observer loop (#361) (635fda3)
- **editor**: align task and bullet list markers (#361) (82cad44)
- **search**: repair source text and bound candidate retrieval (#340) (5c4ead6)
- **editor**: keep in-note search matches visible (#328) (9a3df5f)
- **editor**: complete cache-first and split loading coverage (#351) (fb40a94)
- **editor**: smooth delayed note loading transitions (#351) (e998f9e)
- **sync**: trust server probe for LAN connectivity (#350) (14d1e11)
- **sync**: respect syncNow failure results (#350) (ac7abca)
- **sync**: harden recovery flush single-flight (#350) (a0b85a7)
- **sync**: distinguish visibility probes from real recovery (#350) (27699df)
- **sync**: tighten workspace refresh bridge types (882f678)
- **ui**: deduplicate space navigation entry (290e8dd)
- **ui**: load space action trigger guard (52450c0)
- **ui**: hide legacy transfer floating trigger (bbb6788)
- **ui**: move space actions into navigation rail (bc32d3e)
- **ui**: consolidate space actions into compact launcher (24ae016)
- **editor**: clarify block indent shortcuts (#327) (b61dc13)
- **editor**: render code block indent on NodeView (#327) (5c08f2e)
- **electron**: validate updater release assets (#329) (7b39915)
- **siyuan**: keep rich-text indexes consistent after import (#284) (9e3b805)
- **embed**: keep sandbox and fallback state synchronized (#284) (e958bbd)
- **markdown**: hide standalone SiYuan block IAL rows (#284) (4cfc5bf)
- **siyuan**: finalize rich-text imports with explicit safe mappings (#284) (06dc638)
- **siyuan**: harden rich-text mappings for imported advanced nodes (#284) (ded13ea)
- **siyuan**: canonicalize real callout and IAL AST nodes (#284) (f975e3d)
- **embed**: require password handshake and expose safe fallback (#284) (8b010fd)
- **markdown**: keep semantic preview blocks intact (#284) (2de3d82)
- **markdown**: normalize imported SiYuan callouts (#284) (ae94cc5)
- **note-transfer**: require interactive safe move execution (#325) (a15bb2c)
- **note-transfer**: keep content text references aligned (#325) (830f995)
- **note-transfer**: require complete move preview versions (#325) (37f883d)
- **note-transfer**: install active-workspace refresh bridge (#325) (6c0b7ed)
- **note-transfer**: refresh active workspace after transfer (#325) (ec59051)
- **note-transfer**: await object-storage preview and execution (#325) (9ac3a3d)
- **note-transfer**: require attachment-safe move semantics (#325) (17c82e2)
- **note-transfer**: bridge note link index synchronization (#325) (584ba3f)
- **note-transfer**: bridge attachment reference synchronization (#325) (37a7541)
- **note-transfer**: use UUID link fixtures and initialize audit schema (#325) (4622c33)
- **note-transfer**: correct preview link counts and blocker statuses (#325) (098b410)
- **upload**: finish offline image uploads deterministically (#331) (1bf9451)
- **android**: enable WebView long-press text selection (#335) (cf352e6)
- **android**: restore editor text selection actions (#335) (4b9a79c)
- **android**: install editor media scope guard before app mount (#338) (91d5525)
- **android**: isolate non-editor media buttons from editor bridge (#338) (8120ce7)

### ⚡ 优化

- **ai**: scope index copy observer to settings panel (2bad49f)
- **frontend**: scope sidebar search observer to relevant nodes (1ea704d)
- **blocks**: unify mixed patch index updates (a595ffd)
- **blocks**: incrementally index top-level structural patches (563f8f8)
- **blocks**: update leaf patch indexes incrementally (f6343e2)
- **editor**: suppress optimized-mode outline rescans (9b6fa97)
- **editor**: cache ProseMirror plain-text snapshots (8b7b831)
- **editor**: stop realtime full-document search rescans (c040f6a)
- **editor**: defer math node rendering by runtime mode (84b4c46)
- **markdown**: bypass legacy full-text diff during incremental sync (9c8d4f5)
- **editor**: limit code highlighting to active viewport (5775cfd)
- **editor**: stop code-block scans in lightweight mode (5935b18)
- **editor**: measure note fetch and runtime policy stages (90f91fb)
- **editor**: lazy-load offscreen rich-text images (c985498)
- **editor**: disable code highlighting in lightweight mode (0635080)
- **sidebar**: make notebook creation optimistic (#344) (4be7b08)
- **sidebar**: make notebook creation optimistic (b6f10c9)
- **editor**: optimize code block input and save acknowledgment (#342) (c72c971)
- **editor**: optimize code block input and save acknowledgment (39120f1)

### ♻️ 重构

- **ai**: mount embedding index task copy bridge (03d1bc6)
- **ai**: clarify embedding index task copy (d69501b)
- **tree**: group create and import actions (8e99702)
- **sidebar**: delete legacy notebook directory implementation (a8b5804)
- **layout**: retire manage mode and list-toggle shortcut (2bc0913)
- **shortcuts**: remove retired note-list layout shortcut (f1fd25d)
- **commands**: retire legacy note-list layout command (e2078cb)
- **navigation**: remove legacy all-notes directory entry (790fb77)
- **frontend**: handle all sidebar search surfaces safely (5aca659)
- **frontend**: mount unified sidebar search experience (d3e2ddb)
- **frontend**: install sidebar search compatibility bridge (16aa13c)
- **frontend**: retire duplicate sidebar search field (c613e18)
- **frontend**: remove legacy notebook tree toggle (0897353)
- **knowledge-tree**: preserve base schema helper for trigger hardening (ae49e45)
- **permissions**: preserve capability core for workspace ownership fix (50d43b8)
- **knowledge-tree**: preserve core service for listing fix (fce65cc)
- **code-block**: keep language setup in view dependency (a0939da)
- **editor**: use scoped list move operations (7908287)
- **editor**: scope list item moves (4beee4e)
- **blocks**: use scoped list move protocol (99d8465)
- **blocks**: scope list hierarchy moves (37207c8)
- **attachments**: remove retired image host wording (5e72f3f)
- **attachments**: remove third-party image hosting (f128192)
- **image-hosting**: route legacy config through repository (faf015f)
- **frontend**: 简化笔记列表拖放目标解析逻辑 (19d1661)
- **upload**: remove image-host-specific timeout constants (9dac0ac)
- **api**: remove retired image-host upload override (2e7cb0a)
- **image-hosting**: remove retired fallback policy service (146b6be)
- **image-hosting**: remove retired S3 image host service (4ec7bc7)
- **frontend**: 简化笔记本排序偏好存储并优化刷新按钮锚点 (ae33d88)
- **image-hosting**: retire upload API and preserve migration metadata (976f78c)
- **attachments**: retire third-party image upload path (be940fb)
- **navigation**: expose connection actions through account menu (473e416)
- **desktop**: turn server center into connection and account flow (d840e4e)
- **migration**: remove superseded light migration engine (dfc518c)
- **migration**: remove legacy cloud migration dialog (46c8ada)
- **desktop**: move server management into account flow (86fa803)
- **editor**: share Tiptap derived runtime policy (f53bab1)
- **editor**: isolate Tiptap derived runtime policy (e822a71)
- **editor**: unify markdown safe mode with runtime policy (17f945c)
- **releases**: share cached release lookup with updater (#330) (bab11a4)

### 📝 文档

- 设计知识树滚动条视觉方案 (25ac654)
- **perf**: document issue 210 cross-platform sign-off (7c74301)
- **sdk**: show Markdown create and update flows (882b980)
- **api**: document native Markdown note contract (c74a609)
- 设计移除视口优化提示 (fc18197)
- 编写移除侧栏账号入口计划 (3aff5ee)
- 设计移除侧栏账号入口 (16bcc6a)
- 编写移除连接与迁移功能计划 (9833ddc)
- 设计移除连接与迁移功能 (180bfd5)
- 编写拆分文档菜单实现计划 (6039616)
- 设计拆分文档入口移入更多菜单 (bac901e)
- 更新 M6～M7 灰度与代际说明 (ba91868)
- 添加 M6～M7 实施计划 (54e1e70)
- 固化 M6～M7 灰度演进设计 (c4dfd0c)
- **blocks**: document safe inline images V2-J (170c8be)
- **blocks**: document list item structure patches V2-I (737491a)
- **blocks**: describe list item structure patches (3514376)
- **blocks**: document list subtree index mode (8bab906)
- **blocks**: document list subtree index updates (b50490d)
- **blocks**: clarify list attrs and subtree planning (bbb96dc)
- **blocks**: document list hierarchy patch V2-G (7c8d442)
- **blocks**: describe controlled list hierarchy patches (1bba45f)
- **blocks**: record no-history empty Block reconciliation (f6e43ea)
- **blocks**: document empty document reconciliation V2-E (6f77735)
- **blocks**: record empty document reconciliation (66b6044)
- **blocks**: document mixed index patch V2-D (126da74)
- **blocks**: document structural index patch V2-C (ff34ed4)
- **blocks**: document incremental index updates (e9e7d97)
- **blocks**: document rich replacement patch V2 (c7dcfb0)
- **env**: remove legacy image hosting wording (b74ca53)
- **attachments**: document image-hosting retirement and migration (c97f32e)
- **desktop**: document connection-first server workflow (7e59384)
- **blocks**: document grey-save safety boundaries (b89a148)
- **blocks**: document Tiptap grey rollout (4bd7883)
- **blocks**: clarify user-level idempotency keys (8aa9a85)
- **blocks**: document Block Patch API V1 (658e547)
- **block-links**: document split redirect behavior (ade6961)
- **note-split**: record Tiptap split implementation (f180963)
- **note-split**: assess rich-text heading split (a1b3106)
- **readme**: use HTTP official and demo addresses (cac88e4)
- **tutorials**: update web guide and HTTP links (88c222d)
- **tutorials**: refresh quick start workflow (b41af29)
- **tutorials**: rebuild current help center index (b72d9cc)
- **readme**: distinguish official website and demo (42ec2d4)
- **readme**: align English project guide (ee25ab6)
- **readme**: rewrite project overview and deployment guide (6b108df)
- **docker**: update deployment and online upgrade workflow (#330) (e02e7fa)
- **updater**: add security and recovery guide (#330) (ec9b6ce)
- **docker**: document updater environment controls (#330) (2cb50aa)

### 💄 样式

- **frontend**: distinguish tree filtering from global search (b1b3ba0)
- **sdk**: remove accidental BOM (3b95332)

### ✅ 测试

- **import**: cover SingleFile HTML normalization (f23cb6a)
- **ai**: cover embedding index task copy (e74fe59)
- **tree**: lock web scrollbar runtime contract (e629c57)
- **tree**: cover custom scrollbar geometry (ee5570b)
- **tree**: lock visible desktop scrollbar contract (0b9be0c)
- **tree**: lock inline create interaction contract (c129362)
- **tree**: cover inline create title helpers (e75cb19)
- **sidebar**: accept simplified unified sidebar root guard (e1a39e3)
- **shortcuts**: remove legacy note-list shortcut expectations (842c8a7)
- **layout**: cover unified-tree-only migration and view policy (a93a7d7)
- **layout**: align editor workspace tests with unified tree (68fc21d)
- **mobile**: run note search launcher in jsdom (8d18b79)
- **mobile**: cover note search launcher sequencing (2634ceb)
- **frontend**: run knowledge tree sort tests in jsdom (4a4c05e)
- **frontend**: cover unified knowledge tree sorting (5fea266)
- **frontend**: cover sidebar search scope cleanup (134e30f)
- **electron**: cover markdown encoding detection (693d89d)
- **editor**: align format painter fixtures with schema (a24b726)
- **issue-455**: add one-shot schema fixture correction (c4441d3)
- **issue-455**: add schema-correct test fix (dfaf622)
- **editor**: protect format painter UI integration (444c4cc)
- **editor**: cover safe format painter behavior (85a9df8)
- **android**: cover Markdown immersive editing (d009e44)
- **android**: add immersive editor regression gate (90b6a7b)
- **knowledge-tree**: cover context menu capability matrix (2bc1d26)
- **shortcuts**: verify cleared bindings remove tooltip hints (bfcc334)
- **shortcuts**: model the real ProseMirror editor root (3556083)
- **shortcuts**: verify exported platform document (d9c3477)
- **shortcuts**: cover persistence validation and reset (5e002f9)
- **note-split**: destroy Yjs rooms during database cleanup (7045e4a)
- **note-split**: close database after backend suite (d29647a)
- close shared database after backend suites (4410050)
- **knowledge-tree**: trace subtree restore steps (268906b)
- **knowledge-tree**: expose failing operation phase (2c44357)
- **postgres**: cover v64 structural guard (9d25391)
- **knowledge-tree**: expect v64 structural guard schema (d20f55e)
- **postgres**: verify document-parent preservation trigger (f636ded)
- **knowledge-tree**: expect v63 legacy sync schema (1dcd713)
- **knowledge-tree**: verify complete subtree restore (8a55a79)
- **permissions**: prevent workspace creators from becoming node admins (b9a4886)
- **knowledge-tree**: avoid CommonJS top-level await (714117f)
- **shares**: mount named management router (#447) (7eeb53d)
- **shares**: cover management HTTP contract (#447) (0a42d22)
- **perf**: require complete issue 210 stability evidence (ca82c66)
- **perf**: focus the synthetic editor before save sampling (fe2c575)
- **shares**: use repository React DOM harness (#447) (4f8daeb)
- **perf**: cover issue 210 sign-off validator (12393b9)
- **shares**: stabilize page API mock (#447) (7ab181e)
- **perf**: cover issue 210 runtime collector (0a647b2)
- **shares**: cover management page rendering and filters (#447) (7cc830d)
- **shares**: cover management presentation helpers (#447) (9ee4f0e)
- **shares**: cover management filtering and access (#447) (c03b10e)
- **issue-370**: cover workspace layout helpers (a4dd3d1)
- **api**: cover authorized shared notebook subtree (45724fc)
- **sidebar**: cover shared notebook hierarchy (5f0040b)
- **block-patch**: align gate with current protocols (#355) (cb4b829)
- **editor**: cover initialization timeout downgrade (be1138d)
- **tags**: cover idempotent scoped creation (f9d7f89)
- **tags**: cover scoped uniqueness migration (bfa3f52)
- **sdk**: cover Markdown note API contract (49f9da4)
- **code-block**: separate case and autodetect checks (30f07a0)
- **code-block**: cover MAXScript picker label (f1252fc)
- **markdown**: cover MAXScript fences (89c5b0a)
- **code-block**: cover MAXScript registration (304fec0)
- **import**: require current admin role for permission undo (348e513)
- **export**: resolve data manager workspace scope (dc31740)
- **import**: read postgres import batch migration (e8cfe39)
- **import**: verify postgres permission schema contract (beea4ac)
- **import**: accept normalized markdown block ids (ecf8229)
- **import**: cover permission review and request payloads (1504186)
- **import**: cover v2 permission transfer and undo (e113372)
- 修正窗口化选择测试类型 (8d1387c)
- **editor**: send inline image Block patches (9baa4e8)
- **blocks**: cover image replacement route transactions (e1bfdba)
- **editor**: plan inline image Block replacements (f5d7e15)
- **blocks**: cover inline image replacement patches (71d005d)
- **editor**: type list structure API fixtures (88d77a2)
- **editor**: cover list structure API contract (8bba0ac)
- **editor**: reject conflicting list structure identities (f47d223)
- **blocks**: keep truly unrelated rows stable (0b45e11)
- **editor**: send list item structure Block patches (efb6bca)
- **editor**: cover list item structure planning (6042f6e)
- **blocks**: cover list item structure patch transactions (2cbc3d2)
- **blocks**: cover controlled list item structure patches (9e9c72d)
- **editor**: accept list subtree index responses (bbc26aa)
- **blocks**: cover incremental list subtree indexes (af01cba)
- **editor**: cover list moves with large subtrees (7acdd84)
- **editor**: align deterministic adjacent list move (40817fe)
- **editor**: cover ordered attrs and equivalent list moves (0df7ee7)
- **blocks**: preserve ordered list attrs on sink (86f86f6)
- **editor**: fall back after rejected list moves (5ef3b88)
- **editor**: send list hierarchy Block patches (c7cd8de)
- **blocks**: cover list hierarchy patch transactions (1e62559)
- **editor**: cover controlled list hierarchy planning (77e9349)
- **blocks**: cover controlled list hierarchy moves (b6411ba)
- **editor**: preserve undo across empty Block ID reconciliation (844c753)
- **editor**: expect empty document Block patch (d7a890b)
- **editor**: reconcile server empty Block identity (5099932)
- **editor**: plan empty document Block reconciliation (a7c48b2)
- **ai**: isolate embedding queue hardening cases (48ad3b5)
- **blocks**: cover create-then-move mixed identities (b1a6309)
- **editor**: align rich planner with unified top-level batches (556dd53)
- **ai**: cover embedding queue recovery (9c27cde)
- **blocks**: cover mixed incremental patch indexes (5988237)
- **editor**: plan rich mixed structural batches (9c7aa5b)
- **editor**: expose structural index update kind (b746651)
- **blocks**: cover incremental top-level structural indexes (901bde7)
- **blocks**: expose incremental index response metadata (b24d0b2)
- **blocks**: cover ancestor and type index updates (c36c785)
- **blocks**: cover incremental patch indexes (752523c)
- **blocks**: type route V2 count assertions (38380c2)
- **editor**: route rich block changes through patch V2 (c36e630)
- **editor**: plan safe rich block replacements (cb0da33)
- **blocks**: cover rich replacement transactions (9c5fe01)
- **blocks**: cover safe rich block replacements (5e4af1c)
- **image-hosting**: enforce repository-backed legacy cleanup (fb6c991)
- **image-hosting**: verify retired backend surface (abc9c75)
- **attachments**: lock third-party image hosting retirement (b7be8cc)
- **desktop**: cover connection-first server navigation (d0950c8)
- **import**: cover permission mapping client requests (5320cfc)
- **import**: cover permission export and guarded mapping (d3d058b)
- **editor**: cover rich node fallback classification (aa835bc)
- **editor**: cover rich block patch planning (81e9206)
- **blocks**: cover rich block replacements (5decf7c)
- **blocks**: preserve version history transactionally (3e4955d)
- **editor**: scope Block Patch runtime to owning note (8998259)
- **editor**: keep delete-all on whole-save fallback (a6d510c)
- **editor**: serialize title saves after Block Patch (dfc3cd1)
- **editor**: keep public Tiptap outside AppContext (47bbdc6)
- **editor**: cover Tiptap Block Patch runtime shell (efca5d1)
- **blocks**: cover authoritative patch response (bea1d9d)
- **blocks**: assert authoritative patch snapshots (332e46e)
- **editor**: cover Block Patch rollout policy (0aa797a)
- **editor**: cover safe Tiptap patch planning (486e1bc)
- **blocks**: reject cross-note operation ID reuse (666d9f4)
- **blocks**: cover confirmed frontend patch client (3e7d6b5)
- **blocks**: keep nested containers valid after patch deletes (8aa6696)
- **blocks**: cover atomic batch patch route (a64a716)
- **blocks**: cover pure Tiptap batch patch engine (213d8a8)
- **editor**: cover optimized Tiptap derived policy (06d61d8)
- **editor**: cover immutable derived snapshot cache (7fdf233)
- **editor**: cover Tiptap derived runtime aliases (a260aa7)
- **editor**: mirror runtime shell aliases in vitest (c833f4b)
- **editor**: avoid decoration implementation details (f2812d9)
- **editor**: cover lightweight search runtime policy (6a0f04d)
- **editor**: cover deferred math rendering (98d53ab)
- **block-links**: cover Markdown split redirects (0d34e72)
- **block-links**: cover redirected client navigation (df31de1)
- **block-links**: exercise a real two-hop block chain (fd6c0e1)
- **block-links**: cover split redirect resolution (8b90ab2)
- **note-split**: cover empty Tiptap chapter bodies (1f1dba8)
- **note-split**: cover rich-text risk confirmation (0418f31)
- **note-split**: cover Tiptap preview boundaries (2642e35)
- **note-split**: cover Tiptap planning and transactions (77a9f95)
- **note-split**: strip persisted block ids from titles (527622c)
- **note-split**: strip heading block ids in preview (728f028)
- **note-split**: verify valid directory backlinks (b9b5c1f)
- **note-split**: submit selected chapter indexes (5a80f1b)
- **note-split**: cover selected chapters and retained attachments (b961ee7)
- **docker**: guard hardened backup entrypoint (#352) (d1b97ad)
- **note-split**: preserve markdown line breaks while stripping block ids (bf61383)
- **note-split**: compare restored markdown semantically (f9265ba)
- **note-split**: verify transactional split attachment and undo flow (c9f4ed4)
- **editor**: verify format-aware mode staging (1601cca)
- **desktop**: cover markdown editor selection (bcca496)
- **note-split**: cover client split preview (6470ea1)
- **note-split**: cover markdown split planning (726172c)
- **markdown**: validate real Y.Text event deltas (a6fe049)
- **markdown**: cover incremental collaboration runtime (27b60f9)
- **editor**: make bilibili paste assertion resilient (86df640)
- **editor**: cover bilibili link paste embedding (52fefbd)
- **markdown**: cover incremental Y.Text mapping (ecd9414)
- **markdown**: cover viewport editor routing (44806ec)
- **markdown**: cover stale-safe worker controller (f4b4215)
- **markdown**: cover worker-safe analysis (63e933b)
- **editor**: stabilize deferred media node coverage (f2c64d3)
- **editor**: cover deferred video and mermaid shells (290361e)
- **editor**: cover interaction-gated heavy nodes (016bce8)
- **editor**: make viewport highlight timing deterministic (817cc0e)
- **editor**: cover runtime notice session restore (231d552)
- **editor**: cover viewport-scoped code highlighting (57cb100)
- **editor**: correct structural node expectation (41034f0)
- **editor**: avoid global act environment type conflict (2454d09)
- **editor**: cover heavy-node viewport activation (46000bb)
- **editor**: run runtime store tests in jsdom (ae53012)
- **editor**: cover progressive rich-text routing (351c580)
- **editor**: cover runtime store and capability changes (df7c4ad)
- **editor**: cover progressive runtime modes (4c91d39)
- **editor**: cover rich-text safe mode thresholds (206e28a)
- **search**: cover full-text spinner animation fallback (64b3678)
- **search**: cover sidebar spinner animation (f220471)
- **search**: cover buffered sidebar input policy (2996e2b)
- **search**: cover progressive query delay (b35dba6)
- **search**: cover progressive short query policy (2dc881a)
- **editor**: cover large Markdown safe mode thresholds (920c448)
- **editor**: add large Markdown freeze reproducer (e669742)
- **android**: 修正 findLast 回调类型约束 (02354e3)
- **android**: 稳定旧 WebView 编辑器兼容用例 (fcea8d9)
- **editor**: 覆盖 WebView 兼容错误提示 (6a76d22)
- **android**: 覆盖旧 WebView Tiptap findLast 回归 (43aaef0)
- **editor**: remove obsolete task DOM identity test (#361) (dae12bc)
- **editor**: guard against task list observer loops (#361) (7100c33)
- **sync**: cover failed recovery without success signal (#350) (2faed86)
- **sync**: cover visibility and real recovery states (#350) (3b3ba30)
- **editor**: cover code block NodeView indent (#327) (94665ce)
- **electron**: reject stale updater binaries (#329) (8dfd0e7)
- **embed**: cover acknowledged cross-origin password delivery (#284) (37ade57)
- **siyuan**: make issue 284 fixture path runner-independent (#284) (81e5697)
- **embed**: use the active jsdom origin (#284) (f6c4372)
- **siyuan**: align fixture block IDs with Spec 2 (#284) (665ca16)
- **siyuan**: cover issue 284 package import end to end (#284) (1691f73)
- **siyuan**: document issue 284 regression fixture (#284) (7a8beb1)
- **siyuan**: add valid issue 284 SiYuan AST fixture (#284) (b4f80e5)
- **embed**: cover DOM fill and password-free handshake offer (#284) (2dc9d14)
- **markdown**: render live callouts through real preview (#284) (0750027)
- **markdown**: cover imported callout aliases and IAL (#284) (8cb604b)
- **note-transfer**: cover preview guard and reference alignment (#325) (e1f8c87)
- **note-transfer**: await staged attachment transfers (#325) (585835d)
- **note-transfer**: cover cross-workspace copy and move (#325) (d1f835c)
- **android**: cover editor selection fallback decision (#335) (a4a92d2)
- **android**: cover Diary and editor media scope isolation (#338) (64aa10e)
- **updater**: cover image restrictions and config preservation (#330) (9b093e0)

### 📦 构建

- **blocks**: register batch patch route (d0befe3)
- **editor**: route Tiptap derived reads through runtime guards (1357974)
- **editor**: route math and search through runtime shells (e0a5a2b)
- **markdown**: emit classic analysis worker (64d2934)

### 🤖 CI

- **ai**: add embedding index copy regression gate (340e634)
- **issue-455**: upload typecheck diagnostics (82fb71e)
- **issue-455**: upload focused test diagnostics (011597b)
- **issue-455**: add permanent safe format painter gate (aca37ce)
- **knowledge-tree**: finalize context-menu regression gate (29f8f9c)
- **issue-468**: add one-time duplicate declaration fix runner (56a30af)
- **issue-468**: add one-time panel syntax fix runner (2ffd638)
- **knowledge-tree**: publish context-menu typecheck diagnostics (c9e3ede)
- **knowledge-tree**: cover restored context-menu capabilities (3d14924)
- **issue-468**: add controlled context-menu patch runner (5716cd7)
- **shortcuts**: use the repository typecheck command (93e5970)
- **shortcuts**: expose typecheck diagnostics (a0ac34f)
- **shortcuts**: minimize diagnostic setup output (09adfe9)
- **shortcuts**: keep failure logs compact (e1db641)
- **shortcuts**: run registry and override tests (ead8420)
- **knowledge-tree**: remove temporary Yjs patch job (7947c40)
- **note-split**: force exit after known tests finish (7eb1f2c)
- **note-split**: restore focused regression gate (9a01c57)
- **issue-370**: patch Yjs flush from branch workflow (4e1dd65)
- **note-split**: patch no-op Yjs flush before regression gate (f2e176c)
- **issue-370**: run Yjs patch on PR updates (5262d90)
- **issue-370**: apply Yjs no-op flush fix (5fcc533)
- **note-split**: expose failing test tail in diagnostics (cc747a4)
- **note-split**: print focused timeout diagnostics (098efac)
- **note-split**: expose per-suite failure status (8ea7449)
- **note-split**: publish bounded failure diagnostics (d996f02)
- **note-split**: upload diagnostics only on failure (2b6c76a)
- **note-split**: bound and isolate backend diagnostics (a56e32e)
- **note-split**: capture backend failure diagnostics (442329c)
- **knowledge-tree**: retrigger validation after restore fix (eecae9a)
- **knowledge-tree**: publish backend failure diagnostics (e2db313)
- **knowledge-tree**: report branch validation to epic (f6d8e5d)
- **knowledge-tree**: validate feature branch before PR (b6596c8)
- **shares**: document final V1 gate (#447) (22d174b)
- final sync main for issue 447 (cf4fcae)
- **shares**: retain backend diagnostics (#447) (31e34fe)
- **shares**: add management route contract test (#447) (ec9d753)
- sync latest main for issue 447 (d972108)
- **shares**: add share management regression gate (#447) (339a896)
- apply and verify issue 210 sign-off hardening (5d0f360)
- rerun issue 447 with nullable title fix (f7098b8)
- align issue 447 nullable note title (d2296d7)
- capture issue 447 TypeScript diagnostics (5ad96e0)
- upload issue 210 test diagnostics (6fee820)
- verify issue 210 performance sign-off tooling (89173fc)
- capture issue 447 frontend diagnostics (54e2eb4)
- rerun issue 447 bootstrap after test fix (7acb151)
- verify issue 447 implementation (f365a99)
- bootstrap issue 447 integration (d9ae8bf)
- **issue-370**: add layout and split checks (fa4d40e)
- bootstrap shared notebook tree patch (9127715)
- **issue-355**: sync latest main before final review (812c26f)
- **issue-355**: complete api mock shape (c77c0b2)
- **issue-355**: capture gate repair failures (83c6fb6)
- **issue-355**: repair and verify block patch gate (6bf5c73)
- **issue-355**: upload diagnostic logs (737ea8b)
- **issue-355**: diagnose block patch regression (19cb0f8)
- **issue-355**: include REST content-view contract test (ad26977)
- **editor**: add initialization timeout regression gate (5fbf00a)
- **issue-355**: verify API and projection boundaries (18f0080)
- **issue-355**: add content-format regression gate (0e23b2a)
- **issue-355**: commit verified source outside workflow paths (c172a05)
- **issue-355**: checkout source branch before rework (097f1e0)
- **issue-355**: allow PR-triggered verified rework (b998e9f)
- **issue-355**: run verified content-format rework (4980176)
- **tags**: add idempotency regression gate (d2e6f65)
- **sdk**: finalize read-only contract gate (7a6afca)
- **sdk**: capture contract test diagnostics (bb665e6)
- **sdk**: report build diagnostics on pull requests (a771393)
- **sdk**: split build and contract test steps (c4b72de)
- **sdk**: add public API contract gate (3b1849c)
- **search**: add regression gate for issue #340 (84da9c4)
- **code-block**: remove temporary diagnostics workflow (1d61f7a)
- **code-block**: split case and autodetect checks (6e385b2)
- **code-block**: isolate MAXScript grammar checks (9b8ef72)
- **editor**: isolate MAXScript validation steps (b639a7b)
- **editor**: validate code-block language extensions (4e9af99)
- **import**: cover permission undo authorization (09d9ae7)
- **import**: watch primary package import flow (627a794)
- **import**: validate postgres permission schema contract (83476d5)
- **import**: validate permission transfer v2 (c8b4c22)
- **blocks**: cover image route and runtime integration (1e9edc2)
- **blocks**: cover inline image Block patches (0c9fddf)
- **editor**: allow manual focused workflow runs (04873f4)
- **blocks**: allow manual focused workflow runs (8df1925)
- **blocks**: cover list structure client contract (c9caaf2)
- **blocks**: cover list item structure patches (69aaa01)
- **blocks**: cover list subtree index planning (6f67bd5)
- **blocks**: cover controlled list hierarchy patches (32bf59b)
- **blocks**: cover no-history empty Block reconciliation (8e1884b)
- **blocks**: cover empty document reconciliation (ac85394)
- remove embedding queue trigger (2e4276d)
- **blocks**: cover mixed incremental indexes (de71d75)
- remove one-shot embedding queue script (c3c2408)
- remove one-shot embedding queue workflow (8342a80)
- prepare embedding queue fix run (79d0d45)
- trigger embedding fix from merge push (d442816)
- run embedding queue fix validation (70bab12)
- add one-shot embedding queue fix script (6d6923f)
- replace embedding queue validation workflow (b1c9012)
- validate embedding queue recovery fix (4b3b02c)
- **blocks**: cover incremental patch indexes (be473a6)
- **blocks**: cover rich replacement patch V2 (d284ca8)
- remove verified removal artifact workflow (e99393a)
- remove one-shot image hosting removal workflow (7468644)
- **pg**: remove obsolete image hosting validator (2567b69)
- **pg**: remove image hosting final-sync hooks (da786d5)
- **pg**: remove image hosting restoration hooks (6522627)
- apply verified image hosting removal artifact (fc562cb)
- include verified hidden removal bundle (b03d15d)
- publish verified image hosting removal artifact (3e0b8ff)
- publish verified image hosting removal to result branch (d8647b4)
- trigger image hosting removal from one-shot PR (27b1bf6)
- trigger image hosting removal from issue comment (d87d7ba)
- trigger complete image hosting removal (ca67e21)
- add one-shot image hosting removal workflow (c3fe58d)
- **image-hosting**: remove retired migration trigger (710d7f1)
- **image-hosting**: remove retired migration workflow (e1372dc)
- **import**: validate round-trip permission mapping (f6f9ec7)
- **pg**: remove temporary round-trip C-1 validator (7f48e5a)
- **pg**: validate round-trip C-1 through pull requests (2ff7d15)
- **pg**: add round-trip batch metadata migration gate (a3e9342)
- **editor**: cover public Tiptap runtime context (a3aa9ed)
- **blocks**: cover public Tiptap context isolation (617877e)
- **editor**: run Tiptap Block Patch shell test (ab7395e)
- **pg**: use final synchronization gate on stable trigger (16c4dba)
- **blocks**: run Tiptap runtime shell regression (fa34f26)
- **pg**: add final latest-main synchronization gate (23c6f14)
- **editor**: cover Tiptap Block Patch rollout (5ed495f)
- **blocks**: validate Tiptap grey rollout (a44da36)
- **pg**: validate image hosting migration batch (afb021b)
- **pg**: trigger image hosting runtime migration (0063229)
- **pg**: add deterministic image hosting migration runner (f36b25a)
- **pg**: finalize image hosting runtime migration (38d013e)
- **pg**: migrate image hosting settings through runtime repository (a56ff09)
- **pg**: sync main from verified Yjs fix head (ce93fc1)
- **pg**: make Yjs fix resilient to indentation (295df2c)
- **pg**: apply verified Yjs fix to migration branch (7686e2a)
- **pg**: fix Yjs no-op version accounting (cf8e02e)
- **pg**: add note split undo diagnostics (ae5046e)
- **blocks**: validate frontend patch contract (6274d03)
- **pg**: rerun synchronized main validation with Yjs fix (bb1b3dc)
- **blocks**: validate batch patch engine and route (f21084c)
- **pg**: patch Yjs version semantics during synchronization (847bca2)
- **pg**: push Yjs fix before validation (112d6bf)
- **pg**: validate Yjs fix before main synchronization (86cda5b)
- **editor**: cover Tiptap derived runtime guards (0853664)
- **pg**: trigger Yjs fix from sync PR comment (16e198f)
- **pg**: trigger Yjs version fix (dd741ad)
- **pg**: add one-shot Yjs version fix runner (73b001a)
- **pg**: trigger synchronized main validation (023cc1a)
- **pg**: add deterministic push trigger for synchronization (cf12b08)
- **pg**: make main synchronization deterministic (d09ab16)
- **editor**: trigger when runtime test aliases change (3d25d41)
- **editor**: cover math and search runtime shells (4dc2f45)
- reconcile remaining main sync regressions (ee6de23)
- **block-links**: cover split redirect resolution (5ac89be)
- preserve reconciled PG files and upload SQLite diagnostics (a7fabd5)
- rerun failed SQLite files with detailed diagnostics (443d873)
- **note-split**: include empty Tiptap chapter regression (baa84b3)
- publish SQLite regression diagnostics during PG sync (3cae1d2)
- **note-split**: cover Tiptap split workflow (1bb24b1)
- publish PostgreSQL schema parity diagnostics during sync (4944f8e)
- publish SQLite boundary diagnostics during PG sync (87547f2)
- preserve reconciled PostgreSQL files during main sync (fcd0543)
- publish PostgreSQL sync status to fixed comment (d4436cc)
- validate token resources during PostgreSQL branch sync (cbc7995)
- include merged token route source diagnostics (5bcdfbb)
- **note-split**: include title normalization test (337ff12)
- publish PostgreSQL sync typecheck diagnostics (4acf57f)
- add one-time main to PostgreSQL branch sync workflow (0dee261)
- **note-split**: cover selected chapter workflow (6ecdca7)
- **note-split**: add frontend and backend regression workflow (cea8ecf)
- **markdown**: cover incremental Y.Text synchronization (4442bfb)
- **markdown**: cover viewport worker analysis (d28b4d0)
- **editor**: cover deferred media runtime shells (6ace8a5)
- **editor**: cover viewport highlight and runtime notice (31eabf1)
- **editor**: include code highlight runtime regression (6d249fb)
- **editor**: add progressive runtime regression checks (05f57a3)

### 🔧 其他

- ignore frontend/dist.bak build backup (e36b8dc)
- **issue-455**: remove one-shot nested block workflow (74ee0ec)
- **issue-455**: remove one-shot hook scope workflow (54a6b16)
- **issue-455**: remove one-shot test fixture workflow (7ba0e8b)
- **issue-455**: remove one-shot hook-order workflow (f379594)
- **issue-455**: remove one-shot format painter workflow (05db9d6)
- **issue-455**: add one-shot format painter integration workflow (b465f0b)
- **issue-455**: add controlled format painter integration (cadc116)
- **android**: remove one-shot immersive focus workflow (9a9640a)
- **android**: add one-shot immersive toolbar focus integration (b276f81)
- **android**: add final immersive toolbar focus fix (4afdfb8)
- **android**: remove one-shot Markdown cutover workflow (d5c22e0)
- **android**: add one-shot Markdown immersive integration (5fdbffa)
- **android**: add one-shot Markdown immersive patch (9fc2dcc)
- **editor**: remove one-shot immersive cutover workflow (cbd0974)
- **editor**: use unique immersive editor patch anchor (be543e4)
- **editor**: capture immersive patch diagnostics (41da241)
- **editor**: add one-shot Android immersive editor integration (cfc5515)
- **editor**: add one-shot Android immersive editor patch (736b964)
- **issue-468**: remove one-time duplicate declaration workflow (e578ac3)
- **issue-468**: add one-time duplicate declaration fix (a427634)
- **issue-468**: remove one-time panel syntax workflow (72a5a2a)
- **issue-468**: add one-time panel syntax fix (1a9e6bc)
- **issue-468**: remove one-time context-menu patch workflow (d442a4e)
- **issue-468**: add controlled context-menu integration patch (882e983)
- **shortcuts**: remove one-shot customization workflow [skip ci] (93486dd)
- **shortcuts**: run one-shot patch from pull request (9df5a13)
- **shortcuts**: run one-shot customization patch (a3640c0)
- **shortcuts**: add one-shot patch script (7e7ba35)
- **shortcuts**: trigger integration patch (b84a2d6)
- **shortcuts**: add one-shot customization patch (756daa7)
- **issue-370**: remove temporary Yjs auto-fix workflow (0e62ddd)
- **issue-370**: remove temporary Yjs patch workflow (18a614c)
- **issue-370**: add temporary Yjs flush auto-fix workflow (efe131d)
- **knowledge-tree**: remove restore diagnostics (e369ccc)
- **shares**: remove final main sync workflow (8b6c4f7)
- **shares**: remove temporary main sync workflow (3662257)
- **perf**: remove temporary issue 210 hardening script (d72b969)
- **shares**: remove temporary bootstrap workflow (5da94f4)
- **ci**: remove temporary issue 210 hardening workflow (8e4f66e)
- **shares**: remove temporary type fix script (de3f8a2)
- **shares**: remove temporary integration script (6bbc49f)
- **perf**: add temporary issue 210 hardening patch (d055f96)
- **ci**: remove temporary issue 210 verification workflow (cc32b32)
- **perf**: add issue 210 sign-off commands (9d11b4a)
- remove issue 365 bootstrap workflow (e643850)
- remove issue 365 bootstrap script (8b6dd61)
- add issue 365 branch patch bootstrap (34b92a7)
- **issue-355**: remove temporary main sync workflow (6247e08)
- **issue-355**: remove temporary gate repair workflow (6231c90)
- **issue-355**: remove temporary gate repair script (4327dd5)
- **issue-355**: add block patch gate repair script (c49c31b)
- **issue-355**: remove temporary boundary script (4cfbc78)
- **issue-355**: remove temporary boundary workflow (e9fe614)
- **issue-355**: add boundary verification script (3f968ee)
- **issue-355**: remove temporary rework script (a27d704)
- **issue-355**: remove temporary rework workflow (1e50013)
- **issue-355**: add verified rework script (1cd94f3)
- remove accidental file (3dc9740)
- remove accidental placeholder (573c1ae)
- placeholder (7634ac7)
- **import**: sync permission centers with latest main (4397551)
- remove unused search hotfix workflow (a0133bd)
- apply search input hotfix on main (56a8f4b)

### ⏪ 回滚

- remove accidental placeholder file (fcbe300)

### 📌 杂项

- placeholder (072420e)
- 优化分享管理的公开地址风险提示 (#457) (6649fcf)
- noop (9310bde)

### v1.4.1 - 2026-07-17

### 📝 文档

- design markdown live preview image auth fix (eaf611e)

### 🤖 CI

- remove temporary PostgreSQL access/session validator (abec8f3)
- temporarily validate PostgreSQL access and sessions (38251e6)

### 📌 杂项

- fix preserve protocol-relative markdown images (c394870)
- fix markdown live preview attachment images (13f5822)
- fix notebook export attachment auth (9bd3dd8)
- fix clipboard copy (03b2c68)
- fix notebook publication routes (5b02e06)

### v1.4.0 - 2026-07-17

### 🐛 修复

- **db**: migrate share comment source fields before indexing (ee86795)

### 📝 文档

- **db**: plan share comments migration fix (080b955)
- **db**: document share comments migration fix (7cbaf4e)

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

<!-- CHANGELOG:END -->

</details>

## Sponsor

If this project helps you, consider buying the author a coffee.

<p align="center">
  <img src="./weixin.jpg" alt="WeChat sponsor QR" width="280" />
</p>

You can also read the [author's note](./AUTHOR_STORY.en.md).

## License

[GPL-3.0](./LICENSE). Distributed derivative works must remain under GPL-3.0 and preserve the original copyright notice.
