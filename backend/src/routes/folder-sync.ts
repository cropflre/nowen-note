import { Hono } from "hono";
import { getDb } from "../db/schema";
import { v4 as uuid } from "uuid";
import {
  resolveNotebookPermission,
  hasPermission,
} from "../middleware/acl";
import { broadcastNoteUpdated } from "../services/realtime";

const app = new Hono();

// 安全校验：拒绝绝对路径和路径穿越
function isUnsafePath(p: string): boolean {
  if (!p || typeof p !== "string") return true;
  if (/^[A-Za-z]:/.test(p)) return true;
  if (p.startsWith("/")) return true;
  if (p.includes("..")) return true;
  if (p.length > 1024) return true;
  return false;
}

function filenameToTitle(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot > 0) return filename.slice(0, lastDot);
  return filename;
}

function isTextFile(filename: string): boolean {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return [".md", ".txt", ".markdown", ".html", ".htm", ".csv", ".json", ".xml"].includes(ext);
}

function isBinaryFile(filename: string): boolean {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return [".pdf", ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt", ".odt", ".ods"].includes(ext);
}

/** 构建 sync 元信息 HTML 注释 */
function buildSyncComment(relativePath: string, sha256: string, sourcePathHash: string): string {
  return `\n\n<!-- nowen-folder-sync: sourcePathHash=${sourcePathHash} sha256=${sha256} relativePath=${relativePath} -->`;
}

/**
 * POST /api/folder-sync/import-file
 */
app.post("/import-file", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const body = await c.req.json();

  const {
    filename,
    relativePath,
    sha256,
    targetNotebookId,
    contentText,
    sourcePathHash,
    existingNoteId,
  } = body as {
    filename?: string;
    relativePath?: string;
    sha256?: string;
    targetNotebookId?: string;
    contentText?: string;
    sourcePathHash?: string;
    existingNoteId?: string;
  };

  // 参数校验
  if (!filename || typeof filename !== "string" || filename.length > 255) {
    return c.json({ error: "filename 无效", code: "INVALID_FILENAME" }, 400);
  }
  if (!relativePath || isUnsafePath(relativePath)) {
    return c.json({ error: "relativePath 无效或包含不安全路径", code: "UNSAFE_PATH" }, 400);
  }
  if (!sha256 || typeof sha256 !== "string" || sha256.length !== 64) {
    return c.json({ error: "sha256 无效", code: "INVALID_HASH" }, 400);
  }
  if (!targetNotebookId) {
    return c.json({ error: "targetNotebookId 不能为空", code: "MISSING_NOTEBOOK" }, 400);
  }
  if (!sourcePathHash || typeof sourcePathHash !== "string") {
    return c.json({ error: "sourcePathHash 无效", code: "INVALID_SOURCE_HASH" }, 400);
  }
  if (contentText && contentText.length > 2 * 1024 * 1024) {
    return c.json({ error: "contentText 超过 2MB 限制", code: "CONTENT_TOO_LARGE" }, 400);
  }

  // 校验目标笔记本权限
  const nb = db
    .prepare("SELECT id, workspaceId, isDeleted FROM notebooks WHERE id = ?")
    .get(targetNotebookId) as { id: string; workspaceId: string | null; isDeleted: number } | undefined;
  if (!nb) return c.json({ error: "目标笔记本不存在", code: "NOTEBOOK_NOT_FOUND" }, 404);
  if (nb.isDeleted === 1) return c.json({ error: "目标笔记本已删除", code: "NOTEBOOK_TRASHED" }, 400);
  const { permission } = resolveNotebookPermission(targetNotebookId, userId);
  if (!hasPermission(permission, "write")) {
    return c.json({ error: "您在该笔记本无写入权限", code: "FORBIDDEN" }, 403);
  }
  const workspaceId = nb.workspaceId;

  // 查找已有同步映射
  const syncRow = db
    .prepare("SELECT id, noteId, sha256 AS oldSha FROM folder_sync_files WHERE userId = ? AND sourcePathHash = ?")
    .get(userId, sourcePathHash) as { id: string; noteId: string; oldSha: string } | undefined;

  // 确定更新目标
  let updateNoteId: string | null = null;
  if (existingNoteId) {
    const target = db.prepare("SELECT id, userId FROM notes WHERE id = ?").get(existingNoteId) as { id: string; userId: string } | undefined;
    if (!target) return c.json({ error: "指定的笔记不存在", code: "NOTE_NOT_FOUND" }, 404);
    if (target.userId !== userId) return c.json({ error: "无权修改他人的笔记", code: "FORBIDDEN" }, 403);
    updateNoteId = existingNoteId;
  } else if (syncRow) {
    updateNoteId = syncRow.noteId;
  }

  // sha256 去重：如果映射表里 sha256 未变，跳过
  if (syncRow && syncRow.oldSha === sha256 && updateNoteId) {
    return c.json({
      success: true, created: false, updated: false, skipped: true,
      reason: "unchanged", noteId: updateNoteId, sha256,
    });
  }

  const title = filenameToTitle(filename);
  const syncComment = buildSyncComment(relativePath, sha256, sourcePathHash);
  const isText = isTextFile(filename);
  const isBinary = isBinaryFile(filename);

  // 构建纯 Markdown 正文（不使用 JSON 包装）
  let content: string;
  let finalContentText: string;

  if (isText && contentText) {
    content = contentText + syncComment;
    finalContentText = contentText;
  } else if (isBinary) {
    const lines = [
      `# ${title}`,
      "",
      "此文件来自桌面端文件夹同步。",
      "",
      `- 文件名：${filename}`,
      `- 相对路径：${relativePath}`,
      `- SHA-256：${sha256}`,
      "",
      "附件内容将在后续阶段支持上传。",
    ];
    content = lines.join("\n") + syncComment;
    finalContentText = content;
  } else {
    const text = contentText || "";
    content = text + syncComment;
    finalContentText = text;
  }

  if (updateNoteId) {
    // 更新已有笔记
    db.prepare(
      `UPDATE notes SET title = ?, content = ?, contentText = ?, notebookId = ?, workspaceId = ?,
       contentFormat = 'markdown', version = version + 1, updatedAt = datetime('now')
       WHERE id = ?`
    ).run(title, content, finalContentText, targetNotebookId, workspaceId, updateNoteId);

    // 更新映射
    if (syncRow) {
      db.prepare("UPDATE folder_sync_files SET sha256 = ?, relativePath = ?, filename = ?, updatedAt = datetime('now') WHERE id = ?")
        .run(sha256, relativePath, filename, syncRow.id);
    } else {
      db.prepare("INSERT INTO folder_sync_files (id, userId, sourcePathHash, relativePath, filename, sha256, noteId) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(uuid(), userId, sourcePathHash, relativePath, filename, sha256, updateNoteId);
    }

    const updated = db.prepare("SELECT version, updatedAt FROM notes WHERE id = ?").get(updateNoteId) as { version: number; updatedAt: string };
    try {
      broadcastNoteUpdated(updateNoteId, {
        version: updated.version, updatedAt: updated.updatedAt,
        title, contentText: finalContentText.slice(0, 200), actorUserId: userId,
      });
    } catch { /* ignore */ }

    return c.json({ success: true, created: false, updated: true, skipped: false, noteId: updateNoteId, sha256 });
  }

  // 创建新笔记
  const noteId = uuid();
  try {
    db.prepare(
      `INSERT INTO notes (id, userId, notebookId, workspaceId, title, content, contentText, contentFormat)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'markdown')`
    ).run(noteId, userId, targetNotebookId, workspaceId, title, content, finalContentText);
  } catch (e: any) {
    if (String(e?.code || "").startsWith("SQLITE_CONSTRAINT")) {
      return c.json({ error: "笔记创建失败：ID 冲突", code: "ID_CONFLICT" }, 409);
    }
    throw e;
  }

  // 创建映射
  db.prepare("INSERT INTO folder_sync_files (id, userId, sourcePathHash, relativePath, filename, sha256, noteId) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(uuid(), userId, sourcePathHash, relativePath, filename, sha256, noteId);

  return c.json({ success: true, created: true, updated: false, skipped: false, noteId, sha256 });
});

/**
 * POST /api/folder-sync/check-dedup
 */
app.post("/check-dedup", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const body = await c.req.json();
  const hashes = body.sourcePathHashes as string[] | undefined;

  if (!Array.isArray(hashes) || hashes.length === 0) return c.json({});
  if (hashes.length > 500) return c.json({ error: "单次最多检查 500 条", code: "TOO_MANY" }, 400);

  const result: Record<string, string> = {};
  const placeholders = hashes.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT sourcePathHash, noteId FROM folder_sync_files WHERE userId = ? AND sourcePathHash IN (${placeholders})`)
    .all(userId, ...hashes) as { sourcePathHash: string; noteId: string }[];
  for (const row of rows) {
    result[row.sourcePathHash] = row.noteId;
  }
  return c.json(result);
});

export default app;
