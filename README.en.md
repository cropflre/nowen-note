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
## Changelog

> See [CHANGELOG.md](./CHANGELOG.md) for the complete history.
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
