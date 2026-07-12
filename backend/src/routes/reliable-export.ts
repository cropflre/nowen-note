import { Hono } from "hono";
import type { Context } from "hono";
import { getDb } from "../db/schema";
import { isSystemAdmin } from "../middleware/acl";
import {
  createReliableMarkdownExportJob,
  getReliableExportJob,
  MAX_MARKDOWN_EXPORT_REQUEST_BYTES,
  ReliableExportBusyError,
  ReliableExportPayloadTooLargeError,
  ReliableExportValidationError,
  stageReliableGeneratedExport,
  type PreparedMarkdownNote,
} from "../services/reliableExportJobs";

const app = new Hono();

function workspaceFilter(raw: string | undefined): { sql: string; param: string | null } {
  const ws = (raw || "").trim();
  if (!ws || ws === "personal") return { sql: "AND n.workspaceId IS NULL", param: null };
  return { sql: "AND n.workspaceId = ?", param: ws };
}

function denyIfPersonalExportDisabled(
  userId: string,
  isPersonalScope: boolean,
): { error: string; code: string } | null {
  if (!isPersonalScope || isSystemAdmin(userId)) return null;
  try {
    const row = getDb()
      .prepare("SELECT personalExportEnabled FROM users WHERE id = ?")
      .get(userId) as { personalExportEnabled: number } | undefined;
    if (!row || row.personalExportEnabled !== 0) return null;
  } catch {
    return null;
  }
  return {
    error: "管理员已禁用你的个人空间导出功能",
    code: "FEATURE_DISABLED",
  };
}

async function readJsonBodyLimited<T>(c: Context, maxBytes: number): Promise<T> {
  const declared = Number(c.req.header("Content-Length") || "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ReliableExportPayloadTooLargeError(
      `导出请求体超过 ${Math.floor(maxBytes / 1024 / 1024)}MB`,
      "MARKDOWN_EXPORT_REQUEST_TOO_LARGE",
    );
  }

  const body = c.req.raw.body;
  if (!body) throw new ReliableExportValidationError("导出请求体为空", "EMPTY_EXPORT_REQUEST");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("export request too large").catch(() => undefined);
        throw new ReliableExportPayloadTooLargeError(
          `导出请求体超过 ${Math.floor(maxBytes / 1024 / 1024)}MB`,
          "MARKDOWN_EXPORT_REQUEST_TOO_LARGE",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8")) as T;
  } catch (error) {
    if (error instanceof ReliableExportPayloadTooLargeError) throw error;
    throw new ReliableExportValidationError("导出请求 JSON 无效", "INVALID_EXPORT_JSON");
  }
}

function errorResponse(c: Context, error: unknown) {
  if (
    error instanceof ReliableExportPayloadTooLargeError ||
    error instanceof ReliableExportValidationError ||
    error instanceof ReliableExportBusyError
  ) {
    return c.json({ error: error.message, code: error.code }, error.status as 400 | 409 | 413);
  }
  console.error("[reliable-export] request failed:", error);
  return c.json({ error: "准备导出文件失败", code: "EXPORT_PREPARE_FAILED" }, 500);
}

app.post("/markdown-package/jobs", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const wsRaw = c.req.query("workspaceId") ?? undefined;
  const { sql: wsSql, param: wsParam } = workspaceFilter(wsRaw);
  const denied = denyIfPersonalExportDisabled(userId, wsParam === null);
  if (denied) return c.json(denied, 403);

  try {
    const body = await readJsonBodyLimited<{
      notes?: PreparedMarkdownNote[];
      inlineImages?: boolean;
      layout?: "notebooks" | "flat";
      filenameBase?: string;
    }>(c, MAX_MARKDOWN_EXPORT_REQUEST_BYTES);
    const notes = body.notes;
    if (!Array.isArray(notes) || notes.length === 0) {
      throw new ReliableExportValidationError("没有可导出的笔记", "NO_NOTES");
    }

    const noteIds = notes.map((note) => note?.id);
    const stmt = db.prepare(`
      SELECT n.id
        FROM notes n
       WHERE n.userId = ? AND n.isTrashed = 0
         ${wsSql}
    `);
    const rows = (wsParam === null
      ? stmt.all(userId)
      : stmt.all(userId, wsParam)) as Array<{ id: string }>;
    const allowedIds = new Set(rows.map((row) => row.id));
    if (noteIds.some((id) => typeof id !== "string" || !allowedIds.has(id))) {
      return c.json({ error: "部分笔记不存在或不属于当前导出空间", code: "NOTE_SCOPE_MISMATCH" }, 403);
    }

    const job = createReliableMarkdownExportJob({
      userId,
      notes,
      inlineImages: body.inlineImages === true,
      layout: body.layout === "flat" ? "flat" : "notebooks",
      filenameBase: typeof body.filenameBase === "string" ? body.filenameBase : undefined,
    });
    c.header("X-Nowen-Reliable-Export", "1");
    return c.json({ job }, 202);
  } catch (error) {
    return errorResponse(c, error);
  }
});

app.get("/markdown-package/jobs/:id", (c) => {
  const userId = c.req.header("X-User-Id")!;
  const job = getReliableExportJob(c.req.param("id"), userId);
  if (!job) return c.json({ error: "导出任务不存在或已过期", code: "EXPORT_JOB_NOT_FOUND" }, 404);
  c.header("X-Nowen-Reliable-Export", "1");
  return c.json({ job });
});

app.post("/download-jobs", async (c) => {
  const userId = c.req.header("X-User-Id")!;
  const encodedFilename = c.req.header("X-Export-Filename") || "export.bin";
  let filename: string;
  try {
    filename = decodeURIComponent(encodedFilename);
  } catch {
    return c.json({ error: "导出文件名无效", code: "INVALID_EXPORT_FILENAME" }, 400);
  }

  const contentType = (c.req.header("Content-Type") || "application/octet-stream")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const allowedTypes = new Set([
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/zip",
    "application/x-zip-compressed",
    "text/markdown",
    "text/plain",
  ]);
  if (!allowedTypes.has(contentType)) {
    return c.json({
      error: "仅支持 Markdown、ZIP、PDF 和 DOCX 导出中转",
      code: "UNSUPPORTED_EXPORT_TYPE",
    }, 415);
  }
  if (!c.req.raw.body) return c.json({ error: "导出文件为空", code: "EMPTY_EXPORT_FILE" }, 400);

  try {
    const result = await stageReliableGeneratedExport({
      userId,
      filename,
      contentType,
      body: c.req.raw.body,
      contentLength: Number(c.req.header("Content-Length") || "") || undefined,
    });
    c.header("X-Nowen-Reliable-Export", "1");
    return c.json(result, 201);
  } catch (error) {
    return errorResponse(c, error);
  }
});

export default app;
