# nowen-note 架构分析与改造方案

> 分支: `dev-nowen` | 基座: `nowen-note v1.2.3` (cropflre/nowen-note)
> 日期: 2026-06-26

---

## 一、现状架构分析

### 1.1 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 后端 | Hono 4 (Node.js) + TypeScript | 轻量 Web 框架, better-sqlite3 |
| 前端 | React 18 + Vite 5 + Tiptap 3 + Tailwind | 富文本/Markdown 双引擎 |
| 数据库 | SQLite (WAL) + FTS5 + sqlite-vec | 全文搜索 + 向量检索 |
| 集成层 | MCP Server + TypeScript SDK + CLI + OpenAPI | 外部工具接入 |
| 客户端 | Web + Electron + Android (Capacitor) + Harmony | 多端覆盖 |

### 1.2 核心数据流 (当前)

```
用户编辑 (富文本/MD)
    ↓
notes.content (JSON/MD) ← 主存储
notes.contentText (纯文本) ← 供 FTS5 搜索
    ↓
notes_fts (FTS5 虚表) ← 触发同步
note_embeddings (向量) ← embedding-worker 异步写入
vec_note_chunks (sqlite-vec虚表) ← Phase 2 接入
```

**结论**: 当前是 **DB-as-Source-of-Truth** 架构。notes 表是笔记内容唯一权威来源。

### 1.3 数据库核心表

| 表 | 说明 |
|---|---|
| `notes` | 主表, `content`(json/md), `contentText`(纯文本), `contentFormat`(tiptap-json/markdown/html) |
| `notebooks` | 无限层级, 支持 soft-delete |
| `notes_fts` | FTS5 虚表, 同步触发器 |
| `note_embeddings` | 向量存储, JSON 序列化 |
| `vec_note_chunks` | sqlite-vec 虚表 |
| `tags` / `note_tags` | 多对多标签 |
| `tasks` | 待办, 支持优先级/截止/子任务 |
| `folder_sync_files` | 文件→笔记映射表 |
| `attachments` | 附件元数据 |
| `workspaces` / `workspace_members` | 工作区/协作 |
| `diaries` | 说说/动态 |
| `backups` | 备份元数据 |

### 1.4 已具备的能力 (复用清单)

```
✅ SQLite FTS5 全文搜索 (notes_fts + 触发器)
✅ sqlite-vec 向量扩展 (动态加载, 降级到 BM25)
✅ Embedding worker (异步队列, AI provider 配置)
✅ MCP Server (15+ tools: 笔记/搜索/AI 问答/标签/备份等)
✅ TypeScript SDK (完整 REST 封装)
✅ CLI 工具 (Commander 框架)
✅ OpenAPI 文档 (/api/openapi.json)
✅ Webhook 系统 (事件驱动)
✅ API Token (nkn_ 前缀长期凭证)
✅ JWT 认证 + 会话管理
✅ 备份/恢复 (full: db+attachments+fonts+plugins+jwt)
✅ 增量 auto_vacuum (回收空间)
✅ Audit 审计日志
✅ 附件管理系统 (base64 抽取/缩略图/对象存储)
✅ PDF/DOCX 文本提取 (folder-sync)
```

### 1.5 关键差距 (需改造)

```
❌ DB 是唯一真相源 → 需改为: MD 文件是唯一真相源, DB 为投影
❌ 无后台 MD 文件扫描器 (scanner + watcher)
❌ 无 DB→MD 反向导出 (当前只有 Electron folder-sync 的 MD→DB)
❌ 无标准 Markdown 目录结构约定
❌ 无 frontmatter 规范 (tags/aliases/title/date 等在 MD 文件头)
❌ 无双向同步 + 冲突检测
❌ 无 Hermes 自动化全链路 (仅 MCP Server 已就绪)
❌ 无 AI 自动摘要/标签/双链功能
❌ DB 不可丢弃重建 (因为没有"从 MD 重建"的完整流程)
```

---

## 二、改造架构设计

### 2.1 核心理念

```
单 向 可 信 链    MD 文件 → SQLite 投影
================    ====================
只允许: 文件系统 → 读取 → 解析 → 写入 DB
禁止:    DB 内容 → 写入文件系统 (除非显式导出)
         DB 内容 → 修改文件系统已有文件

可丢弃性: SQLite 库随时删, 扫描器重跑即可重建全部索引
```

### 2.2 标准 Markdown 目录结构

```
~/notes/                            ← 根目录 (配置化, 可自定义)
├── 01-日记/                        ← 命名空间: 日期前缀或序号
│   ├── 2026/                       ← 按年/月组织
│   │   ├── 06/
│   │   │   ├── 2026-06-26.md       ← 日记文件名 = 日期
│   │   │   └── 2026-06-27.md
├── 02-知识库/                      ← 笔记本映射
│   ├── 编程/
│   │   ├── TypeScript/
│   │   │   ├── 类型系统.md         ← 笔记文件
│   │   │   └── 泛型进阶.md
│   │   └── Rust/
│   │       └── 所有权.md
│   └── 摄影/
├── 03-待办/                        ← 任务池 (可选)
│   ├── 项目A.md
│   └── 购物清单.md
├── 04-索引/                        ← 自动生成的 MOC 文件
│   ├── _tags.md                    ← 标签索引
│   ├── _backlinks.md               ← 双链索引
│   └── _unlinked.md                ← 孤立笔记
├── attachments/                    ← 附件 (图片/PDF 等)
│   └── 2026/
│       └── 06/
│           └── abc123.png
└── .nowen/                        ← 元数据目录
    ├── config.yaml                 ← 同步配置
    └── scan-state.json             ← 扫描状态 (游标/SHA256)
```

### 2.3 Frontmatter 规范

每篇 Markdown 文件以 YAML frontmatter 开头:

```yaml
---
title: 笔记标题
created: 2026-06-26T10:00:00+08:00
updated: 2026-06-26T14:30:00+08:00
tags: [typescript, 编程, 笔记]
aliases: [不用的标题A, 旧标题B]
id: uuid-v4                          # 可选, 用于双链稳定性
notebook: 编程/TypeScript             # 可选, 覆盖目录映射
pinned: false
archived: false
source: https://example.com          # 来源链接 (AI 摘要入库)
summary: 这篇文章主要讲解了...       # AI 自动摘要
---
```

### 2.4 改造后的单向数据流

```
[文件系统] ← 唯一真相源
    │
    ├─ 扫描器 (Scanner) ───────────────────────┐
    │   ├─ 首次: 全量扫描目录树                    │
    │   ├─ 增量: 监听 fsnotify/chokidar          │
    │   └─ 定时: 间隔轮询 (兜底)                  │
    │                                            │
    ▼                                            ▼
[解析层]                                     [nowen-note DB]
    ├─ frontmatter 解析 → 元数据               ├─ notes 表 (投影)
    ├─ body 解析 → contentText                 ├─ notes_fts (FTS5)
    ├─ [[双链]] 解析 → 引用关系                  ├─ note_embeddings (向量)
    ├─ #标签 解析 → tags                       ├─ vec_note_chunks
    ├─ [x] 任务 解析 → tasks                   ├─ tags / note_tags
    ├─ 附件引用解析 → attachments               ├─ tasks
    └─ SHA256 校验 → 增量更新                   ├─ backlinks (新)
                                               └─ 所有 DB 表均可删除重建
                                                       ↑
                                        [Hermes Agent]
                                          ├─ MCP Client (原生)
                                          ├─ nowen-mcp (MCP Server)
                                          ├─ nowen-sdk (TypeScript)
                                          ├─ nowen-cli (Shell)
                                          └─ Webhook (事件回调)
```

---

## 三、实施路线 (三期)

### 第一期: 私有部署 + MD↔DB 单向投影 + 基础 AI 写入

| # | 任务 | 交付物 | 依赖 |
|---|---|---|---|
| P1.1 | Docker 私有部署验证 | 本地 `docker-compose up` 跑通, 确认端口/数据卷/备份 | 无 |
| P1.2 | 标准目录结构 + frontmatter 规范建立 | `documents/md-spec.md` 文档 | P1.1 |
| P1.3 | MD 扫描器核心 (Scanner) | `backend/src/scanner/` 模块, 全量扫描目录树→解析 frontmatter+body→写入 DB | P1.2 |
| P1.4 | 增量监听 (Watcher) | chokidar/fsnotify 监听文件变更, 增量更新 DB | P1.3 |
| P1.5 | 双链解析器 | `[[Note Title]]` 语法解析 + `backlinks` 表 | P1.3 |
| P1.6 | 标签/FTS 重建 | 扫描时同步 tags + notes_fts | P1.3 |
| P1.7 | 任务提取 | 从 Markdown 文件中 `- [ ]` / `- [x]` 提取到 tasks 表 | P1.3 |
| P1.8 | MCP Server 扩能 | 增加 `nowen_md_scan`、`nowen_md_rebuild` 等工具 | P1.3 |
| P1.9 | AI 自动摘要入库 | 新文件创建时触发 AI 摘要 → 写入 frontmatter summary | P1.8 |
| P1.10 | AI 自动打标签 | 内容分析 → 建议标签 → 写入 frontmatter tags | P1.8 |
| P1.11 | Hermes 集成: 新建笔记 | Hermes 通过 MCP/SDK 自动新建 Markdown 文件 | P1.8 |

### 第二期: 冲突检测 + 审计 + 备份策略

| # | 任务 | 交付物 | 依赖 |
|---|---|---|---|
| P2.1 | MD ↔ DB SHA256 校验 | 扫描时对比 MD 文件 SHA256 与 DB 记录, 仅更新变更文件 | P1.3 |
| P2.2 | 冲突检测 | 文件修改时间 vs DB 同步时间, 标记冲突 | P2.1 |
| P2.3 | 审计日志增强 | 记录每次扫描的变更集 (新增/修改/删除) | P2.1 |
| P2.4 | NAS 备份策略 | 配置指南: rsync / 坚果云 / 云服务器同步 MD 目录 | P1.2 |
| P2.5 | DB 可丢弃性验证 | 删库 → 重扫 → 全量重建, 验证完整性 | P1.3 |

### 第三期: 近实时同步 + 语义检索 + Hermes 全链路自动化

| # | 任务 | 交付物 | 依赖 |
|---|---|---|---|
| P3.1 | 文件系统实时监听 | chokidar 监听文件变更 → 秒级同步到 DB | P1.4 |
| P3.2 | 语义检索增强 | 扫描时向量化 → sqlite-vec KNN 搜索 | P2.5 |
| P3.3 | Hermes 自动化工作流 | 自动归档/摘要/标签/双链/待办汇总定时任务 | P1.11 |
| P3.4 | Web 端文件编辑 | nowen-note Web 编辑器可选: 保存时同步写回 MD 文件 | P1.3 |
| P3.5 | 性能优化 | 增量扫描的游标/缓存优化 | P3.1 |

---

## 四、本期范围 (第一期细化)

### 4.1 P1.1 Docker 私有部署验证

```bash
cd /home/ubuntu/projects/nowen-note
docker-compose up -d
# 访问 http://localhost:3001
# 默认: admin / admin123
```

**验证点**:
- [ ] 页面加载正常
- [ ] 可以创建笔记本和笔记
- [ ] 数据目录映射正确 (`/app/data`)
- [ ] 备份功能可用
- [ ] MCP Server 可连接

### 4.2 P1.2 标准目录结构 + Frontmatter 规范

产出: `documents/md-spec.md`

详细规定:
- frontmatter 字段定义 (必选/可选)
- 目录命名规则
- 文件名规范
- 双链语法
- 标签语法
- 附件引用格式

### 4.3 P1.3 MD 扫描器 (核心)

**模块设计**: `backend/src/scanner/`

```
scanner/
├── index.ts             ← 入口: scan(), watch(), rebuild()
├── walker.ts            ← 目录遍历 + 文件过滤 (ignore .git/node_modules 等)
├── parser.ts            ← frontmatter + body 解析
├── wikilink.ts          ← [[双链]] 解析器
├── task-extractor.ts    ← - [ ] / - [x] 提取
├── tag-extractor.ts     ← #标签 提取
├── sync-engine.ts       ← DB 写入引擎 (upsert/delete)
├── hash-store.ts        ← SHA256 校验 (增量更新)
└── indexer-cli.ts       ← CLI 入口 (nowen scan / nowen rebuild)
```

**数据流**:
```
Walker → Parser → [Wikilink/Tag/Task Extractor] → Hash-Store → Sync-Engine → DB
```

### 4.4 MCP Server 新增工具

在现有 `packages/nowen-mcp/src/index.ts` 中新增:

| 工具名 | 功能 |
|---|---|
| `nowen_md_scan` | 触发一次全量扫描 |
| `nowen_md_scan_status` | 查看最后一次扫描状态 (时间/文件数/变更量) |
| `nowen_md_rebuild` | 重建全部索引 (清 DB + 重扫) |
| `nowen_md_create_note` | 新建 Markdown 文件 + 写入 DB |
| `nowen_md_list_files` | 查看 MD 文件系统目录结构 |

### 4.5 AI 能力集成

- **自动摘要**: 新笔记入库后, 调用配置的 AI provider (复用现有 `ai-client.ts`) 生成摘要 → 写回文件 frontmatter
- **自动标签**: 分析内容 → 推荐 3-5 个标签 → 追加到 frontmatter tags
- **自动双链**: 扫描 `#标签` 和关键词 → 推荐链接到相关笔记

### 4.6 Hermes 集成方案

Hermes 通过 **nowen-mcp** (MCP Client 原生支持) 直接操作 nowen-note。

配置步骤:
1. 在 Hermes `config.yaml` 中添加 `nowen-mcp` server 定义
2. 注册 cron job 定时执行 `nowen_md_scan` 或 AI 摘要任务
3. 用户通过 QQ 发送消息 → Hermes 解析意图 → 调用 MCP tool 操作笔记

---

## 五、不变范围 (明确排除)

1. ❌ **记账/账务能力** — 由 Beancount/Actual Budget 专用工具承担
2. ❌ **前端 UI 改造** — 沿用 nowen-note 现有 Tiptap 编辑器, 不改写前端
3. ❌ **用户体系改造** — 沿用 nowen-note JWT + API Token 体系
4. ❌ **Electron/客户端打包** — 仅改后端的扫描器和 MCP 层
5. ❌ **富文本→MD 格式转换** — 新建笔记统一走 Markdown, 现有富文本保持不动

---

## 六、技术决策记录

| 决策 | 选择 | 理由 |
|---|---|---|
| 扫描器语言 | TypeScript (与后端一致) | 复用现有 `better-sqlite3` 连接和类型 |
| 文件监听 | chokidar | nowen-note 已引入, 成熟稳定 |
| 双链语法 | `[[Title]]` | Obsidian/Logseq 兼容, 用户习惯 |
| 标签语法 | `#标签` + frontmatter `tags:` | 灵活兼容 inline 和 YAML 两种方式 |
| 任务格式 | `- [ ]` GFM 任务列表 | Markdown 标准, 前端/工具兼容 |
| SHA256 | `crypto.createHash('sha256')` | Node.js 内置, 零依赖 |
| 扫描触发 | API + 定时 + 文件事件 | 灵活, 适应不同部署场景 |
| 冲突策略 | 文件优先 | MD 是真相源, DB 投影必须始终反映文件状态 |
