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

`uploadMigrationFile(jobId, blob, filename, {assetPath?, sha256?})` 上传字节，不接受服务器文件路径。带 assetPath 的附件必须提供 SHA-256；大文件限额以能力查询为准。`listMigrations` 返回历史摘要，`migrationReport` 返回不含正文的分页报告。`retryMigration`、`pauseMigration`、`resumeMigration`、`cancelMigration` 操作持久化任务；`approveMigration` 和 `undoMigration` 仅供经过登录的人工 UI 使用，PAT 调用将被拒绝。

The SDK uses the same NMF v1 and REST contract as Web, native clients and MCP. Preserve operation/source IDs on retries, check capabilities before staging, and keep assets separate from note metadata. Blob uploads send bytes, never a server-local path. Job summaries and paginated reports exclude note bodies. Approval and undo methods are for a validated human login session; personal API tokens cannot approve. Transport tests and local builds do not certify actual third-party clients or device synchronization.
