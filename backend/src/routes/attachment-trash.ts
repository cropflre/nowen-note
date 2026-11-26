import { Hono } from "hono";
import { getDb } from "../db/schema";
import { resolveFileAttachmentAccess, type FileAttachmentAccessRow } from "../services/fileAttachmentAccess";
import { attachmentDeletionRisk } from "../services/attachment-deletion-safety";
import { hasKnowledgeCapability, resolveResourceKnowledgeAccessForTombstone } from "../services/knowledgeCapabilities";
import { deleteThumbnailsFor } from "../services/thumbnails";
import { deleteAttachmentObject, getAttachmentsDir } from "../services/attachment-storage";
import { getUserWorkspaceRole, isFeatureEnabled, requireWorkspaceFeature, resolveWorkspaceFeatures } from "../middleware/acl";

type TrashRow = FileAttachmentAccessRow & { id: string; filename: string; mimeType: string; size: number; path: string; trashedAt: string | null; originalFolderId: string | null };
const canManage = (row: TrashRow, userId: string) => row.userId === userId && (row.uploadSource === "file_manager"
  ? resolveFileAttachmentAccess(row, userId).canWrite
  : hasKnowledgeCapability(resolveResourceKnowledgeAccessForTombstone("note", row.noteId, userId), "canEdit"));

function purgeRowsInTransaction(db: ReturnType<typeof getDb>, rows: TrashRow[]): string[] {
  const cacheOwners = new Set<string>();
  for (const row of rows) {
    cacheOwners.add(row.id);
    for (const relation of db.prepare("SELECT sourceAttachmentId FROM attachment_media_variants WHERE variantAttachmentId=?").all(row.id) as { sourceAttachmentId: string }[]) {
      cacheOwners.add(relation.sourceAttachmentId);
    }
    db.prepare("DELETE FROM attachment_media_variants WHERE variantAttachmentId=?").run(row.id);
    // Clear the retention marker only within the explicit purge transaction.
    db.prepare("UPDATE attachments SET trashedAt=NULL WHERE id=?").run(row.id);
    db.prepare("DELETE FROM attachments WHERE id=?").run(row.id);
  }
  return [...cacheOwners];
}

async function cleanupPurgedObjects(db: ReturnType<typeof getDb>, rows: TrashRow[], cacheOwners: string[]): Promise<string[]> {
  const cleanupPending: string[] = [];
  for (const id of cacheOwners) deleteThumbnailsFor(getAttachmentsDir(), id);
  for (const row of rows) {
    if (db.prepare("SELECT 1 FROM attachments WHERE path=? LIMIT 1").get(row.path)) continue;
    try { await deleteAttachmentObject(row.path); }
    catch { cleanupPending.push(row.id); }
  }
  return cleanupPending;
}

const app = new Hono();
app.use("*", requireWorkspaceFeature("files"));
app.use("*", async (c, next) => {
  if (!c.req.header("X-User-Id")) return c.json({ error: "未授权", code: "UNAUTHORIZED" }, 401);
  c.header("Cache-Control", "private, no-store");
  await next();
});
app.get("/", (c) => {
  const userId = c.req.header("X-User-Id")!;
  const workspaceId = c.req.query("workspaceId");
  const page = Number(c.req.query("page") || 1);
  const requestedSize = Number(c.req.query("pageSize") || 50);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(requestedSize) || requestedSize < 1) return c.json({ error: "无效的分页参数", code: "INVALID_PAGE" }, 400);
  const pageSize = Math.min(100, requestedSize);
  const rows = getDb().prepare(`SELECT a.* FROM attachments a WHERE a.userId=? AND a.workspaceId IS ? AND a.trashedAt IS NOT NULL ORDER BY a.trashedAt DESC,a.id`)
    .all(userId, workspaceId && workspaceId !== "personal" ? workspaceId : null) as TrashRow[];
  const visible = rows.filter((row) => canManage(row, userId));
  return c.json({ supported: true, entries: visible.slice((page - 1) * pageSize, page * pageSize).map((row) => ({
    id: row.id, filename: row.filename, mimeType: row.mimeType, size: row.size, trashedAt: row.trashedAt, originalFolderId: row.originalFolderId,
  })), total: visible.length, page, pageSize });
});
app.post("/empty", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (body?.confirmation !== "PERMANENTLY_DELETE") return c.json({ error: "请明确确认永久删除", code: "PURGE_CONFIRMATION_REQUIRED" }, 400);
  const queryWs = c.req.query("workspaceId");
  const bodyWs = typeof body.workspaceId === "string" ? body.workspaceId : undefined;
  if (queryWs !== undefined && bodyWs !== undefined && queryWs !== bodyWs) {
    return c.json({ error: "空间参数不一致", code: "SCOPE_MISMATCH" }, 400);
  }
  const rawWs = queryWs ?? bodyWs ?? "";
  const workspaceId = rawWs && rawWs !== "personal" ? rawWs : null;
  const userId = c.req.header("X-User-Id")!;
  if (workspaceId) {
    if (!getUserWorkspaceRole(workspaceId, userId)) return c.json({ error: "无权访问该工作区", code: "FORBIDDEN" }, 403);
    if (!isFeatureEnabled(resolveWorkspaceFeatures(workspaceId), "files")) {
      return c.json({ error: "该功能在当前工作区已被管理员关闭", code: "FEATURE_DISABLED", feature: "files" }, 403);
    }
  }
  const db = getDb();
  const { purged, skippedIds, cacheOwners } = db.transaction(() => {
    const rows = db.prepare("SELECT a.* FROM attachments a WHERE a.userId=? AND a.workspaceId IS ? AND a.trashedAt IS NOT NULL ORDER BY a.trashedAt DESC,a.id")
      .all(userId, workspaceId) as TrashRow[];
    const manageable = rows.filter((row) => canManage(row, userId));
    const safeRows: TrashRow[] = [];
    const protectedIds: string[] = [];
    for (const row of manageable) {
      if (attachmentDeletionRisk(row.id, { allowTrashed: true })) protectedIds.push(row.id);
      else safeRows.push(row);
    }
    const owners = purgeRowsInTransaction(db, safeRows);
    return { purged: safeRows, skippedIds: protectedIds, cacheOwners: owners };
  })();
  const cleanupPending = await cleanupPurgedObjects(db, purged, cacheOwners);
  return c.json({ success: true, count: purged.length, skipped: skippedIds.length, skippedIds, cleanupPending });
});
app.post("/:action", async (c) => {
  const action = c.req.param("action");
  if (action !== "restore" && action !== "purge") return c.json({ error: "未知操作" }, 404);
  const body = await c.req.json().catch(() => null);
  if (!Array.isArray(body?.ids) || body.ids.length < 1 || body.ids.length > 200 || body.ids.some((id: unknown) => typeof id !== "string" || !id)) {
    return c.json({ error: "请选择 1–200 个文件", code: "INVALID_FILE_IDS" }, 400);
  }
  if (action === "purge" && body.confirmation !== "PERMANENTLY_DELETE") return c.json({ error: "请明确确认永久删除", code: "PURGE_CONFIRMATION_REQUIRED" }, 400);
  const ids = [...new Set<string>(body.ids)];
  const userId = c.req.header("X-User-Id")!;
  const db = getDb();
  // Validate the whole batch before changing any row. Physical cleanup follows the DB commit.
  const result = db.transaction(() => {
    const rows = ids.map((id) => db.prepare("SELECT * FROM attachments WHERE id=?").get(id) as TrashRow | undefined);
    if (rows.some((row) => !row || row.userId !== userId || !canManage(row, userId))) {
      return { status: 403 as const, error: "文件不存在或无权管理", code: "FORBIDDEN" };
    }
    if (rows.some((row) => !row!.trashedAt)) return { status: 409 as const, error: "只能操作回收站内的文件", code: "FILE_NOT_TRASHED" };
    if (action === "restore" && body.expectedTrashedAt !== undefined) {
      if (!body.expectedTrashedAt || typeof body.expectedTrashedAt !== "object" || Array.isArray(body.expectedTrashedAt)
          || rows.some((row) => !Object.prototype.hasOwnProperty.call(body.expectedTrashedAt, row!.id)
            || body.expectedTrashedAt[row!.id] !== row!.trashedAt)) {
        return { status: 409 as const, error: "回收站文件已变化，请重新预览", code: "FILE_TRASH_VERSION_CONFLICT" };
      }
    }
    if (action === "purge") {
      for (const id of ids) {
        const risk = attachmentDeletionRisk(id, { allowTrashed: true });
        if (risk) return { status: 409 as const, ...risk };
      }
    }
    const restored: { id: string; folderId: string | null; fallback: boolean }[] = [];
    let cacheOwners: string[] = [];
    if (action === "restore") {
      for (const row of rows as TrashRow[]) {
        const folder = row.originalFolderId && !row.workspaceId ? db.prepare("SELECT id FROM attachment_folders WHERE id=? AND userId=?").get(row.originalFolderId, userId) : null;
        const folderId = folder ? row.originalFolderId : null;
        db.prepare("UPDATE attachments SET folderId=?,trashedAt=NULL,trashedBy=NULL,originalFolderId=NULL WHERE id=?").run(folderId, row.id);
        restored.push({ id: row.id, folderId, fallback: !!row.originalFolderId && !folderId });
      }
    } else {
      cacheOwners = purgeRowsInTransaction(db, rows as TrashRow[]);
    }
    return { status: 200 as const, rows: rows as TrashRow[], restored, cacheOwners };
  })();
  if (result.status !== 200) return c.json({ error: result.error, code: result.code }, result.status);
  const cleanupPending = action === "purge" ? await cleanupPurgedObjects(db, result.rows, result.cacheOwners) : [];
  return c.json({ success: true, count: ids.length, restored: result.restored, cleanupPending });
});
export default app;
