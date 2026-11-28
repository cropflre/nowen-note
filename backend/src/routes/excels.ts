/**
 * Excel 工作簿（Univer 快照）读写。思路来源：cropflre/nowen-note PR #802。
 *
 * 与 PR 的差异：
 * - 乐观锁改用整数 revision，并且写入必须携带 expectedRevision，不允许无条件覆盖；
 * - 快照与 notes.contentText 在同一事务落库，响应里的 revision 才是“已持久化”的依据；
 * - 新建入口受 NOWEN_EXCEL_WORKBOOK 开关控制（见 /capabilities），已有工作簿始终可读写。
 */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/schema.js";
import { hasPermission, resolveNotebookPermission } from "../middleware/acl.js";
import {
  hasKnowledgeCapability,
  resolveKnowledgeNodeAccess,
} from "../services/knowledgeCapabilities.js";
import { synchronizeLegacyNoteHierarchy } from "../services/legacyKnowledgeHierarchy.js";
import {
  createDefaultExcelWorkbook,
  EXCEL_MAX_DATA_BYTES,
  isExcelWorkbookCreationEnabled,
  serializeExcelText,
  validateExcelData,
} from "../services/excelData.js";

const app = new Hono();

interface ExcelRow {
  noteId: string;
  workspaceId: string | null;
  data: string;
  revision: number;
  updatedAt: string;
  title: string;
}

function readExcelDocument(noteId: string): ExcelRow | undefined {
  return getDb().prepare(`
    SELECT doc.noteId, doc.workspaceId, doc.data, doc.revision, doc.updatedAt, note.title
    FROM excel_documents doc
    JOIN notes note ON note.id = doc.noteId
    WHERE doc.noteId = ? AND note.note_type = 'excel' AND note.isTrashed = 0
  `).get(noteId) as ExcelRow | undefined;
}

function access(noteId: string, userId: string) {
  return resolveKnowledgeNodeAccess(`note:${noteId}`, userId, getDb());
}

function parseData(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

app.get("/capabilities", (c) => c.json({
  createEnabled: isExcelWorkbookCreationEnabled(),
  maxDataBytes: EXCEL_MAX_DATA_BYTES,
}));

app.post(
  "/",
  bodyLimit({
    maxSize: EXCEL_MAX_DATA_BYTES + 64 * 1024,
    onError: (c) => c.json({ error: "Excel 表格超过大小上限，未创建", code: "EXCEL_TOO_LARGE" }, 413),
  }),
  async (c) => {
    if (!isExcelWorkbookCreationEnabled()) {
      return c.json({ error: "Excel 表格尚未在此服务器开放", code: "EXCEL_WORKBOOK_DISABLED" }, 403);
    }
    const userId = c.req.header("X-User-Id") || "";
    const body = await c.req.json().catch(() => null) as {
      notebookId?: unknown;
      title?: unknown;
      data?: unknown;
    } | null;
    const notebookId = typeof body?.notebookId === "string" ? body.notebookId.trim() : "";
    if (!notebookId) {
      return c.json({ error: "必须指定目标 notebookId", code: "INVALID_PAYLOAD" }, 400);
    }
    const db = getDb();
    const notebook = db.prepare("SELECT id, userId, workspaceId FROM notebooks WHERE id = ? AND isDeleted = 0")
      .get(notebookId) as { id: string; userId: string; workspaceId: string | null } | undefined;
    const { permission } = resolveNotebookPermission(notebookId, userId);
    if (!notebook || !hasPermission(permission, "write")) {
      return c.json({ error: "目标笔记本不存在或无写入权限", code: "FORBIDDEN" }, notebook ? 403 : 404);
    }
    const title = typeof body?.title === "string" && body.title.trim()
      ? body.title.trim()
      : "无标题 Excel 表格";
    const initialInput = body?.data === undefined ? createDefaultExcelWorkbook(title) : body.data;
    const validated = validateExcelData(initialInput);
    if (!validated) {
      return c.json({ error: "Excel 表格数据格式无效或超过大小上限", code: "INVALID_PAYLOAD" }, 400);
    }
    const noteId = uuid();
    const contentText = serializeExcelText(validated.data);
    db.transaction(() => {
      db.prepare(`
        INSERT INTO notes (id, userId, workspaceId, notebookId, title, content, contentText, contentFormat, note_type)
        VALUES (?, ?, ?, ?, ?, '{}', ?, 'tiptap-json', 'excel')
      `).run(noteId, userId, notebook.workspaceId, notebook.id, title, contentText);
      db.prepare(`
        INSERT INTO excel_documents (noteId, userId, workspaceId, data)
        VALUES (?, ?, ?, ?)
      `).run(noteId, userId, notebook.workspaceId, validated.json);
      // 同步知识树节点，确保后续权限检查、目录展示和回收站恢复链路一致。
      synchronizeLegacyNoteHierarchy({
        db,
        noteId,
        actorUserId: userId,
        reason: "create",
        parentMode: "resource",
      });
    })();
    const created = readExcelDocument(noteId)!;
    return c.json({
      noteId: created.noteId,
      title: created.title,
      notebookId: notebook.id,
      workspaceId: created.workspaceId,
      data: validated.data,
      revision: created.revision,
      updatedAt: created.updatedAt,
      canEdit: true,
    }, 201);
  },
);

app.get("/:noteId", (c) => {
  const noteId = c.req.param("noteId");
  const userId = c.req.header("X-User-Id") || "";
  const row = readExcelDocument(noteId);
  // 先判存在再判权限会泄露存在性；不存在与无权统一按权限结果返回。
  const permission = access(noteId, userId);
  if (!hasKnowledgeCapability(permission, "canView")) {
    return c.json({ error: "无权访问该 Excel 表格", code: "FORBIDDEN" }, row ? 403 : 404);
  }
  if (!row) return c.json({ error: "Excel 表格不存在", code: "EXCEL_NOT_FOUND" }, 404);
  const data = parseData(row.data);
  // 快照损坏时明确报错，绝不以空工作簿顶替（否则下一次保存会覆盖原数据）。
  if (!data) return c.json({ error: "Excel 表格数据已损坏，已停止打开以免覆盖", code: "EXCEL_DATA_CORRUPT" }, 500);
  return c.json({
    noteId: row.noteId,
    title: row.title,
    workspaceId: row.workspaceId,
    data,
    revision: row.revision,
    updatedAt: row.updatedAt,
    canEdit: hasKnowledgeCapability(permission, "canEdit"),
  });
});

app.put(
  "/:noteId",
  bodyLimit({
    maxSize: EXCEL_MAX_DATA_BYTES + 64 * 1024,
    onError: (c) => c.json({ error: "Excel 表格超过大小上限，未保存", code: "EXCEL_TOO_LARGE" }, 413),
  }),
  async (c) => {
    const noteId = c.req.param("noteId");
    const userId = c.req.header("X-User-Id") || "";
    const permission = access(noteId, userId);
    const existing = readExcelDocument(noteId);
    if (!hasKnowledgeCapability(permission, "canView")) {
      return c.json({ error: "无权访问该 Excel 表格", code: "FORBIDDEN" }, existing ? 403 : 404);
    }
    if (!existing) return c.json({ error: "Excel 表格不存在", code: "EXCEL_NOT_FOUND" }, 404);
    if (!hasKnowledgeCapability(permission, "canEdit")) {
      return c.json({ error: "无权修改该 Excel 表格", code: "FORBIDDEN" }, 403);
    }
    const body = await c.req.json().catch(() => null) as { data?: unknown; expectedRevision?: unknown } | null;
    const expected = body?.expectedRevision;
    if (typeof expected !== "number" || !Number.isInteger(expected) || expected < 1) {
      return c.json({ error: "缺少 expectedRevision", code: "INVALID_PAYLOAD" }, 400);
    }
    const validated = validateExcelData(body?.data);
    if (!validated) return c.json({ error: "Excel 表格数据格式无效或超过大小上限", code: "INVALID_PAYLOAD" }, 400);

    const db = getDb();
    const write = db.transaction(() => {
      const result = db.prepare(`
        UPDATE excel_documents
        SET data = ?, revision = revision + 1, updatedAt = strftime('%Y-%m-%d %H:%M:%f', 'now')
        WHERE noteId = ? AND revision = ?
      `).run(validated.json, noteId, expected);
      if (result.changes === 0) return false;
      // 检索文本、笔记版本号与快照同事务提交：
      // FTS / 向量 / AI / MCP 沿用 notes 权限链路，同时触发 Sync V2 Outbox 与 Change Feed。
      db.prepare("UPDATE notes SET contentText = ?, version = version + 1, updatedAt = datetime('now') WHERE id = ?")
        .run(serializeExcelText(validated.data), noteId);
      return true;
    });
    if (!write()) {
      const latest = readExcelDocument(noteId);
      return c.json({
        error: "Excel 表格已在其他窗口更新",
        code: "EXCEL_CONFLICT",
        currentRevision: latest?.revision ?? null,
      }, 409);
    }
    const saved = readExcelDocument(noteId)!;
    return c.json({ noteId, revision: saved.revision, updatedAt: saved.updatedAt });
  },
);

export default app;
