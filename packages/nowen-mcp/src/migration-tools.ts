import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { NowenApiClient } from "./api-client.js";

const id = z.string().min(1).max(128);
const textBytes = (value: string) => Buffer.byteLength(value, "utf8");
const relativePath = z.string().min(1).max(512).refine((value) =>
  !/[\u0000-\u001f\u007f\\:]/u.test(value) && !value.startsWith("/")
  && value.split("/").length <= 32 && value.split("/").every(part => part && part !== "." && part !== ".."),
"需要安全的相对文件路径");
const source = z.object({ platform: z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/), exportId: id }).strict();
const note = z.object({
  schemaVersion: z.literal(1),
  source: source.extend({ sourceId: z.string().min(1).max(512) }),
  title: z.string().min(1).max(500),
  path: z.array(z.string().min(1).max(100).refine(value => !/[\\/\0]/.test(value) && value !== "." && value !== ".."))
    .max(16).optional(),
  contentFormat: z.enum(["markdown", "html", "txt"]),
  content: z.string().refine(value => textBytes(value) <= 2 * 1024 * 1024, "单篇正文最多 2 MiB"),
  createdAt: z.string().datetime({ offset: true }).optional(),
  updatedAt: z.string().datetime({ offset: true }).optional(),
  tags: z.array(z.string().min(1).max(100)).max(100).optional(),
  attachments: z.array(z.object({
    assetId: id, path: relativePath, sha256: z.string().regex(/^[a-f0-9]{64}$/i),
    mimeType: z.string().max(100).optional(), originalPath: z.string().min(1).max(2048).optional(),
  }).strict()).max(200).optional(),
  links: z.array(z.object({
    href: z.string().min(1).max(2048), targetSourceId: z.string().max(512).optional(), label: z.string().max(500).optional(),
  }).strict()).max(200).optional(),
  metadata: z.record(z.union([z.string(), z.number().finite(), z.boolean(), z.null()]))
    .refine(value => Object.keys(value).length <= 32 && textBytes(JSON.stringify(value)) <= 16 * 1024,
      "元数据最多 32 个字段、16 KiB").optional(),
}).strict();

function requireMigrationToken(): void {
  if (!process.env.NOWEN_API_TOKEN?.trim().startsWith("nkn_")) {
    throw new Error("迁移 MCP 需要个人 API Token；请在 Nowen Note 中配置授权，不能使用账号密码模拟用户审批");
  }
}

/** Only allow known summary fields; migration responses never return bodies or credentials. */
function summary(value: any): Record<string, unknown> {
  return Object.fromEntries([
    "id", "status", "source", "name", "workspaceId", "targetNotebookId", "counts", "previewDigest",
    "warnings", "rootNotebookId", "createdAt", "updatedAt", "undo", "error",
  ].filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
}

function response(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function failure(error: unknown) {
  return { content: [{ type: "text" as const, text: `错误: ${error instanceof Error ? error.message : String(error)}` }], isError: true as const };
}

export function registerMigrationTools(server: McpServer, api: NowenApiClient, options: { allowLocalFiles: boolean }): void {
  server.tool("nowen_migration_capabilities", "查询统一迁移格式、限额及授权能力；不读取笔记正文", {}, async () => {
    try {
      requireMigrationToken();
      const value = await api.migrationCapabilities();
      return response(Object.fromEntries([
        "schemaVersion", "formats", "limits", "strategies", "humanApprovalRequired", "remoteFetch", "overwrite", "approvalUrl", "permissions", "requiredScopes", "optionalScopes", "resumableUploads", "uploadChunkBytes", "sourceAdapters",
      ].filter(key => value?.[key] !== undefined).map(key => [key, value[key]])));
    }
    catch (error) { return failure(error); }
  });

  server.tool("nowen_migration_create", "创建迁移准备任务，尚不创建笔记；operationId 在超时重试时保持不变", {
    operationId: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/), source,
    name: z.string().min(1).max(200).optional(),
    workspaceId: id.nullable().optional(), targetNotebookId: id.nullable().optional(),
  }, async (params) => {
    try { requireMigrationToken(); return response(summary(await api.createMigration(params))); }
    catch (error) { return failure(error); }
  });

  server.tool("nowen_migration_stage", "分批准备 NMF v1 笔记，每次最多 50 条、512 KiB JSON；大正文和附件使用文件上传。只返回摘要", {
    jobId: id, items: z.array(note).min(1).max(50),
  }, async ({ jobId, items }) => {
    try {
      requireMigrationToken();
      if (textBytes(JSON.stringify({ items })) > 512 * 1024) throw new Error("单次迁移准备最多 512 KiB，请拆分或上传 NMF 包");
      return response(summary(await api.stageMigrationItems(jobId, items)));
    } catch (error) { return failure(error); }
  });

  server.tool("nowen_migration_upload", "仅限用户授权的 stdio 本地文件：流式上传 Markdown、HTML、ZIP 或附件；HTTP 客户端请在 Nowen 上传文件或用 REST 传字节", {
    jobId: id, filePath: z.string().min(1).max(4096), filename: z.string().min(1).max(200).optional(),
    assetPath: relativePath.optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  }, async ({ jobId, ...params }) => {
    try {
      requireMigrationToken();
      if (!options.allowLocalFiles) throw new Error("HTTP MCP 不允许读取服务器本地路径，请使用文件包上传或 REST 字节上传");
      return response(summary(await api.uploadMigrationFile(jobId, params)));
    } catch (error) { return failure(error); }
  });

  for (const [name, action, description] of [
    ["nowen_migration_preview", "preview", "生成迁移预检与重复检查摘要；用户须在 Nowen Note 中查看并确认，AI 无法审批"],
    ["nowen_migration_status", "status", "查询持久化迁移状态、进度及失败统计，不返回正文"],
    ["nowen_migration_retry", "retry", "仅重试失败或未完成的记录；复用已有成功映射，不覆盖用户编辑"],
    ["nowen_migration_cancel", "cancel", "取消未完成任务；已创建结果保留并记入报告"],
    ["nowen_migration_pause", "pause", "暂停任务，保留已写入结果与继续位置"],
    ["nowen_migration_resume", "resume", "继续已暂停的迁移任务，重新校验授权"],
  ] as const) {
    server.tool(name, description, { jobId: id }, async ({ jobId }) => {
      try {
        requireMigrationToken();
        return response(summary(await api.migrationAction(jobId, action)));
      } catch (error) { return failure(error); }
    });
  }

  server.tool("nowen_migration_undo", "查询本次迁移的安全撤销条件；只请求人工操作，不删除内容。用户须在 Nowen Note 中确认撤销", {
    jobId: id,
  }, async ({ jobId }) => {
    try {
      requireMigrationToken();
      return response({ job: summary(await api.migrationAction(jobId, "status")),
        requiresHumanApproval: true, nextStep: "在 Nowen Note → 设置 → 数据管理 → 导入与迁移中检查本次任务并确认安全撤销。" });
    } catch (error) { return failure(error); }
  });
}
