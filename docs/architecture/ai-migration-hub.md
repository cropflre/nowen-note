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

新任务台账是迁移领域状态，不是新的笔记存储或同步引擎。既有 Nowen 无损包和思源导入链路保留；P1 再接入统一历史与适配接口，不能包装一个整包 Buffer 调用并声称满足低内存要求。

## NMF v1 冻结规则

权威代码：`backend/src/services/migrationFormat.ts`。未知字段拒绝；元数据只接受有限的扁平标量，不展开为 DB 字段。时间转换为 UTC ISO。目录段 NFC 规范化，拒绝分隔符和点目录；文件路径必须安全相对路径。来源 ID 只进入映射，内部 ID 由服务器分配。

- 单任务最多 10,000 篇、20,000 个归档条目；单次 API 最多 50 篇且请求不超过 8 MiB。
- 正文每篇最多 2 MiB UTF-8，附件每个最多 64 MiB；ZIP 上传最多 512 MiB，展开最多 1 GiB。
- Manifest 最多 8 MiB；ZIP64、多卷 ZIP、加密 ZIP、符号链接、大小不一致、路径穿越、重复/大小写冲突条目均拒绝。
- 压缩比大于 1000 的条目拒绝；目录预算先于 unzipper 对象分配检查，实际解压字节再次计量。
- 标签最多 100 个；引用/附件各最多 200 个；元数据最多 32 键、16 KiB。
- HTML 复用既有清洗器；附件扩展名和文件签名白名单校验；SVG、脚本、宏与未知类型不进入附件映射。

离线包必须包含根 `manifest.json`，正文和附件分开存储：

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

通用 ZIP 无 manifest 时从 Markdown/HTML/TXT 推导目录和来源文件 ID，并识别受支持的相对链接。相同标题不同内容不会按标题去重。显式平台/导出任务须与 manifest 一致；手动文件入口可以采用 manifest 的来源。无法转换的锚点、数据库 CSV、外链和不支持组件保留或报告，不能静默删除。

v1 不接受 schemaVersion 2，也不猜测未知字段语义。将来不改变 v1 的字段含义；新版本通过能力查询协商、独立 Schema 和显式转换适配，继续保留已有 v1 客户端。

## 状态、恢复与撤销

正常链路为 `CREATED → UPLOADING → SCANNING → NORMALIZING → CREATED → PREVIEW_READY → APPROVED → IMPORTING → VERIFYING → COMPLETED/PARTIAL/FAILED`。多文件扫描后回 CREATED 表示继续暂存，绝不表示导入成功。另有 PAUSED、CANCELLED、UNDONE；所有操作检查预期状态。

Operation ID 绑定创建参数；来源指纹绑定 platform/exportId/sourceId，Item payload hash 阻止同一来源 ID 被重试成不同内容。写入事务包含业务资源和 Item 收据；重启后只处理未完成记录，已成功笔记不会重复创建。取消只阻止尚未提交的写入，已完成记录保留可查看。上传中断不能当作扫描成功。

SQLite v141 新增可加性任务表；v142 补齐开发期已有任务的字节计数与附件对象意图，保持已有笔记不变。正文与元数据的逻辑预算为 1 GiB，独立临时目录预算为 2 GiB；上传按 32 MiB/s 施加流背压，单 Worker 串行处理附件，笔记之间留出 10ms 调度间隔。完成/取消/撤销任务的暂存文件在 1 天后清理，准备/暂停/失败任务为 7 天；清理在启动和新建任务时执行，报告与已导入内容保留。暂存目录不属于可移植备份，恢复数据库后缺少来源文件的任务不能声称可继续导入。

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
| P1 | Notion 语义适配、思源接入统一任务中心 | 复用写入引擎；不能重新走高内存平行链路 |
| P1 | 分块断点续传、重复项修复和更完整引用 | 不改变旧审批；变化后重新预览；保留版本冲突双方 |
| P1 | #820 Sync V2 跨端专项、低资源 NAS 实机 | 真实独立客户端数据库、附件哈希、版本基线与断网编辑；生产/设备验收独立 |
| P2 | Source Adapter 稳定接口、示例和来源连接诊断 | 只转换到 NMF，不拥有 DB 写入或 ACL |
| P2 | WorkBuddy/Qoder/豆包工作真实接入验证 | 分客户端、版本、transport 记录；未知版本退回标准文件包 |

基础 AI Skill 和各客户端指引可以随 P0 一起交付；提供文档不等于已在该客户端实测。

可直接检查的 [NMF v1 示例](../examples/migration/manifest.json) 包含真实正文哈希；将该目录中的 `manifest.json` 与 `notes/` 打包到 ZIP 根目录即可。OpenAPI 的 `NmfManifest` 与 SDK 同名类型描述此协议。

## 数据一致性与验证证据

适用契约：DCC-002/003（事务与恢复）、DCC-004/011（不覆盖客户端编辑及精确版本）、DCC-006（身份隔离）、DCC-007（显式安全撤销）、DCC-008（先校验再写入）。新增测试与实测记录见 `docs/qa/ai-migration-hub-2026-10-29.md`。

历史 [#820](https://github.com/cropflre/nowen-note/issues/820) 是 macOS 导入 100MB+ 思源包后长期待同步与冲突反馈；维护者评论提到合并中间状态、正确自回声基线和先元数据后附件，但仍要求真实大包复验。不能因 Issue 关闭或本地构建通过，推断真机与生产同步已经验收。
