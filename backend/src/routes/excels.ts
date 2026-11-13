import { validateExcelData, serializeExcelText } from "../services/excelData.js";
import { Hono } from "hono";
import { getDb } from "../db/schema.js";
import {
  hasKnowledgeCapability,
  resolveKnowledgeNodeAccess,
} from "../services/knowledgeCapabilities.js";

const app = new Hono();

interface ExcelRow {
  noteId: string;
  userId: string;
  workspaceId: string | null;
  data: string;
  createdAt: string;
  updatedAt: string;
}

function parseExcelData(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function readExcelDocument(noteId: string): ExcelRow | undefined {
  return getDb().prepare(`
    SELECT doc.noteId, doc.userId, doc.workspaceId, doc.data,
           doc.createdAt, doc.updatedAt
    FROM excel_documents doc
    JOIN notes note ON note.id = doc.noteId
    WHERE doc.noteId = ? AND note.note_type = 'excel' AND note.isTrashed = 0
  `).get(noteId) as ExcelRow | undefined;
}

function access(noteId: string, userId: string) {
  return resolveKnowledgeNodeAccess(`note:${noteId}`, userId, getDb());
}

app.get("/:noteId", (c) => {
  const noteId = c.req.param("noteId");
  const userId = c.req.header("X-User-Id") || "";
  const row = readExcelDocument(noteId);
  if (!row) return c.json({ error: "Excel 表格不存在", code: "EXCEL_NOT_FOUND" }, 404);
  const permission = access(noteId, userId);
  if (!hasKnowledgeCapability(permission, "canView")) {
    return c.json({ error: "无权访问该 Excel 表格", code: "FORBIDDEN" }, 403);
  }
  const note = getDb().prepare("SELECT title FROM notes WHERE id = ?").get(noteId) as { title: string };
  return c.json({
    noteId: row.noteId,
    title: note.title,
    workspaceId: row.workspaceId,
    data: parseExcelData(row.data),
    updatedAt: row.updatedAt,
    canEdit: hasKnowledgeCapability(permission, "canEdit"),
  });
});

app.put("/:noteId", async (c) => {
  const noteId = c.req.param("noteId");
  const userId = c.req.header("X-User-Id") || "";
  const existing = readExcelDocument(noteId);
  if (!existing) return c.json({ error: "Excel 表格不存在", code: "EXCEL_NOT_FOUND" }, 404);
  const permission = access(noteId, userId);
  if (!hasKnowledgeCapability(permission, "canEdit")) {
    return c.json({ error: "无权修改该 Excel 表格", code: "FORBIDDEN" }, 403);
  }
  const body = await c.req.json().catch(() => ({}));
  const data = validateExcelData(body.data);
  if (!data) return c.json({ error: "Excel 表格数据格式无效", code: "INVALID_PAYLOAD" }, 400);
  const expected = typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : null;
  if (expected && expected !== existing.updatedAt) {
    return c.json({
      error: "Excel 表格已在其他窗口更新，请重新加载",
      code: "EXCEL_CONFLICT",
      currentUpdatedAt: existing.updatedAt,
    }, 409);
  }
  const runUpdate = getDb().transaction(() => {
    const result = getDb().prepare(`
      UPDATE excel_documents SET data = ?, updatedAt = strftime('%Y-%m-%d %H:%M:%f', 'now')
      WHERE noteId = ? ${expected ? "AND updatedAt = ?" : ""}
    `).run(JSON.stringify(data), noteId, ...(expected ? [expected] : []));
    if (result.changes === 0) return false;
    // AI 调阅：把表格内容序列化写入 contentText，FTS / 向量 / AI 检索即可命中。
    getDb().prepare("UPDATE notes SET contentText = ? WHERE id = ?")
      .run(serializeExcelText(data), noteId);
    return true;
  });
  if (!runUpdate()) {
    const latest = readExcelDocument(noteId);
    return c.json({
      error: "Excel 表格已在其他窗口更新，请重新加载",
      code: "EXCEL_CONFLICT",
      currentUpdatedAt: latest?.updatedAt || null,
    }, 409);
  }
  const refreshed = readExcelDocument(noteId)!;
  return c.json({
    noteId,
    data: parseExcelData(refreshed.data),
    updatedAt: refreshed.updatedAt,
    canEdit: true,
  });
});

export default app;
