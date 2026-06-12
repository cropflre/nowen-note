# nowen-note

> 自托管的私有知识库，对标群晖 Note Station。
>
> A self-hosted private knowledge base. [English README](./README.en.md) · [作者感言](./AUTHOR_STORY.md) · [在线体验](http://note.nowen.cn/)

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
- 附件对象存储（S3 / R2 / MinIO）：[docs/object-storage.md](./docs/object-storage.md)
- 飞牛 .fpk 应用打包：[scripts/fpk/README.md](./scripts/fpk/README.md)
- ARM64 详解：[docs/deploy-arm64.md](./docs/deploy-arm64.md)
- 邮件备份配置：[docs/backup-email-smtp.md](./docs/backup-email-smtp.md)
- 编辑器模式切换：[docs/editor-mode-switch.md](./docs/editor-mode-switch.md)
- 隐私策略：[docs/PRIVACY.md](./docs/PRIVACY.md)
- OpenAPI：运行后访问 `/api/openapi.json`

> 📚 **教程中心**：[docs/tutorials/](./docs/tutorials/) — 从快速上手到高级功能的完整教程

- **快速上手**：[5 分钟快速上手](./docs/tutorials/quick-start.md) · [界面概览](./docs/tutorials/ui-overview.md) · [创建第一篇笔记](./docs/tutorials/first-note.md)
- **笔记管理**：[文档树/笔记本](./docs/tree-tutorial.md) · [标签和收藏](./docs/tutorials/tags-favorites.md) · [搜索](./docs/tutorials/search.md)
- **编辑器**：[富文本编辑器](./docs/tutorials/editor-rich-text.md) · [Markdown 编辑器](./docs/tutorials/editor-markdown.md) · [斜杠命令](./docs/tutorials/slash-commands.md)
- **AI 功能**：[AI 配置](./docs/tutorials/ai-setup.md) · [AI 生成标题和标签](./docs/tutorials/ai-title-tags.md) · [AI 总结](./docs/tutorials/ai-summary.md)
- **思维导图**：[入门](./docs/tutorials/mindmap-intro.md) · [从笔记生成](./docs/tutorials/mindmap-from-note.md) · [导出](./docs/tutorials/mindmap-export.md)
- **部署**：[Docker](./docs/tutorials/docker-deploy.md) · [NAS](./docs/tutorials/nas-deploy.md) · [备份与迁移](./docs/tutorials/backup-migrate.md)

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

### v1.1.17 - 2026-06-08

### ♻️ 重构

- 大规模代码精简和架构优化 (60f051b)

### v1.1.16 - 2026-06-05

### ✨ 新增

- 全面增强搜索功能和用户体验 (524cf8c)
- 增强搜索体验和侧边栏布局管理 (14b61c2)
- 增强附件对象存储功能和搜索高亮显示 (7ce7d53)

### 🐛 修复

- 修复 TypeScript 编译错误 - Buffer 类型兼容性 (ff2f4b5)
- 全面优化版本恢复功能和编辑器状态管理 (85783d1)
- 优化侧边栏布局计算和滚动性能 (5e49465)

### 📌 杂项

- 实现对象存储支持和同步中心功能 (d576ec1)

<!-- CHANGELOG:END -->
