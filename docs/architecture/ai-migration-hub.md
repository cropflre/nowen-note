# AI Migration Hub — v1.6.0 技术设计与源码审计

日期：2026-10-29。目标：`release/v1.6.0` 的派生分支。本文区分当前实现、阶段计划和环境验收；不把计划视为已支持。

## 真实仓库审计

| 能力 | 当前实现位置 | 可复用部分 | 缺口 | 改造风险 |
|---|---|---|---|---|
| MCP | `packages/nowen-mcp/src/index.ts`、`api-client.ts`、`scoped-fetch.ts`、`http-entry.ts` | 现有 Server、Zod、PAT、工具注册、stdio/Streamable HTTP | 新任务工具和轻量摘要；审批不能由模型完成 | 本地路径工具不可暴露给远程 HTTP；客户端白名单不能代替服务端 ACL |
| 导入任务 | `backend/src/routes/import-batches.ts`、`services/roundTripImportBatches.ts`、`siyuanImportJobs.ts` | 旧导入报告、安全撤销思路、后台通知 | 旧任务状态不足以承载逐 Item 恢复与预览审批 | 思源重启把 stale running 标为失败，不能直接把重跑等同于恢复 |
| 包解析 | `services/nowenPackageImport.ts`、`nowenRoundTripSync.ts`、`nowenPackageImportV2.ts` | 无损包兼容规则保留；新适配器只做 Source → NMF | 旧路径以 Buffer/JSZip 读取整包，`SourceAttachment.buffer` 持有附件 | 新中心不能调用此高内存路径处理大型包，也不重写旧接口 |
| 通用/Office/手机导入 | `frontend/src/components/DataManager.tsx`、`backend/src/routes/notes.ts`、`services/siyuanPackageImport*` | 现有导入入口、格式语义与回归 | 尚未全部成为 NMF 适配器 | 保留“其他导入方式”，分阶段迁移，避免改变旧行为 |
| 附件存储 | `backend/src/services/attachment-storage.ts`、`lib/attachmentRefs.ts` | 本地/S3 驱动、月路径、引用索引、附件同步触发器 | 原写接口接收完整 Buffer；新增文件流入口 | 文件写入与 DB 事务不能形成全局事务，需确定 ID 与补偿清理 |
| 目录结构 | `services/knowledgeTree.ts`、`knowledgeTreeCore.ts`、`knowledgeTreeRootDocuments.ts`、`knowledgeCapabilities.ts` | 创建目录/笔记、ACL、能力继承与树投影 | 预分配笔记 ID 支持一次性最终正文写入 | 不能直接 SQL INSERT 笔记并遗漏知识树、权限或索引 |
| 笔记正文 | `services/noteDuplicates.ts`、`lib/noteBlocks.ts`、`noteLinks.ts`、`blockAuthorityStore.ts` | 既有创建协调顺序、正文与引用索引、块权威 | 迁移来源映射和幂等 Item 台账 | 不得在后台二次覆盖已开放给客户端编辑的正文 |
| 同步/Yjs | `routes/sync-v2.ts`、`db/syncChangesV2Migration.ts`、`syncV2LocalStateMigration.ts`、`services/yjs.ts` | 事务触发器、Outbox、变更 feed、通知 | 新任务需要证明完整正文/附件进入同一同步链路 | 中间快照、自回声版本、附件元数据顺序，参见 #820；HTTP 200 不能证明第二端完整 |
| 权限/身份 | `backend/src/index.ts`、`middleware/api-token-resource-scope.ts`、`lib/api-tokens.ts`、`middleware/acl.ts` | 已验证用户会话、PAT scopes、资源白名单、ACL | 后台每批复验原授权；审批须使用验证后的会话上下文 | 不能相信客户端传入的 X-* 内部头；知道 jobId 不代表拥有任务 |
| 前端 | `components/DataManager.tsx`、`dataManagement/DataTransferCenter.tsx`、`settings/McpConnectionPanel.tsx` | 设置壳、工作区选择、Token 指引、主题语义 Token | 统一预览/审批/历史/报告 | 本机 Native 模式无服务端任务接口，必须明确服务器前提 |
| 数据演进/API | `backend/src/db/migrations.ts`、`services/openapi.ts`、`packages/nowen-sdk/src/` | 版本登记、OpenAPI 生成、SDK 认证 | 新增可加性任务表、NMF 与任务 API | 旧用户数据不能被迁移覆盖；新 API 与类型必须一致 |

## 最终链路与依赖

```text
文件 / AI MCP / TypeScript SDK
  → 现有身份和 Token 资源校验
  → 迁移上传临时目录 / 小批量 items
  → Source Adapter → NMF v1
  → 持久化 Job + Item + 资产校验和
  → 预览摘要（短时、绑定内容与重复检测结果）
  → Nowen 登录会话中用户点击审批
  → 单 Worker、分批事务、原 Token/目标 ACL 再校验
  → Knowledge Tree 创建 + 正文/块/附件/链接索引 + 原同步触发器
  → 校验、分页报告、安全撤销
```

格式层不接触业务数据库。服务层不对外提供任意 SQL、任意本地路径或远程抓取。Web/桌面/Android 连接同一服务端时使用同一 REST；MCP 只组织任务，不能审批或直接执行撤销。来源文档中的指令始终作为正文，不执行命令、脚本或宏。

新任务台账是迁移领域状态，不是新的笔记存储或同步引擎。既有 Nowen 无损包和思源导入链路保留。P1 的 Notion、思源适配器复用安全解包清单，只产出 NMF，再由同一任务服务写入；旧导入历史不会自动合并到新中心。

## NMF v1 冻结规则

权威代码：`backend/src/services/migrationFormat.ts`。未知字段拒绝；元数据只接受有限的扁平标量，不展开为 DB 字段。时间转换为 UTC ISO。目录段 NFC 规范化，拒绝分隔符和点目录；文件路径必须安全相对路径。来源 ID 只进入映射，内部 ID 由服务器分配。

- 单任务最多 10,000 篇、20,000 个归档条目；单次 API 最多 50 篇且请求不超过 8 MiB。
- 正文每篇最多 2 MiB UTF-8，附件每个最多 64 MiB；ZIP 上传最多 512 MiB，展开最多 1 GiB。
- Manifest 最多 8 MiB；ZIP64、多卷 ZIP、加密 ZIP、符号链接、大小不一致、路径穿越、重复/大小写冲突条目均拒绝。
- 压缩比大于 1000 的条目拒绝；目录预算先于 unzipper 对象分配检查，实际解压字节再次计量。
- 标签最多 100 个；引用/附件各最多 200 个；元数据最多 32 键、16 KiB。
- HTML 复用既有清洗器；附件扩展名和文件签名白名单校验；SVG、脚本、宏与未知类型不进入附件映射。

标准 NMF 离线包必须包含根 `manifest.json`，正文和附件分开存储：

```json
{
  "format": "nowen-migration",
  "schemaVersion": 1,
  "source": { "platform": "notion", "exportId": "export-20261029" },
  "notes": [{
    "sourceId": "page-001",
    "title": "项目",
    "path": ["工作"],
    "contentFormat": "markdown",
    "contentFile": "notes/page-001.md",
    "sha256": "<正文原始 UTF-8 文件的 SHA-256>",
    "attachments": [{ "assetId": "image-1", "path": "assets/image.png", "sha256": "<附件 SHA-256>" }],
    "links": [], "tags": [], "metadata": {}
  }]
}
```

Manifest 中的笔记字段与逻辑 NMF 一致，但 `sourceId` 替代嵌套 source，`contentFile + sha256` 替代正文。`originalPath` 可声明正文中的资源引用；未声明时按正文文件与附件的相对位置生成。服务器将附件路径改为本任务受管暂存路径，该路径不是服务器任意文件读取权限。

通用 ZIP 无 manifest 时从 Markdown/HTML/TXT 推导目录和来源文件 ID，并识别受支持的相对链接。相同标题不同内容不会按标题去重。显式平台/导出任务须与 manifest 一致；手动文件入口可以采用 manifest 的来源。Notion 和思源的识别及属性边界见下节；无法转换的锚点、外链和不支持组件保留或报告，不能静默删除。

v1 不接受 schemaVersion 2，也不猜测未知字段语义。将来不改变 v1 的字段含义；新版本通过能力查询协商、独立 Schema 和显式转换适配，继续保留已有 v1 客户端。

## P1 来源适配

能力查询通过 `sourceAdapters` 返回 `notion-markdown-html-csv`、`siyuan-native-zip`。手动来源使用 `source.platform: "files"` 自动识别，API 调用也可显式使用 `notion` 或 `siyuan`，并固定本次 exportId。它们共享上述文件、正文、附件和暂存限额，不提供来源账号登录、远程抓取或独立写入引擎。

### Notion Markdown / HTML / CSV

Notion 官方支持将页面导出为 HTML，或将页面与数据库导出为 Markdown 与 CSV；子页面和附件可随 ZIP 导出，见 [Notion 导出说明](https://www.notion.com/help/export-your-content)。适配器以导出文件中的页面 UUID 为稳定来源 ID，移除人类可读标题和目录尾部的 ID，并映射已导出页面之间的相对链接、URL 编码链接和 Notion 页面 URL。未导出页面、不可转换的锚点仍保留来源链接，不自动抓取。

手动文件入口仅在发现人类名称加 UUID 后缀或明确 Notion HTML 标记时推断来源，并提示 `NOTION_FORMAT_INFERRED`；纯 UUID 文件名不会单独触发推断。文件命名是当前夹具覆盖的识别规则，不是 Notion 官方承诺的版本化协议。重复页面 UUID 拒绝；代码示例里的链接不作为页面引用。

CSV 每个最多 2 MiB、合计 8 MiB，最多 10,000 行、256 列，按 NMF 的 32 键 / 16 KiB 上限暂存标量属性。只有页面 ID 或限定目录中的标题能唯一匹配时才关联；歧义、重复表头、超限和解析失败均报告。`notion.csv.*` 只进入来源元数据，报告列出未迁移字段名，**不会写成笔记属性、标签、日期、公式或数据库关系**。原 CSV 应保留供核对。数据库视图、公式、关系、评论、历史和权限不作无损迁移承诺。

### 思源原生 ZIP

包含当前 `.sy` 文档的 ZIP 使用 `migrationSiyuanAdapter.ts`，复用现有 `siyuanSyToMarkdown` 转换器输出 Markdown NMF。保留可解析的文档 ID、标题、笔记本及父子目录、标签和受支持的本地附件；历史、回收站及内部目录不作为当前笔记导入。单文档最多 2 MiB，AST 最多 20,000 节点、64 层；重复文档 ID 和无效文档拒绝。

指向包内文档 ID 的思源引用可转换为 Nowen 笔记链接。嵌套块和包外引用保留原 `siyuan://blocks/...`，不伪造块锚点。挂件、iframe、数据库、查询和特殊样式按转换器降级并报告，不执行来源脚本。仅带明确时区的 ISO 时间写入日期；无时区时间保留在来源元数据并提示，不能猜测时区。自定义属性仅报告字段名，不写入笔记属性。该路径不等于 Tiptap 无损恢复，也不支持加密解密、历史或权限迁移；旧思源导入入口继续保留。

## P1 断点上传与逐项决策

`resumableUploads: true` 和 `uploadChunkBytes: 4194304` 表示支持上传会话。旧 `POST /api/migrations/:id/uploads` 字节接口保留兼容。

| 接口 | 行为 |
|---|---|
| `POST /api/migrations/:id/upload-sessions` | 提交固定 `operationId`、`filename`、`size`、完整文件 `sha256`，可选安全 `assets/` 下的 `assetPath`；相同参数返回原会话 |
| `GET /api/migrations/:id/upload-sessions/:uploadId` | 查询会话状态及服务端已确认的 `offset` |
| `PUT /api/migrations/:id/upload-sessions/:uploadId/chunks?offset=...` | 原始字节及 `X-Chunk-SHA256`；每块恰好 4 MiB，末块为余量；同一已确认分块可精确重放 |
| `POST /api/migrations/:id/upload-sessions/:uploadId/complete` | 返回 202 任务摘要；后台流式合并、完整哈希验证后才交给扫描或附件暂存 |
| `DELETE /api/migrations/:id/upload-sessions/:uploadId` | 取消未提交会话，清理能确认属于该会话的临时文件 |
| `POST /api/migrations/:id/items/:itemId/decision` | 提交当前 `previewDigest` 与 `auto` / `skip` / `keep-existing` / `create-copy`，返回新预览 |

会话有效期 24 小时，同一任务只允许一个 OPEN / FINALIZING 会话；每次写入及恢复仍复验创建者、原 Token 与当前权限。相同 operationId 不能换文件。客户端遇到响应丢失须查询已确认偏移，不能推算成功；过期会话的未提交分块会清理，允许重新创建时从 0 开始。服务器重启可恢复 FINALIZING 合并。上传会话没有提高 512 MiB ZIP、64 MiB 附件及 2 GiB 临时目录上限，合并需要同时容纳分块和输出文件。202、offset 等于 size 或会话 COMPLETE 均不等于笔记已导入，必须继续查询任务。

浏览器先分片计算哈希，重开同一准备中任务并重新选择同一文件可继续确认偏移；关闭页面不会让尚未完成的浏览器上传继续发送。stdio MCP 在服务器支持时自动使用会话，再次调用同一任务和文件可恢复；HTTP MCP 仍禁止服务器本地路径。SDK 提供会话方法，由调用方实现分块循环及恢复。

预览中对每个未导入项选择自动、跳过、保留已有或创建新副本。`keep-existing` 只用于当前存在且可访问的已有目标；没有覆盖已有笔记的决策。Notion / 思源的稳定文档 ID 可跨不同 exportId 识别此前由迁移中心导入的同来源笔记，范围仍受用户、工作区和权限限制；通用来源继续使用导出身份及内容匹配。比较保留原正文哈希兼容，同时核对标题、排序去重后的标签、附件原引用与 SHA-256，临时文件路径不影响结果。同来源这些字段变化时，自动策略进入 ATTENTION，必须处理后才能审批；辅助内容重复也需要这些字段一致。任何决策都会使旧审批失效并生成新摘要，用户须重新检查后在 Nowen 批准。该 API 不提供任意编辑正文或来源数据的修复能力，MCP 没有对应决策工具。

## 状态、恢复与撤销

正常链路为 `CREATED → UPLOADING → SCANNING → NORMALIZING → CREATED → PREVIEW_READY → APPROVED → IMPORTING → VERIFYING → COMPLETED/PARTIAL/FAILED`。多文件扫描后回 CREATED 表示继续暂存，绝不表示导入成功。另有 PAUSED、CANCELLED、UNDONE；所有操作检查预期状态。

Operation ID 绑定创建参数；来源指纹绑定 platform/exportId/sourceId，Item payload hash 阻止同一来源 ID 被重试成不同内容。Notion / 思源另按稳定来源 ID 做跨导出重复检测，变化项进入显式决策。写入事务包含业务资源和 Item 收据；重启后只处理未完成记录，已成功笔记不会重复创建。取消只阻止尚未提交的写入，已完成记录保留可查看。上传中断不能当作扫描成功。

SQLite v141 新增可加性任务表；v142 补齐开发期已有任务的字节计数与附件对象意图；v143 加入上传会话和分块收据，v144 加入逐项决策，v145 加入稳定来源查询索引及开发期上传字段兼容。升级不改写已有笔记。正文与元数据的逻辑预算为 1 GiB，独立临时目录预算为 2 GiB；上传按 32 MiB/s 施加流背压，单 Worker 串行处理附件，笔记之间留出 10ms 调度间隔。完成/取消/撤销任务的暂存文件在 1 天后清理，准备/暂停/失败任务为 7 天；清理在启动和新建任务时执行，报告与已导入内容保留。上传会话的 24 小时有效期独立于任务保留期。暂存目录不属于可移植备份，恢复数据库后缺少来源文件的任务不能声称可继续导入。

默认只向新根笔记本创建，无覆盖策略。内部链接用预先分配的目标 ID，在创建时写入最终正文。用户编辑不会被后续链接修复覆盖。安全撤销是显式软删除；完整比较资源指纹、目录成员与 Yjs 已刷新状态，发现编辑、移动或新增内容则拒绝整次撤销。

审批需要验证后的登录会话上下文；PAT 独立拒绝。不存在固定确认字符串或 MCP approve 工具。这是产品级交互与权限边界，不声称能够区分掌握用户完整登录凭据的自动化程序与真实用户；AI 集成应使用最小 PAT，不能把账号密码交给客户端。

## 可执行开发单元

| 阶段 | 单元 | 依赖与验收 |
|---|---|---|
| P0 | 审计与 NMF Schema / ZIP 安全适配 | 独立 Schema 和恶意包拒绝测试 |
| P0 | Job/Item/资产台账、后台写入与恢复 | 依赖 NMF；真实 SQLite 创建、重试、取消、重启、权限负例 |
| P0 | REST、用户审批、MCP、SDK、OpenAPI | 依赖服务；API/PAT 不能审批；真实 SDK Client stdio/HTTP |
| P0 | 统一设置页、历史、预览/进度/报告 | 依赖 REST；真实点击审批、重新打开、窄屏与主题检查 |
| P0 | 回归、资源实测、文档与阶段提交 | 100/1,000/10,000 篇、100 MiB+ 包、内存限制与现有导入回归 |
| P1（已实现，待环境验收） | Notion 与思源 Source → NMF | 复用写入引擎；受支持引用转换与降级报告；不承诺平台无损 |
| P1（已实现，待环境验收） | 分块断点续传与逐项决策 | 已确认偏移、分块/整文件哈希；变化后重新预览，无覆盖决策 |
| P1 | #820 Sync V2 跨端专项、低资源 NAS 实机 | 自动化使用独立原生 SQLite 客户端及真实 HTTP 验证正文、附件、断网编辑和精确 ACK；NAS 与设备验收仍独立待做 |
| P2 | Source Adapter 稳定接口、示例和来源连接诊断 | 只转换到 NMF，不拥有 DB 写入或 ACL |
| P2 | WorkBuddy/Qoder/豆包工作真实接入验证 | 分客户端、版本、transport 记录；未知版本退回标准文件包 |

基础 AI Skill 和各客户端指引可以随 P0 一起交付；提供文档不等于已在该客户端实测。

可直接检查的 [NMF v1 示例](../examples/migration/manifest.json) 包含真实正文哈希；将该目录中的 `manifest.json` 与 `notes/` 打包到 ZIP 根目录即可。OpenAPI 的 `NmfManifest` 与 SDK 同名类型描述此协议。

## 数据一致性与验证证据

适用契约：DCC-002/003（事务与恢复）、DCC-004/011（不覆盖客户端编辑及精确版本）、DCC-006（身份隔离）、DCC-007（显式安全撤销）、DCC-008（先校验再写入）、DCC-012（原生多库故障恢复、实体身份与未确认数据）。验证记录分别见 [P0](../qa/ai-migration-hub-2026-10-29.md) 和 [Phase 1](../qa/ai-migration-hub-phase1-2026-10-29.md)。P1 对应测试包括 `migration-notion-adapter.test.ts`、`migration-siyuan-adapter.test.ts`、`migration-uploads.test.ts`、`migration-upload-security.test.ts`、`sync-v2-mobile-multidevice.test.ts` 与 `sync-v2-blob-http.test.ts`；自动化通过不代表物理设备、真实 NAS/代理/S3 或第三方 AI 客户端已验收。

历史 [#820](https://github.com/cropflre/nowen-note/issues/820) 是 macOS 导入 100MB+ 思源包后长期待同步与冲突反馈；维护者评论提到合并中间状态、正确自回声基线和先元数据后附件，但仍要求真实大包复验。不能因 Issue 关闭或本地构建通过，推断真机与生产同步已经验收。
