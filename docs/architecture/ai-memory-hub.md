# AI Memory Hub v1.6.0 — Phase 0 架构审计

日期：2026-11-05。开发基线：`release/v1.6.0` 的 `861c4d2a5`；隔离分支：`codex/ai-memory-hub-v160`。当前主工作区的 Word 粘贴、日记 Token 等未提交修改不属于本任务。

## 本轮交付与顺序

先实现 Phase 1–3 原始对话归档 MVP：ChatGPT 当前可见对话手动保存、ChatGPT/豆包明确授权后的增量保存、历史文件预览及批量导入。Phase 4 长期记忆、Phase 5 上下文交付、Phase 6 更多平台与正式验收依赖基础归档稳定；界面和文档必须把这些计划与实际能力分开。

用户要解决的是对话分散、难以迁移和重复提供背景。首先可靠保存原始证据，长期记忆须另经用户确认。外部会话不会写入内置 `ai_chat_conversations`，也不会创建第二套笔记或认证系统。

1. 审计与协议冻结 → 检查现有入口、认证、存储、迁移及同步边界。
2. 手动/自动采集 → 受控 DOM Fixture、幂等事务、权限拒绝与精确回执测试。
3. 历史导入 → 官方格式及分卷 Fixture、恶意 ZIP、取消/重试/恢复、去重测试。
4. 集成与自审 → 适用的完整构建和回归、界面桌面/窄屏/主题检查，独立记录真实网站及设备未验收项。

## 当前代码与复用决策

| 能力 | 已核查位置 | 复用与边界 |
|---|---|---|
| 扩展 | `packages/nowen-clipper/src/{background,content,popup,options}`、`lib/{api,storage,protocol,content-script-bridge,localChannel}.ts` | 保留普通网页剪藏、刷新登录、消息桥和笔记本选择；Adapter 仅解析 DOM，背景服务负责授权和上传 |
| 扩展权限 | `packages/nowen-clipper/public/manifest.json` | 原有 `<all_urls>` 及 content script 是既有普通剪藏架构；AI 读取另设明确授权，不能把安装权限当作聊天采集同意。权限全面收窄需独立兼容验证 |
| 认证 | `backend/src/index.ts`、`lib/api-tokens.ts`、`middleware/api-token-resource-scope.ts` | JWT/PAT 现有链路；服务端清除伪造内部身份头，校验 Token、用户、scope 和笔记本资源；新路由不得绕过 |
| 笔记写入 | `services/{knowledgeTree,knowledgeCapabilities,migrationService}.ts`、笔记块/索引服务 | 通过既有知识树与正文协调服务生成可搜索 Markdown 投影；不能只 INSERT notes 并遗漏树、块或同步意图 |
| 历史导入 | `services/{migrationSourceAdapter,migrationService,migrationUploads}.ts`、`routes/{migrations,migration-uploads}.ts` | 复用受限流式安全解包；外部对话来源/消息/任务状态属于独立领域，通过同一个归档接收服务落库，不复制笔记写入引擎 |
| 存储 | `db/{schema,migrations}.ts`、`db/postgres/` | SQLite 是当前同步运行时；PostgreSQL 为既有试验性结构路径，提供结构对齐不能宣称产品运行时已支持 |
| 同步 | `routes/sync-v2.ts`、既有 Outbox/changes 触发器 | 笔记投影沿用既有同步链路；新增原始归档和任务表不会自动参与 Sync V2，不能宣称第二设备拥有完整原始归档 |
| 前端 | `components/{DataManager,Sidebar}.tsx`、`dataManagement/`、既有 API 层 | 新增 AI 记忆入口与导入入口；沿用 React、语义 surface/text/border/accent token、现有加载/错误/键盘交互 |
| 检索/MCP | `packages/nowen-mcp/src/{index,scoped-fetch,scope-policy}.ts`、既有全文/Embedding 服务 | 普通笔记投影可沿用已有检索；原始会话专用 MCP、记忆提取与 Context Builder 留待后续阶段，不伪装为已实现 |

扩展 Desktop 配对通道目前只支持普通剪藏，没有外部会话 API 或已验证用户身份。首轮使用已登录的 Nowen HTTP 实例；纯本机配对模式必须给出清楚的不支持提示，不能降级为普通笔记后声称结构化归档成功。

## 数据模型与权威源

- `external_ai_sources`：归属于用户、provider、用户明确绑定的本地 accountScope 和个人目标笔记本；不保存第三方凭据。captureEnabled 与 permissionState 独立控制自动采集。
- `external_ai_conversations`：来源内外部会话唯一身份、完整性、服务器 revision、正文 hash、投影 noteId 和投影基线。
- `external_ai_messages`：稳定外部消息 ID、角色、顺序、内容块、正文 hash、采集状态和修订。快照缺少旧消息不意味着删除。
- `ai_conversation_sync_operations`：用户/来源/operationId 与请求 hash、事务收据绑定；同一操作不同内容必须冲突。
- 导入任务：使用持久化、绑定用户及原 Token 的任务记录和受管暂存文件；任务失败不回滚已成功项，取消只停止尚未提交的项目。

原始结构化消息是会话权威数据。Markdown 是一篇可查看、检索、同步的投影。用户编辑过的投影不能被后续采集覆盖；归档可继续接收消息，但投影冲突须保留并提示。删除归档遵循显式操作与回收站规则，不能借删除操作抹掉用户编辑。

升级使用新增迁移，不改历史版本、旧笔记或已有表含义。SQLite 全库备份可包含新增表；仅笔记导出或 Sync V2 不等于完整归档备份。暂存源文件不属于数据库备份，缺文件时必须报告恢复限制。

## API 契约 v1

前缀 `/api/ai-memory`，使用现有 Bearer 登录/PAT。所有参数必须服务端验证并设置请求/批次上限。

| 接口 | 行为 |
|---|---|
| `GET/POST /sources` | 列表/明确绑定来源；POST 包括 provider、accountScope、notebookId、permissionState、captureEnabled |
| `PATCH/DELETE /sources/:id` | 暂停/更新或撤销授权；撤销不代表删除第三方平台原文或已有副本 |
| `POST /conversations/ingest` | `{sourceId, operationId, expectedRevision?, mode, snapshot}`；mode 为 manual/automatic/import；自动模式额外要求 captureEnabled |
| `GET /conversations` | 有界分页、来源和关键词过滤 |
| `GET /conversations/:id`、`GET /conversations/:id/messages` | 校验用户、当前笔记本权限及 Token 资源范围后返回结构化记录 |
| `DELETE /conversations/:id` | 明确删除 Nowen 副本；安全处理关联笔记，不删除第三方原文 |
| `POST /conversations/:id/rebuild-note` | 必须检查投影基线；用户修改后的处理不能隐式覆盖 |
| `POST /imports/preview`、`POST /imports` | 上传/解析预览，用户检查后启动受限批量写入 |
| `GET /imports/:jobId`、`POST /imports/:jobId/cancel`、`POST /imports/:jobId/retry` | 任务进度、结果、取消及仅失败项重试 |

snapshot 包括 provider、accountScope、externalConversationId、title、sourceUrl、messages、completeness、capturedAt。消息包括 externalMessageId（可选）、localSequence、role、blocks、text、contentHash、captureState。服务器重新计算权威 hash，不相信客户端声明的内容摘要。无稳定身份且无法消歧的更新须拒绝，不以数组位置覆盖历史。

ingest 成功只在事务提交后返回 `{conversationId,noteId,revision,operationId,status,persistedAt,completeness,projectionStatus}`。客户端验证操作身份和回执后才出队。冲突、401/403、暂停、响应丢失或非法 JSON 不得当作成功。

## 安全与一致性决策

- DCC-001/003/011：扩展本地暂存与实例已保存分开；保留失败操作 ID，受限重试、可清空、有过期提示；不承诺浏览器关闭时一定上传。
- DCC-002/005：消息、会话、操作收据与笔记投影写入必须事务化；笔记沿用既有 Outbox 触发器，提交失败不返回成功或推进版本。
- DCC-004：expectedRevision、消息身份与修订、用户改过的投影均保守处理；旧快照不能覆盖较新内容。
- DCC-006：来源/队列/任务绑定 Nowen 实例、用户、provider、accountScope；刷新凭据不改变归属。随机 accountScope 不能证明第三方账号身份，自动采集仅在可确认的授权会话/身份范围运行。
- DCC-007：缺消息、加载失败和撤销权限不推断删除；显式删除遵守回收站与当前权限。
- DCC-008：复用 ZIP 中央目录预检、路径/符号链接/ZIP64/条目数/压缩比/实际解压字节上限；不执行脚本、不抓取附件 URL、不读浏览器 Cookie。
- 不向开发者服务器发送正文，不记录原始聊天/Token；所有来源文本为不可信数据，Markdown 在原有安全渲染链路展示，不执行其中的命令或模型指令。
- 首轮限定个人笔记本，避免在共享空间意外投影私人对话。受保护或加密目标不能被转换为明文投影。

## 验证计划与发布条件

后端：真实隔离 SQLite/API 覆盖身份伪造/跨用户/Token 缺权限/撤销、幂等重放与不同 payload 拒绝、追加/修订/旧版本拒绝、不完整快照保留旧消息、投影用户修改保护、事务失败回滚、旧库升级/重开、删除与重建。

扩展：ChatGPT/豆包本地 DOM Fixture 覆盖未授权不读正文、手动预览、代码与角色、稳定 ID、流式去重、导航/账号/服务器切换、撤销释放观察器、断网保留、精确回执与重试。DOM 改版或身份不可靠必须明确降级；Fixture 通过不代表真实网站通过。

导入：覆盖 conversations.json 与编号分卷、current_node 分支选择/遗漏分支报告、重复导入、无效记录、缺附件、MD/TXT 标准边界、取消/重试/重启、ZIP 炸弹/路径穿越/大 JSON 与任务跨用户访问。

阶段检查：Clipper lint/test/build；backend build:tsc/test；frontend test:run/build；MCP 在其代码有改动时补完整回归。原生 SQLite 模块 ABI 与普通 Node 不匹配时使用匹配的 Electron Node runtime，不重建其他任务共享的依赖。

真实 ChatGPT/豆包页面、Chrome/Edge 安装扩展、NAS、Electron 安装包和第二设备数据核对仍需要独立验收。缺少这些证据时，不认定正式发布条件满足。不会自动合并 main 或创建正式 Release。

## 外部格式依据

2026-11-05 核对官方文档：OpenAI [数据导出](https://help.openai.com/en/articles/7260999-how-do-i-export-my-chatgpt-history-and-)提供 ZIP；[导出会话转移说明](https://help.openai.com/en/articles/9106926-transfer-exported-conversations-between-chatgpt-accounts)明确可能包含 conversations.json 或编号 JSON，未承诺稳定的内部字段 Schema。解析器支持的版本应由 Fixture 清楚限定。

Chrome [权限声明](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)支持运行时可选网站权限；现有普通 Clipper 的广泛 host permission 不代表网站级 AI 采集同意。[alarms 文档](https://developer.chrome.com/docs/extensions/reference/api/alarms)说明旧浏览器的会话持久性不可靠，关键重试唤醒应在 service worker 启动时检查重建，休眠和关闭不承诺及时执行。

## MVP 实施收尾（2026-11-06）

Phase 1–3 已形成可运行代码，具体协议见 [API 文档](../api/ai-memory.md)，用户步骤见 [教程](../tutorials/ai-memory.md)，真实测试与剩余门槛见 [验收记录](../qa/ai-memory-hub-2026-11-05.md)。新增 SQLite schema 为 v146，PostgreSQL 提供结构镜像，未宣称 PostgreSQL 运行时通过。

最终保守边界：

- 自动授权限定精确会话；在线每次采集前查询 `GET /sources/:id`，断网不能即时获知异地撤销，最近授权/验证七天内允许有界暂存。
- 增量归档累计最多 10,000 消息 / 16 MiB 正文及块；不清理原消息以满足限额。单批/导入限额独立且更低。
- 消息顺序无法确认时返回冲突，不把新加载历史追加到错误位置。活跃或已有 Yjs 历史的投影不自动重写，通过新副本重建。
- 原始 JSON 通过单个读事务导出，原生 v1 导入保留块、角色、消息状态、时间和来源 URL；不同来源重绑定在预览中明确报告。超出单项导入限额的累计归档 JSON 不能直接整篇重新导入。
- 永久删除绑定的个人笔记本级联删除其原始归档图谱；已经移出的用户笔记保留。回收站列表继续校验当前投影保护与 Token 范围。
- 现有管理员账号转移链路无法完整迁移新归档及知识树图谱，因此含 AI 来源时在写入前明确拒绝，保留原用户数据。未采用临时关闭知识树守卫的方法。
- 凭据刷新按服务器、用户与刷新会话写入独立本地条目；迟到响应不修改当前账号/服务器选择。

Phase 4–6 未实现，真实站点、安装扩展、NAS/设备及正式发布验收仍独立进行，不据 Fixture 测试认定完成。
