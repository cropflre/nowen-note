import { validateSheetData } from "../services/sheetData.js";
import { Hono } from "hono";
import { getDb } from "../db/schema.js";
import {
  hasKnowledgeCapability,
  resolveKnowledgeNodeAccess,
} from "../services/knowledgeCapabilities.js";

const app = new Hono();

interface SheetRow {
  noteId: string;
  userId: string;
  workspaceId: string | null;
  data: string;
  createdAt: string;
  updatedAt: string;
}

function parseSheetData(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function readSheet(noteId: string): SheetRow | undefined {
  return getDb().prepare(`
    SELECT sheet.noteId, sheet.userId, sheet.workspaceId, sheet.data,
           sheet.createdAt, sheet.updatedAt
    FROM sheets sheet
    JOIN notes note ON note.id = sheet.noteId
    WHERE sheet.noteId = ? AND note.note_type = 'sheet' AND note.isTrashed = 0
  `).get(noteId) as SheetRow | undefined;
}

function access(noteId: string, userId: string) {
  return resolveKnowledgeNodeAccess(`note:${noteId}`, userId, getDb());
}

app.get("/:noteId", (c) => {
  const noteId = c.req.param("noteId");
  const userId = c.req.header("X-User-Id") || "";
  const row = readSheet(noteId);
  if (!row) return c.json({ error: "表格不存在", code: "SHEET_NOT_FOUND" }, 404);
  const permission = access(noteId, userId);
  if (!hasKnowledgeCapability(permission, "canView")) {
    return c.json({ error: "无权访问该表格", code: "FORBIDDEN" }, 403);
  }
  const note = getDb().prepare("SELECT title FROM notes WHERE id = ?").get(noteId) as { title: string };
  return c.json({
    noteId: row.noteId,
    title: note.title,
    workspaceId: row.workspaceId,
    data: parseSheetData(row.data),
    updatedAt: row.updatedAt,
    canEdit: hasKnowledgeCapability(permission, "canEdit"),
  });
});

app.put("/:noteId", async (c) => {
  const noteId = c.req.param("noteId");
  const userId = c.req.header("X-User-Id") || "";
  const existing = readSheet(noteId);
  if (!existing) return c.json({ error: "表格不存在", code: "SHEET_NOT_FOUND" }, 404);
  const permission = access(noteId, userId);
  if (!hasKnowledgeCapability(permission, "canEdit")) {
    return c.json({ error: "无权修改该表格", code: "FORBIDDEN" }, 403);
  }
  const body = await c.req.json().catch(() => ({}));
  const data = validateSheetData(body.data);
  if (!data) return c.json({ error: "表格数据格式无效", code: "INVALID_PAYLOAD" }, 400);
  const expected = typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : null;
  if (expected && expected !== existing.updatedAt) {
    return c.json({
      error: "表格已在其他窗口更新，请重新加载",
      code: "SHEET_CONFLICT",
      currentUpdatedAt: existing.updatedAt,
    }, 409);
  }
  const result = getDb().prepare(`
    UPDATE sheets SET data = ?, updatedAt = strftime('%Y-%m-%d %H:%M:%f', 'now')
    WHERE noteId = ? ${expected ? "AND updatedAt = ?" : ""}
  `).run(JSON.stringify(data), noteId, ...(expected ? [expected] : []));
  if (result.changes === 0) {
    const latest = readSheet(noteId);
    return c.json({
      error: "表格已在其他窗口更新，请重新加载",
      code: "SHEET_CONFLICT",
      currentUpdatedAt: latest?.updatedAt || null,
    }, 409);
  }
  const refreshed = readSheet(noteId)!;
  return c.json({
    noteId,
    data: parseSheetData(refreshed.data),
    updatedAt: refreshed.updatedAt,
    canEdit: true,
  });
});

export default app;
