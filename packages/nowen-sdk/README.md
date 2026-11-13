# Nowen TypeScript SDK

`NowenClient` 保留现有 REST 方法，并提供统一迁移中心 API。服务器始终验证用户、Token scopes、目标权限及任务状态；API Token 无法执行人工审批或安全撤销。

```ts
import { NowenClient } from "@nowen/sdk";

const client = new NowenClient({ baseUrl: "https://your-nowen.example" });
client.setToken("nkn_your_token");
const capabilities = await client.migrationCapabilities();
const job = await client.createMigration({
  operationId: "keep-this-id-on-retry",
  source: { platform: "markdown", exportId: "export-2026-10" },
  targetNotebookId: "authorized-notebook-id",
});
await client.stageMigrationItems(job.id, [{
  schemaVersion: 1,
  source: { platform: "markdown", exportId: "export-2026-10", sourceId: "notes/example.md" },
  title: "Example",
  contentFormat: "markdown",
  content: "# Example",
}]);
const preview = await client.previewMigration(job.id);
// Direct the user to review and approve this task in Nowen.
const progress = await client.getMigration(job.id);
```

`uploadMigrationFile(jobId, blob, filename, {assetPath?, sha256?})` 保留为兼容的单次字节上传，不接受服务器文件路径。带 assetPath 的附件必须提供 SHA-256；限额以能力查询为准。`listMigrations` 返回历史摘要，`migrationReport` 返回不含正文的分页报告。`retryMigration`、`pauseMigration`、`resumeMigration`、`cancelMigration` 操作持久化任务；`approveMigration` 和 `undoMigration` 仅供经过登录的人工 UI 使用，PAT 调用将被拒绝。

## Phase 1：上传会话与逐项决策

先检查能力中的 `resumableUploads`、`uploadChunkBytes` 和 `sourceAdapters`。Notion Markdown/HTML/CSV 与思源原生 ZIP 仍通过统一来源上传进入 NMF，不需要另一个写入 API。创建任务时用 `source.platform: "files"` 自动识别，或明确指定 `notion` / `siyuan`，固定本次 exportId。Notion CSV 仅暂存有界来源属性并报告字段名，不写成笔记属性或数据库；思源转为 Markdown，嵌套块引用保留来源链接。详见 [适配边界](../../docs/architecture/ai-migration-hub.md#p1-来源适配)。

| 方法 | 用途 |
|---|---|
| `createMigrationUploadSession(jobId, {operationId, filename, size, sha256, assetPath?})` | 创建或恢复同一文件会话，返回已确认 offset、chunkBytes、状态和有效期 |
| `getMigrationUploadSession(jobId, uploadId)` | 在响应丢失或重启后查询服务端已确认偏移 |
| `putMigrationUploadChunk(jobId, uploadId, offset, blob, sha256)` | 发送恰好 4 MiB 或末块余量，携带该块 SHA-256 |
| `completeMigrationUpload(jobId, uploadId)` | 启动后台合并与整文件校验，返回任务摘要，不表示已经导入 |
| `cancelMigrationUpload(jobId, uploadId)` | 取消未提交上传会话，与取消整个迁移任务不同 |
| `decideMigrationItem(jobId, itemId, previewDigest, decision)` | 选择 `auto` / `skip` / `keep-existing` / `create-copy`，返回新预览 |

SDK 提供上述原语，**不自动计算完整文件哈希或运行上传循环**。调用方应增量计算完整文件 SHA-256，固定 operationId 和文件参数，在同一任务中顺序发送分块，以返回的 offset 为准；响应丢失先 GET 会话，不能自行增加偏移。相同 operationId 换文件会返回冲突。会话 24 小时过期后分块清理，允许重开时从 0 开始。每个任务只允许一个 OPEN / FINALIZING 上传；512 MiB ZIP、2 MiB 正文和 64 MiB 附件上限不变。

`completeMigrationUpload` 收到 202 任务摘要后继续用 `getMigration` 查询。会话 COMPLETE 只表示已校验文件交接给扫描／暂存；任务仍可能扫描或失败。整文件校验失败不可继续把部分来源当作完整预览。完整协议与错误边界以实例 `/api/openapi.json` 为准。

从 `migrationReport` 的分页结果取 itemId。决策仅接受当前 PREVIEW_READY 的 previewDigest，`keep-existing` 需要可访问的已有目标，且没有覆盖决策。来源变化需要处理时，`auto` 不会绕过 ATTENTION；Notion / 思源按稳定文档 ID 检测跨导出来源。每次决策都会使旧摘要和审批失效；使用返回的新预览，让用户在 Nowen 重新确认。

The SDK uses the same NMF v1 and REST contract as Web, native clients and MCP. Preserve operation/source IDs on retries, check capabilities before staging, and keep assets separate from note metadata. Blob uploads send bytes, never a server-local path. Job summaries and paginated reports exclude note bodies. Approval and undo methods require a validated login session; personal API tokens cannot approve or execute undo.

Phase 1 exposes the explicit upload-session methods in the table above. The caller computes the full SHA-256 incrementally, retains the same operation ID and file parameters, and sends exactly 4 MiB chunks except for the final remainder, with each chunk's SHA-256. The SDK does not run this loop automatically. After a lost response, query the session and use only the confirmed offset. Sessions expire after 24 hours; an allowed restart discards old chunks and starts at zero. Only one OPEN / FINALIZING upload is allowed per job. ZIP, body and asset limits remain 512 MiB, 2 MiB and 64 MiB. Completion returns a job summary while server-side verification/scanning continues; a COMPLETE upload is not a successful note import.

Item decisions use the current preview digest and `auto`, `skip`, `keep-existing` or `create-copy`. Keep existing requires an accessible target; no decision overwrites it. Stable Notion/Siyuan IDs can detect sources from previous hub exports. Changed sources require a decision, and every decision replaces the preview and clears approval. Ask the user to review the new preview in Nowen. For source ZIPs, create the job with platform `files` for detection or explicit `notion` / `siyuan`, retaining the export ID. Notion CSV is staged source metadata and field-name reporting only; it does not become note properties or databases. Siyuan is converted to Markdown and retains source links for nested blocks. Transport tests and local builds do not certify third-party clients, physical devices or NAS synchronization.

## Phase 2：来源目录 / source catalog

`migrationCapabilities()` 的可选 `adapterApiVersion: 1` 与 `adapters: MigrationSourceAdapter[]` 提供当前实例的来源分类、格式和不支持项；旧实例可回退到 `formats` / `sourceAdapters`。目录是只读说明，不代表平台账号连接、目标权限或真实客户端已验收。显式 `source.platform: "huawei"` 可使用 TXT/HTML 文件适配；自定义来源优先离线转换为 NMF，仍走共用预览与人工审批。规范与示例见 [Source Adapter v1](../../docs/architecture/migration-source-adapters.md)。

The optional `adapterApiVersion: 1` and typed `adapters` catalog describe the current instance's source categories, formats and limitations. Fall back to `formats` / `sourceAdapters` on older servers. Discovery is read-only and does not establish platform login, destination access or real AI-host acceptance. Explicit `source.platform: "huawei"` supports exported TXT/HTML files. Custom sources can produce NMF offline and retain the same preview/approval path; see the [English contract and example](../../docs/architecture/migration-source-adapters.en.md).
