# nowen-note

> 自托管的私有知识库，对标群晖 Note Station。
>
> A self-hosted private knowledge base. [English README](./README.en.md) · [作者感言](./AUTHOR_STORY.md) · [在线体验](https://note.nowen.cn/)

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/Node-20%2B-green.svg)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED.svg?logo=docker&logoColor=white)](./Dockerfile)

## 功能概览

- **富文本 + Markdown 双引擎**：Tiptap 3 + CodeMirror 6，共享 AI、版本历史、评论等上层能力
- **AI 助手**：支持通义千问 / OpenAI / Gemini / DeepSeek / 豆包 / Ollama，覆盖写作辅助、生成标题、推荐标签、RAG 知识问答
- **知识管理**：无限层级笔记本、彩色标签、任务、思维导图、说说、FTS5 全文搜索
- **协作 & 历史**：分享支持 4 档权限（仅查看 / 可评论 / 可编辑 / 可编辑需登录）+ 访客留言 + 密码 / 有效期、版本回溯
- **文件管理**：图片缩略图（webp 三档自适应，密集图床场景流量降至 1/100）、「我的上传」分类（已引用 / 未引用细分）、孤儿清理
- **自动化**：沙箱插件系统、Webhook、审计日志、定时自动备份
- **多端**：Web / Electron（Win/macOS/Linux）/ Android（Capacitor）
- **开发者生态**：MCP Server、TypeScript SDK、CLI、[浏览器剪藏扩展](https://chromewebstore.google.com/detail/nowen-note-web-clipper/nglkodhfdbnfielchjpkjhenfaecafpg)、OpenAPI 3.0（见 [`packages/`](./packages)）

## 技术栈

React 18 · TypeScript · Vite 5 · Tiptap 3 · Tailwind · Hono 4 · SQLite(FTS5) · JWT · Electron 33 · Capacitor 8

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
| `OLLAMA_URL` | — | 本地 Ollama 地址（可选） |

数据持久化：容器需将 **`/app/data`** 映射到宿主机（不是 `/data`）。镜像已声明 `VOLUME ["/app/data"]`，主流 NAS 面板会自动预填该路径。

备份策略：自动备份默认写入 `/app/data/backups`，与数据在同一个卷。建议按 3-2-1 原则把 `/app/backups` 另挂到独立磁盘，并设置 `BACKUP_DIR=/app/backups`，详见 [`docker-compose.yml`](./docker-compose.yml) 内的注释。

## 文档

- 浏览器剪藏扩展（Chrome / Edge）：[Chrome Web Store](https://chromewebstore.google.com/detail/nowen-note-web-clipper/nglkodhfdbnfielchjpkjhenfaecafpg)
- 部署指南（本地 / Docker / 桌面 / 移动 / 群晖 / 绿联 / 威联通 / 飞牛 / 极空间 / ARM64）：[docs/deployment.md](./docs/deployment.md)
- 飞牛 .fpk 应用打包：[scripts/fpk/README.md](./scripts/fpk/README.md)
- ARM64 详解：[docs/deploy-arm64.md](./docs/deploy-arm64.md)
- 邮件备份配置：[docs/backup-email-smtp.md](./docs/backup-email-smtp.md)
- 编辑器模式切换：[docs/editor-mode-switch.md](./docs/editor-mode-switch.md)
- 隐私策略：[docs/PRIVACY.md](./docs/PRIVACY.md)
- OpenAPI：运行后访问 `/api/openapi.json`

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

<!-- CHANGELOG:BEGIN -->
## 更新日志

> 最近 5 个版本的更新内容，完整历史见 [CHANGELOG.md](./CHANGELOG.md)。

### v1.1.8 - 2026-05-28

### 🐛 修复

- 调整访问控制默认开关 (b49534c)

### v1.1.7 - 2026-05-28

### ✨ 新增

- 优化桌面端云端本地模式与访问控制 (783cf6a)
- **release**: 选项 10 改为'补 upk 到现有 Release'模式（不打新 tag、不升版本） (7e4c626)

### 🐛 修复

- 修复后端实时删除广播编译错误 (22fcc3c)
- improve multi-device note sync (0beb31e)
- **upk**: 补回被上一个 commit 误删的 const found 行 (0e81338)
- **upk**: cp/rm 之前按 resolve(src) 去重，避免重复处理同一文件 (9e95e54)
- **upk**: 递归扫描 .upk 产物，覆盖 ugcli 实际输出路径 build_dir/pkgs/upk/ (49467ff)
- **upk**: 补 upk 模式支持版本复用 + 修 RepoTag 与 compose 不一致 + ugcli 权限自愈 (00de4d9)

### 📝 文档

- **readme**: 添加在线体验入口（note.nowen.cn） (b626b3e)

### 🔧 其他

- 完善发布流程与编辑器设置 (0ae451d)
- update release workflow and editor UI (53c2e4d)

> 🚨 **紧急安全修复**：1.1.6 用户请尽快升级。该版本修复"登录云端账号"迁移功能在
> 同一台后端上误操作导致的**附件物理文件丢失**问题。

### 🐛 修复

- **【数据保护】回收站清空 / 永久删除笔记不再误删被多笔记共享的附件物理文件**
  - 受影响场景：1.1.6 在同一台服务器上点击"登录云端账号"产生双份笔记本后，
    手动删除其中一份并清空回收站，会触发被另一份笔记引用的图片被 unlink。
  - 修复后：批量删除附件文件前会做引用计数检查，仍有活引用的物理文件不会被删，
    与单条 `DELETE /api/attachments/:id` 的行为对齐。
- **【迁移防呆】"登录云端账号"对话框现在会拒绝迁移到同一台服务器**
  - 后端 `/api/version` 返回新增 `serverInstanceId` 字段（首次启动 lazy 写入
    `system_settings`，跨重启稳定）。
  - 前端 MigrationModal 在登录拿到云端 token 后立即比对两端 `serverInstanceId`，
    相同则直接拦截、提示"无需迁移，请退出登录后用新账号登录即可"。
  - 同账号场景（不同实例但本地与云端用户名一致）会弹二次确认，避免误操作。
- **【迁移一致性】附件 hash 去重命中时不再复用旧附件 id**
  - 编辑器上传、内联 base64 抽取、公众号/URL 导入图片在 hash 命中时，会新建一条
    绑定当前笔记的 `attachments` 元数据行，同时复用同一份磁盘物理文件。
  - 迁移引擎层新增 `serverInstanceId` 预检查；即使绕过弹窗直接调用迁移函数，
    也会在写入云端前阻断"本地端 == 云端"的同源迁移。
- **【附件健康检查】新增只读健康报告，帮助定位裂图 / 404**
  - 管理员可在「设置 → 数据管理 → 系统 → 数据库」执行附件健康检查。
  - 报告会列出 `attachments` 行存在但物理文件缺失、正文引用不存在附件 ID、
    以及多行共享同一物理文件的情况。
  - 孤儿清理逻辑同步补强：多条附件行共享同一个 `path` 时，只有最后一个引用消失
    才会删除物理文件，避免清理工具自身误删活文件。
- **【附件修复向导】健康检查结果现在可直接执行基础修复**
  - 对“DB 行存在但物理文件缺失”的附件，管理员可上传替代文件写回原 `path`；
    若多条附件记录共享同一物理文件，会一起恢复。
  - 对“正文引用不存在附件 ID”的悬空引用，管理员可批量从笔记正文中移除坏 URL，
    避免前端继续请求 404。
  - 修复类操作均要求管理员 sudo 二次验证；修复后会自动重新生成健康报告。
- **【多端同步】修复同账号 PC/Web 与手机端当前笔记不同步的问题**
  - 实时更新不再按 `userId` 过滤同账号其它设备，只按 `connectionId` 排除当前连接回声。
  - PC/Web 保存后会向同账号其它连接广播轻量列表更新，手机端停留在列表或当前笔记时都能立即看到变更。
  - 当前笔记无本地未保存修改时会自动拉取并应用远端新版本；本地也有修改时进入冲突横幅。
  - 正文保存遇到 `409 VERSION_CONFLICT` 不再盲目重放旧内容覆盖远端，而是保留本地草稿，提示用户选择“重新加载”或“覆盖远端”。
  - 移动端前台恢复、联网恢复、WebSocket 重连时会主动补查当前笔记版本，补偿后台期间漏掉的实时消息。

### ⚠️ 影响范围与建议

- 仅 1.1.6 用户受影响。1.1.5 及更早版本没有"登录云端账号"功能，无此风险。
- **如果你已经丢失图片**：先检查 NAS 快照 / 备份；该场景下数据库行可能仍在，
  但物理文件已被 unlink，应用层无法凭空恢复原图。升级后可先运行"附件健康检查"，
  再对缺失项上传从备份或其它来源找回的替代文件；找不回的悬空引用可在修复向导中移除。

### v1.1.6 - 2026-05-26

### ✨ 新增

- **release**: 将绿联 .upk 从一键全量(选项5)中移除，独立到选项10 (78bbdf6)
- **notes**: 支持客户端生成的 UUID 作为笔记 ID（离线创建） (c8d8961)
- **login**: 登录页支持桌面端跳过登录直接用本地 (21c9183)
- **migration**: 本地→云端账号一键迁移（D-2/D-3 + 回滚） (f61a6a9)
- **local-mode**: 本地模式离线读 + 同步引擎 + localStore (660489a)
- **desktop**: Electron 桌面端框架 + 内嵌后端启动 (762e6b0)
- **attachment-preview**: 视频/音频按扩展名兜底 + 抽屉打开时隐藏链接气泡 (33d6c61)
- **editor-mobile**: 移动端顶栏改 iOS 风双行结构 + 桌面面包屑末段截断修复 (235db1f)
- **frontend**: add video embed extension and rich-text video URL support (b8e3493)
- **editor**: auto-convert '- [ ] ' / '- [x] ' to task list (5c9a916)
- **login**: add demo mode banner with one-click credential fill (0a0c271)
- **auth**: 新增体验账号(isDemo) 机制 (8e0ab8a)
- **url-import**: 公众号文章一键导入笔记 (d6c7c17)

### 🐛 修复

- **release**: multi 模式 upk 打包前 buildx --load 各架构镜像 (7cceed0)
- **editor**: TiptapEditor 桌面端样式/行为微调 (7b72d7d)
- **mac-build**: 单架构构建 + .node 魔数 arch 校验，修复 Intel Mac ERR_DLOPEN_FAILED (54a9c90)
- **release**: defer UPK_IMAGE_REF assembly until VERSION is finalized (80390c9)
- **upk**: 改进多架构镜像查找逻辑，支持 DOCKERHUB_REPO 环境变量 (cc57a7f)
- **VideoExtension**: 修正 NodeView props 类型为 ReactNodeViewProps，修复 tsc 报错 (1083377)
- 绿联nas 构建包 (eb15be2)
- **clipper**: split footer build for markdown branch to preserve source link (45402e8)
- **update-notifier**: move useCallback before early return to fix hook order (63f2624)

### 📝 文档

- **readme**: 补 macOS 首次打开 ERR_DLOPEN_FAILED 的 xattr 解隔离指引 (bf108cd)
- **readme**: sync features and changelog with Unreleased (e301e93)

### 📦 构建

- **upk**: 新增绿联 NAS 应用包(.upk) 打包流程 (967d00d)

### 🔧 其他

- **clipper**: release v0.1.3 (5d70c08)

### v1.1.5 - 2026-05-21

### ✨ 新增

- **attachments**: 附件预览抽屉 + 本笔记附件目录面板 (df2e06f)
- **editor**: 搜索替换面板 / docx 自研解析与导入 / 字号弹层优化等 (3a37905)
- **about**: 新增'作者感言'板块及阅读弹窗 (82e872d)

### 📝 文档

- **readme**: add Author's Note link in header (6e5d863)

### v1.1.4 - 2026-05-20

_本版本无可展示的 commit 变更（可能全部是合并 / 工作流修改）_

<!-- CHANGELOG:END -->
