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

### v1.2.2 - 2026-06-25

### ✨ 新增

- integrate image hosting into editor paste/drag/insert flows (IMAGE-HOSTING-INTEGRATE-01) (7865550)
- extraction status and logging for PDF/DOCX sync (DESKTOP-FOLDER-KB-SYNC-02-E.3) (eecb94e)
- extract PDF/DOCX text into contentText for search (DESKTOP-FOLDER-KB-SYNC-02-E.2) (35fb01c)
- third-party image hosting with S3-compatible storage (IMAGE-HOSTING-ENHANCE-01) (c5ed326)
- PDF/DOCX attachment sync UI and docs (DESKTOP-FOLDER-KB-SYNC-02-D) (67d0d85)
- support PDF/DOCX attachment upload in folder sync (DESKTOP-FOLDER-KB-SYNC-02-B) (d59f258)
- auto sync observability and safety (DESKTOP-FOLDER-KB-SYNC-01-E.2.1) (d46340d)
- folder sync file import with attachment support (DESKTOP-FOLDER-KB-SYNC-01-C.2) (19114c1)
- auto folder sync during app runtime (DESKTOP-FOLDER-KB-SYNC-01-E.2) (a5b1ab1)
- add folder sync interval config UI (DESKTOP-FOLDER-KB-SYNC-01-E.1) (0809ba5)
- enhance folder sync status display and logs (DESKTOP-FOLDER-KB-SYNC-01-D) (f702777)
- desktop folder sync upload for text files (DESKTOP-FOLDER-KB-SYNC-01-C.3) (ffe6661)
- add folder sync backend import endpoint (DESKTOP-FOLDER-KB-SYNC-01-C.2) (7f2822a)
- Nowen package import with ID remapping (NOWEN-PACKAGE-IMPORT-01) (7a6c2af)
- local folder scan, sha256 index, sync logs (DESKTOP-FOLDER-KB-SYNC-01-C.1) (edd218d)
- add notebook selection and config editing for folder sync (DESKTOP-FOLDER-KB-SYNC-01-B.1) (ba855fe)
- desktop folder selection and local sync config (DESKTOP-FOLDER-KB-SYNC-01-B) (f9f5a51)
- Markdown source/preview/split view modes (MARKDOWN-PREVIEW-MODE-01) (46a4fb7)
- Nowen package export for lossless migration (NOWEN-PACKAGE-EXPORT-01) (10effe8)
- show note format badge in list, sidebar and editor (NOTE-FORMAT-BADGE-01) (3f7a470)
- 原生 Markdown 笔记创建入口 + 回收站锁定 + 文档更新 (e339e17)
- **v1.2.2**: contentFormat 原生 Markdown 笔记 + 回收站锁定 + 文档扩充 (1207194)
- 增加笔记列表更新时间显示开关 (NOTE-LIST-TIME-VISIBILITY-01) (8b4b043)
- 附件按上传年月分目录存储 (ATTACHMENT-STORAGE-DATE-PATH-01) (2baa097)
- 移动端编辑器支持保存单张图片到相册 (NOTE-EDITOR-IMAGE-SAVE-01) (7c2a440)
- 安卓端导出图片保存到相册 (NOTE-IMAGE-EXPORT-02) (b8ab9af)
- 分享页 Lightbox 支持图片缩放 (SHARE-IMAGE-LIGHTBOX-01.4) (9a1ad5b)
- 分享页图片支持 Ctrl+滚轮缩放 (SHARE-IMAGE-LIGHTBOX-01) (8b2f154)
- Sidebar ?????????? PNG/JPG (NOTE-IMAGE-EXPORT-01.1 ??) (6d83bbe)
- ?????? PNG/JPG ?? (NOTE-IMAGE-EXPORT-01) (9bca066)
- ?????????? (TASK-FULLSCREEN-01) (39de523)
- ???????????? (TASK-CALENDAR-SUBSCRIBE-01-C) (891e4fd)
- ?????????? ICS Feed (TASK-CALENDAR-SUBSCRIBE-01-B) (b62538a)
- 说说模块增加日历记事视图 (SAY-CALENDAR-01) (40ce3e3)
- 待办模块移动端交互适配 (TASK-MOBILE-UX-01) (eab94bd)
- 沉浸式视频浏览模式 (DIARY-FEED-01) (5c51055)
- 说说草稿自动保存 (DIARY-DRAFT-01) (0d32e58)
- 说说时间线筛选增强 (DIARY-TIMELINE-FILTER-01) (4337fc3)
- 说说编辑器支持完整媒体编辑 (DIARY-EDITOR-MEDIA-01) (8d3ab2d)
- 说说视频 Range 请求支持 (DIARY-VIDEO-RANGE-01) (a13e2a8)
- 编辑器页面内全屏 + 分享页大纲清理 (0d4a649)
- show attachment storage mode in file manager (d382e59)
- add shared note outline (8dc5150)

### 🐛 修复

- pre-existing TypeScript errors across multiple components (7d1e9d8)
- add extracted/extractionError fields to importAttachment return type (4bd5b8a)
- remove remaining orphaned folderSync checkDedup code (dfdcb62)
- remove orphaned importAttachment code from api.ts merge (dc71eaa)
- merge duplicate folderSync API, add missing exports, fix imageUploadService (676705f)
- TypeScript errors for Docker build (Buffer, broadcastToUser, ImageHostingConfig) (e2e1b6b)
- check note read permission for attachment download (BUG-SHARED-ATTACHMENT-DOWNLOAD-01) (eee27ac)
- image hosting encryption key production validation (IMAGE-HOSTING-ENHANCE-01.2) (ee93827)
- image hosting security audit fixes (IMAGE-HOSTING-ENHANCE-01.1) (7dd2c2e)
- rename Image import to avoid DOM constructor conflict (1bb6d4f)
- add workspaceId/hash/uploadSource to folder sync attachment import (DESKTOP-FOLDER-KB-SYNC-02-C) (89fb580)
- folder sync attachment import, HTML format, security (DESKTOP-FOLDER-KB-SYNC-01-C.2.1) (0789358)
- folder sync scan bugs and security (DESKTOP-FOLDER-KB-SYNC-01-C.1) (6b9fac2)
- move rootNotebookId declaration outside try block (8093160)
- folder sync skipped status and sourcePathHash namespace (DESKTOP-FOLDER-KB-SYNC-01-C.3.1) (4cfdecd)
- import order, effective attachment map, workspace passthrough (NOWEN-PACKAGE-IMPORT-01.1) (f96a285)
- store sync notes as plain Markdown, add folder_sync_files table (DESKTOP-FOLDER-KB-SYNC-01-C.2.1) (edadd9a)
- add explicit Markdown preview styles without typography plugin (MARKDOWN-PREVIEW-MODE-01.2) (bbc2b07)
- render MarkdownPreview in editor area for source/preview/split modes (MARKDOWN-PREVIEW-MODE-01.1) (592a3dc)
- **i18n**: clean up garbled zh-CN calendarFeed and remove hardcoded bilingual dict (a1b8301)
- add toast import and fix buildHeaders in Nowen package export (d854cad)
- Nowen package attachment refs, schemaVersion, unknown format warning (NOWEN-PACKAGE-EXPORT-01.1) (b031a74)
- **auth**: clear remembered credentials after password change (3a1dbdf)
- use existing helpers in processMarkdownAttachments (EXPORT-CONTENT-FORMAT-01.2) (38e6e11)
- Markdown export scope, image processing and notebook export (EXPORT-CONTENT-FORMAT-01.1) (7bc32cb)
- export pipeline supports contentFormat (EXPORT-CONTENT-FORMAT-01) (dac4b28)
- **editor**: replace ? text with Sparkles icon for AI classify button (bf2d4e1)
- add contentFormat to GET notes list and search results (ce742a8)
- propagate contentFormat in noteToListItem and addNoteToList (NOTE-FORMAT-BADGE-01.1) (44cc79a)
- **sidebar**: add useTranslation to SidebarNoteItem for format badge (bb2333a)
- **mindmap**: remove read-only ref assignment for React 19 compat (3fade3d)
- **NoteList**: update CreateMenu onPick type to accept markdown (c78634c)
- **types**: add _noteId to NoteEditorUpdatePayload (a44bf5d)
- **tasks**: add explicit type annotations to fix Docker tsc build (b7d307f)
- **mindmap**: use non-passive wheel listener for zoom (4d4ea94)
- **notes**: allow user to clear document content, monitor only (6c8558c)
- **mindmap**: keep minimap fixed during pan and zoom (9c11174)
- **mindmap**: bind wheel zoom via onWheel prop after canvas mounts (b847188)
- **notes**: refine empty content guard to allow manual clear (ad62254)
- **notes**: add noteId snapshot to editor onUpdate callbacks (0a64965)
- **mindmap**: enable wheel zoom on canvas (061d907)
- **notes**: create favorite note from favorites view (73364a0)
- **notes**: prevent accidental empty content overwrite (d414eb2)
- **notebook**: allow revoking share links (566fbcf)
- **ai**: add missing toast import in AIWritingAssistant (72170be)
- **ai**: use parseAiTags for proper JSON array parsing in tag generation (bc98bbd)
- **sync**: broadcast note:deleted when deleting notebook + add diagnostic logs (b180a22)
- **todo**: remove blank gap beside task detail panel (2a75aaa)
- **ai**: sanitize reasoning content from generated outputs (507c365)
- **search**: prevent false positive note results (f0628f7)
- **sync**: handle note deletion events globally (e111ab7)
- **todo**: refine task workspace layout (6bdb14c)
- **sync**: 全局监听 note:deleted 触发列表刷新 (SYNC-DELETE-01-B) (298a135)
- **context-menu**: add export image formats to note list submenu (90a3f43)
- zh-CN 补齐 noteList.export 导出子菜单文案 (bb5cda6)
- 导出子菜单真正生效 — 替换 displayItems 中旧平铺结构 (BUG-CONTEXT-MENU-EXPORT-SUBMENU-01) (47e1770)
- 修复树形目录右键 PNG/JPG 导出无响应 (NOTE-IMAGE-EXPORT-01.2) (bc692fc)
- 防止孤儿清理误删待办图片附件 (TASK-ATTACHMENT-ORPHAN-CLEANUP-01) (b8f6ec5)
- 树形笔记目录联动更新时间显示开关 (NOTE-LIST-TIME-VISIBILITY-01.2) (8d5a8a4)
- 设置页联动笔记列表更新时间开关 (NOTE-LIST-TIME-VISIBILITY-01.1) (63d79d9)
- 附件路径校验拒绝反斜杠并支持两层月份递归扫描 (ATTACHMENT-STORAGE-DATE-PATH-01.1) (fd85706)
- 加强附件路径校验并跳过 .thumbs 扫描 (ATTACHMENT-STORAGE-DATE-PATH-01) (7b7f39a)
- 优化移动端图片预览工具栏布局 (EDITOR-IMAGE-PREVIEW-MOBILE-01) (44bfaf6)
- 安卓相册保存路径使用 Environment.DIRECTORY_PICTURES (13a07eb)
- 修复编辑器图片间距与换行兼容 (EDITOR-IMAGE-LAYOUT-01) (1c60ac3)
- 分享页图片缩放调试日志 (d86804b)
- 增强分享页图片 width 链路排查日志 (SHARE-IMAGE-LIGHTBOX-01.4) (db258f9)
- 添加分享页图片缩放排查日志 (SHARE-IMAGE-LIGHTBOX-01.4) (0f615f8)
- 修复分享页图片缩放源数据丢失问题 (SHARE-IMAGE-LIGHTBOX-01.3) (e61d484)
- 修复分享页 Markdown 图片缩放未生效 (SHARE-IMAGE-LIGHTBOX-01.2) (90b7325)
- 修复分享页图片缩放尺寸未生效 (SHARE-IMAGE-LIGHTBOX-01.1) (f735be1)
- 分享页图片按缩放尺寸显示并支持预览 (SHARE-IMAGE-LIGHTBOX-01) (c85aa9c)
- ???????????? (TASK-CALENDAR-FEED-UX-01) (b35453d)
- ???????????????? (AUTH-FIRST-CHANGE-LOOP-01) (c2a58e3)
- ????????????????? (TASK-QUICKADD-IMAGE-01) (249b73b)
- ????????? i18n hotfix (NOTE-IMAGE-EXPORT-01.1) (c8af5ff)
- 修复待办日历订阅多语言显示 (I18N-CALENDAR-FEED-01) (3425f60)
- ???????????????????? (BUG-TALK-FILTER-UI-01) (1076cdf)
- DiaryEditor 补回 cameraInputRef + DiaryCard forwardRef 修复 (dce654d)
- 补回 DiaryCenter 缺失的 calendarOpen state 声明 (181642b)
- 补回 EditorPane 缺失的 buildAiContext/extractFinalAnswer 导入 (6de024a)
- complete inline note context menu actions (d579df8)
- expose latest context menu target (91f9c20)
- 移动端抽屉导航后自动关闭 (MOBILE-DRAWER-CLOSE-01) (1a87d8c)
- 待办移动端遗漏交互补丁 (TASK-MOBILE-UX-01.1) (d3201e8)
- 已初始化实例隐藏默认账号提示 (AUTH-LOGIN-DEFAULT-CREDS-01) (0fd885d)
- 草稿清空时释放已上传媒体 + 移除 BOM (DIARY-DRAFT-01.1) (32db2c3)
- 筛选空状态与心情筛选交互优化 (DIARY-TIMELINE-FILTER-01.1) (8b51ed3)
- 编辑器多文件选择时混发漏检 (DIARY-EDITOR-MEDIA-01.2) (3701679)
- DiaryEditor addFiles 编译错误 + 逻辑修正 (DIARY-EDITOR-MEDIA-01.1) (2fb843d)
- 移除 DiaryEditor 中重复的 input refs 声明 (3a52540)
- VideoBlock 错误占位 React 化 + i18n (DIARY-VIDEO-RANGE-01.1) (ebd88f7)
- 文件存储国际化与Diary路由修复 (5abe992)
- normalize English locale encoding (afec86b)
- ignore stale notebook note fetches (92a3ce9)
- **tasks**: V1.2.1 待办功能修正——截止时间拆分、自定义提醒、子任务拖拽排序、按截止时间排序 (8d0e6d8)

### ♻️ 重构

- 折叠笔记右键菜单导出项 (CONTEXT-MENU-COMPACT-01) (395951f)

### 📝 文档

- finalize PDF/DOCX folder sync documentation (DESKTOP-FOLDER-KB-SYNC-02-Z) (855d7bb)
- desktop folder sync documentation and MVP sign-off (DESKTOP-FOLDER-KB-SYNC-01-Z) (582357a)

### 💄 样式

- 表格单元格默认水平垂直居中 (EDITOR-TABLE-CELL-CENTER-01) (d8b9cdb)

### 🔧 其他

- clean up MarkdownEditor header comment encoding (MARKDOWN-EDITOR-CLEANUP-01) (b9987d6)
- 移除最近提交中的 UTF-8 BOM (ca97d74)
- 清理分享页图片调试日志 (6f57cab)
- remove temporary mobile layer stack workflow (9848048)
- trigger mobile layer stack auto fix (05cb80a)
- add temporary workflow for mobile layer stack fix (955f2f4)
- remove temporary auto fix workflow (afbc17b)
- trigger notebook tree note menu auto fix (be3fabc)
- add temporary auto fix workflow for notebook tree note menu (410f1fd)
- remove duplicate comment in DiaryCenter (fe0c809)

### 📌 杂项

- 优化：接入长笔记AI上下文预算与分块处理 (AI-LONG-NOTE-CONTEXT-01) (96d7e10)
- 优化：新增长笔记AI上下文构建工具 (ebad1d4)
- 新增：AI推理输出清洗工具 (176e11b)
- 修复：清洗AI推理输出并忽略reasoning流 (43e6a14)

### ✨ 新增

- Android 导出图片保存到相册，导出的 PNG/JPG 文件会自动写入系统相册方便查看和分享 (NOTE-IMAGE-EXPORT-02)
- 移动端编辑器支持单张图片保存到相册，长按或点击图片即可一键保存 (NOTE-EDITOR-IMAGE-SAVE-01)
- 笔记列表支持隐藏更新时间显示，在设置中可切换是否展示每条笔记的最后更新时间 (NOTE-LIST-TIME-VISIBILITY-01)
- 表格单元格默认水平和垂直居中对齐，新插入的单元格内容自动居中显示 (EDITOR-TABLE-CELL-CENTER-01)
- 附件按上传年月自动分目录存储，新增的附件会存入 `年/月` 子目录，便于管理和备份 (ATTACHMENT-STORAGE-DATE-PATH-01)

### 🐛 修复

- 修复孤儿清理机制可能误删待办任务中图片附件的问题，清理前增加引用检查 (TASK-ATTACHMENT-ORPHAN-CLEANUP-01)
- 修复删除笔记或清空回收站后其他设备不同步的问题，跨端删除操作现在能实时同步 (SYNC-DELETE-01-B)
- 修复树形目录右键菜单点击 PNG/JPG 导出时无响应的问题 (NOTE-IMAGE-EXPORT-01.2)
- 修复搜索结果偶尔误报无关内容的问题，提高搜索结果准确性 (f0628f7)
- 过滤 AI 回复中的思考过程内容，避免用户看到模型内部推理细节 (507c365)
- 笔记本分享链接支持撤销，分享者可随时取消已生成的分享链接 (566fbcf)
- 修复思维导图使用滚轮缩放时缩放方向和灵敏度异常的问题 (4d4ea94)
- 回收站中的笔记自动锁定，禁止编辑、收藏和加锁操作，防止误操作恢复被删内容
- 修复偶发的笔记内容被意外清空问题，增强编辑器内容保护机制 (d414eb2)

### v1.2.1 - 2026-06-16

### ✨ 新增

- **tasks**: 增加待办任务详情描述（TASK-DESC-01） 背景/目标：当前待办任务仅保留标题，缺少更完整的上下文与验收说明。本次变更为任务引入 description 字段，用于记录步骤、备注、验收标准等详细信息，不扩展富文本与协作功能。 主要变更：数据库：在 backend/src/db/migrations.ts 新增 v28 迁移 tasks-add-description，通过 PRAGMA table_info(tasks) 检查并执行 ALTER TABLE tasks ADD COLUMN description TEXT NOT NULL DEFAULT ''，保持幂等，旧任务自动兼容。后端接口：在任务创建流程写入 description；在任务更新流程支持 description 更新（含清空）；重复任务生成时复制 description；模板相关路径同步透传 description。类型：为 Task 新增 description: string，为 TaskTemplateItem 新增 description?: string，前端统一使用 task.description ?? '' 兼容历史数据。详情面板：在 TaskDetailPanel 新增纯文本 textarea，支持多行输入，onBlur 保存并保留本地输入；新增成功/失败提示文案。列表与看板：FlatTaskRow、TaskTreeRow、TaskBoardView 增加轻量摘要，避免打断紧凑布局。搜索：将任务检索范围扩展到 title 与 description，不改变现有搜索入口。国际化：补充 tasks.fields.description、tasks.fields.descriptionPlaceholder、tasks.toast.descriptionUpdated、tasks.toast.descriptionUpdateFailed，并对齐 en/zh-CN。测试：新增 task-description、taskSearch、TaskTemplateEditor 相关测试，补齐测试 mock 中 description 字段。 验证：frontend tsc/vite build 通过；frontend test 通过；backend build:tsc 通过；任务描述相关后端与前端测试通过。 (e06dfdf)
- Phase 7.1.1 空状态 + 操作反馈 + 重试按钮 (9667ab2)
- Phase 6.4 轻量自动化提醒 — 依赖完成通知、逾期每日提醒 (267958a)
- Phase 6.2 轻量提醒操作 — 稍后提醒、关闭/开启提醒、跳转任务 (450c289)
- Phase 6.1 提醒中心增强 V1 (26194a5)
- Phase 5 - 甘特图 / 时间轴 V1 (cde9c29)

### 🐛 修复

- Phase 7.1.0 P0 清理 — 通知文案 i18n + BOM 清理 (69e7d6e)
- Phase 6.4.1 自动化提醒稳定化 — 依赖全部完成才通知、dueAt 用 JS 时间比较 (aae9ae8)
- Phase 6.2.3 补齐 TaskReminder.snoozedUntil 类型 (a668eed)
- Phase 6.2.2 snoozedUntil 后端接线修复 — PUT 写入、SELECT 扫描、测试补齐 (33b1feb)
- Phase 6.2.1 提醒操作稳定化 — snoozedUntil 字段、可靠 snooze、button 嵌套修复 (cae5e8d)
- Phase 6.1.1 提醒中心 Electron 环境识别与 offset 国际化 (5b0adde)
- Phase 5.0.1 - 甘特图/时间轴稳定化 (0a998af)
- Phase 4.7.1 - 任务模板稳定化 (84bf28f)

### 🔧 其他

- **repo**: 同步本次会话中的其他本地改动 背景/目标：在完成 TASK-DESC-01 后，一并提交剩余本地工作区改动，便于代码库保持整洁。 主要变更：新增/更新 shareOutline、ShareOutline、ReminderCenter、DiaryCenter、SharedNoteView、taskTitleTokens 及其测试产物；补充 docs/screenshots 与 .playwright-mcp 相关记录文件。 验证：在提交前已确认 TASK-DESC-01 单独完成提交，本次提交仅包含与任务详情描述无关的其余本地改动。 (7dd4437)

### 📌 杂项

- Phase 6.0.2: add TaskReminder.updatedAt to frontend type (3c4829e)
- Phase 6.0.1: reminder type + test fixes (e2d5877)
- Phase 6.0: reminder infrastructure stabilization (d98ccf6)
- Phase 5.5.1: cascade delete cleanup for task_dependencies on child task removal (455ac38)
- Phase 5.5: task center regression + tech debt cleanup (a90a1e3)
- Phase 5.4: dependency-driven lightweight reschedule suggestions (8ba21f0)
- Phase 5.3: dependency status indicators - blocked task visual hints (e41979c)
- Phase 5.2.1：任务依赖线稳定化 hotfix — 修复 6 个 P0/P1 (f5427e7)
- Phase 5.2：任务依赖线 V1 — 数据模型 + 循环检测 + 甘特图依赖线 + 详情面板管理依赖 (c8e1488)
- Phase 5.1：甘特图体验增强 — resize 调整日期范围 + 跨区间显示 + 一键排期 + today 指示器修复 + BOM/编码清理 (dd9f8ce)

### v1.1.20 - 2026-06-12

### ✨ 新增

- Phase 4.7 - 任务模板 V1 (84c92c4)
- Phase 4.6 - AI 拆任务 (f4bee48)
- Phase 4.5 - 重复任务 (f161c89)
- Phase 4.4 - 日历拖拽改截止日期 (7bd2ea5)
- Phase 4.3 — 任务日历视图 (a153357)
- Phase 4.2 — 项目编辑弹窗、移动端项目选择、看板拖拽、卡片增强 (bd9defe)
- 补充 v22 迁移 — task_projects 表 + tasks 新增 projectId/status 字段（Phase 4 数据层遗漏修复） (c6cb7a3)
- Phase 4 - task projects, kanban board view, status field, project sidebar (7d740bb)
- frontend reminder system (b6fe42b)
- **编辑器**: 选区气泡菜单增强——复制、全选、手机号拨号、URL 识别、横向滚动 (84b6f76)
- **textActions**: 新增文本动作识别工具库，支持手机号拨号和 URL 检测 (4b3fbdb)
- Phase 4 — 搜索、快捷键、批量操作、拖拽排序 (c2db189)
- 任务中心 Phase 3 — 提醒系统 (1ffc575)
- 任务中心 Phase 2 — 截止时间精确到分钟 + 倒计时 (813ba68)
- 任务中心 Phase 1.5 — 子任务快捷新增、删除确认、详情子任务列表、父任务路径 (cd16252)
- 任务中心 Phase 1 — 顶部概览、树形任务、进度条、详情进度 (45b44d7)

### 🐛 修复

- 修复 FlatTaskRow.tsx 编码损坏导致构建失败 (da530a0)
- 修复 6 个 TypeScript 编译错误 (860f44f)
- Phase 4.6.1 - AI 拆任务稳定化 (fa6a362)
- **AI思维导图**: 修复 AI 返回思考过程导致 Mermaid 解析失败的问题 (5acd442)
- Phase 4.5.2 - 重复任务收口 (4b0c008)
- Phase 4.5.1 - 重复任务 hotfix (e1c6fd5)
- 任务中心多语言修复 (f125cee)
- Phase 4.4.3 - 拖拽成功后 loadTasks 刷新筛选视图 (aec282f)
- Phase 4.4.2 - 拖拽后筛选刷新、BOM清理、注释修正 (4e59ac9)
- Phase 4.4.1 - 日历拖拽稳定化 (515904a)
- Phase 4.4 hotfix - 修复嵌套函数和缺失 prop (bcddcc8)
- Phase 4.3.1 - 日历逾期统一、英文日期格式、空日期状态 (c442575)
- Phase 4.2.2 — MobileProjectPicker 打不开、移动端新建项目旧 state、看板 dueAt-only 逾期 (1b3eb19)
- Phase 4.2.1 — 移动端项目入口接入、工作区切换刷新、看板逾期判断、拖拽保护 (96ea808)
- Phase 4.1.1 — status 枚举校验、批量完成同步、批量删除 descendants、工作区切换刷新项目 (5cd94cf)
- Phase 4.1 — 项目绑定/权限/状态同步/计数刷新全面修复 (6c4ac43)
- overdue filter and stats use datetime precision for dueAt (7ab46b0)
- Phase 3.5 stability audit - reminder auth, overdue precision, notification status (3e006d8)
- **EditorPane**: 修复移动端按钮 title 乱码和乱序问题 (44b6746)
- tasks INSERT VALUES 缺少 dueAt 占位符（9 values for 10 columns） (2f3f37d)
- migration v20 dueAt 列探测失败 — 改用 PRAGMA table_info 安全检测 (0cf18d3)
- migrations.ts 模板字符串丢失反引号导致后端构建失败 (4ddb9e2)
- 任务中心 Phase 1 全面修复 — 删除子任务、orphan 绑定、循环依赖、逾期判断、后端防护 (d7a916b)
- 任务中心 Phase 1 审查修复 — 删除子任务残留、状态同步、循环防护 (f74a9f0)

### ✅ 测试

- Phase 3.5 - taskProgress, DateBadge, reminder scanner unit tests (8b4e0b9)

### v1.1.19 - 2026-06-11

### ✨ 新增

- **前端**: 思维导图标记和主题名称支持多语言 i18n (8f46744)
- add notebook-first collaboration with hidden workspace UX (e6875a1)
- **mindmap**: 侧边栏搜索框旁增加收藏筛选按钮 (df89085)
- **mindmap**: 新建文件夹按钮移到列表顶部 (ccc6425)
- **mindmap**: 文件夹右键菜单 - 重命名/删除 (37313a7)
- **backend**: 新增导图移动到文件夹的 PATCH /:id/move 路由 (770b062)
- **mindmap**: 支持拖拽导图到文件夹 (4213873)
- **mindmap**: 导图模板功能 - 新建导图时可选择预设模板 (09f7f17)
- **mindmap**: 文件夹树前端 UI (1adf85a)
- **mindmap**: 文件夹树后端 + 数据模型 (124562f)
- **mindmap**: 节点聚焦模式 (9c0ed1a)
- **mindmap**: 拖拽节点调整结构 (044cb67)
- **mindmap**: 收藏导图功能 (f1868bd)
- **mindmap**: 节点复制/剪切/粘贴 (a272d4f)
- **mindmap**: Ctrl+滚轮鼠标位置缩放 + 节点搜索 + 列表搜索 (7ffe9eb)
- **mindmap**: 支持 Ctrl+Click 多选节点 (0f0f462)
- **mindmap**: 思维导图模块 5 阶段增强 (e8f3c66)
- **mindmap**: 新增全屏编辑模式 (db3ae8b)
- **mindmap**: 新增添加同级节点 + 快捷键 + 选中节点置顶渲染 (5348b85)
- **mindmap**: 新增 mindmapTransform.ts 独立解析器 (8255b65)
- **editor**: MermaidView 工具栏增强 + MindMapEditor 事件监听 + 编辑器 appendMarkdown (03e7782)
- **ai**: AIChatPanel 支持笔记本级 RAG 作用域 (9a3a4a3)
- **ai**: EditorPane 新增 AI 总结、AI Mermaid、保存为思维导图 (8effbf2)
- **ai**: 前端 API 扩展 + i18n + NoteEditorHandle 类型增强 (54a7b26)
- **ai**: 后端 AI 路由改造 + 笔记本级 AI 端点 (f81d0b8)
- **ai**: 新增 AI Client 适配层，统一 stream/non-stream 调用 (c1e182d)

### 🐛 修复

- **前端**: NoteList 补回 confirm 导入，修复 tsc -b 构建错误 (182c698)
- **前端**: 修复6个TypeScript编译错误 — import缺失、path字段缺失、函数未导出 (76721f1)
- **前端**: 补回缺失的 diagnoseConnection 导出函数，修复 vite build 失败 (bb765a6)
- **Electron**: setupWindow 和 waitForRemoteReady 支持反代路径前缀 (142c990)
- **前端+后端**: 服务器地址支持反代路径、修复Windows频闪、新增连接诊断 (4442716)
- **前端**: 浮动操作条按钮添加细微边框增强轮廓感 (7cb9e70)
- **前端**: 思维导图标记菜单改用带颜色SVG图标，与节点显示一致 (1014ca0)
- **前端**: 浮动操作条按钮增强可见性 — 加深背景色、加粗文字、加大点击区域 (98fbff7)
- **backend**: 修复 mindmaps 相关路由 TypeScript 编译错误 (174f668)
- **mobile**: 修复移动端回收站一键清空按钮无响应 (1f2fb74)
- **mindmap**: 文件夹数量跟随收藏/搜索筛选动态更新 (380d594)
- **i18n**: 修复文件夹右键菜单中文翻译乱码 (e38650f)
- **i18n**: 修复导图模板中文翻译乱码 (42b1d73)
- **backend**: requireWorkspaceFeature 中间件正确放行 personal 空间请求 (a0c4947)
- **backend**: 修复 personal workspaceId 传入时文件夹和导图 API 返回 403 的问题 (164b8d8)
- **mindmap**: Ctrl+滚轮缩放改为原生事件，阻止浏览器页面缩放 (fe67b0f)
- **mindmap**: 修复 FloatingToolbar 定位偏移 (9f4ccc3)
- **mindmap**: 修复数据风险 + UI 扁平化 + 代码拆分 (a789add)
- **mindmap**: 适应视图图标改为 Scan，与全屏 Maximize2 区分 (d988ec1)
- **i18n**: 补全思维导图多语言文案 (ffc33cd)
- **ai**: 标题生成字数限制从10改为20，避免AI输出被截断 (8dfcb05)
- **mindmap**: 保存为思维导图后可靠跳转 + 使用独立解析器 (caff2d6)
- **ai**: 修复 RAG 向量召回未传 notebookIds + /ask 复用 ai-client (9061916)
- **build**: 修复 vite 构建循环 chunk 错误 (9d81de3)

### ♻️ 重构

- **前端**: 思维导图样式收尾 — indigo→blue统一、transition补齐、菜单背景token化、模板弹窗圆角与阴影优化 (e0db228)
- **前端**: 思维导图悬浮状态与创建按钮样式统一收敛 (ef81bea)
- **前端**: 思维导图菜单与激活态样式继续收敛 (dec1717)
- **前端**: 思维导图模块 macOS 风格样式重构 (87a48b3)

### 📝 文档

- 添加完整官网教程体系（47篇教程 + 索引 + 规划） (210f537)

### v1.1.18 - 2026-06-09

### ✨ 新增

- 更新Android组件和Tiptap编辑器功能 (c489050)
- 增强Tiptap编辑器功能并优化用户体验 (ce05f9e)
- 添加鸿蒙ArkWeb原生应用项目 (f63e84f)
- 添加鸿蒙ArkWeb WebView原生适配支持 (f6d4923)

### 🐛 修复

- 移动端Sidebar约束宽度防溢出，移除选择时自动关闭侧边栏的逻辑 (03bb588)
- 移除NavRail点击导航项后自动关闭移动端侧边栏的逻辑 (a429f1a)
- 移动端侧边栏遮罩区分点击/滑动，禁用手势关闭侧边栏，添加overflow-hidden防溢出 (948e447)
- 优化Android WebView选择菜单处理，使用委托模式替代直接返回null (fa20e06)

<!-- CHANGELOG:END -->
