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
  // Windows 盘符
  if (/^[A-Za-z]:/.test(p)) return true;
  // 以 / 开头（绝对路径）
  if (p.startsWith("/")) return true;
  // 路径穿越
  if (p.includes("..")) return true;
  // 长度限制
  if (p.length > 1024) return true;
  return false;
}

// 从文件名推断标题（去掉扩展名）
function filenameToTitle(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot > 0) return filename.slice(0, lastDot);
  return filename;
}

// 根据扩展名判断是否为文本类型
function isTextFile(filename: string): boolean {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return [".md", ".txt", ".markdown", ".html", ".htm", ".csv", ".json", ".xml"].includes(ext);
}

// 根据扩展名判断是否为二进制类型（pdf/docx 等）
function isBinaryFile(filename: string): boolean {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return [".pdf", ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt", ".odt", ".ods"].includes(ext);
}

/**
 * POST /api/folder-sync/import-file
 *
 * 接收单个文件内容，创建或更新 Nowen 笔记。
 *
 * 请求 JSON：
 *   filename        文件名（如 "readme.md"）
 *   relativePath    相对路径（如 "docs/readme.md"）
 *   sha256          文件内容 hash
 *   targetNotebookId  目标笔记本
 *   contentText     文本内容（md/txt/html）
 *   sourcePathHash  relativePath 的 sha256
 *   existingNoteId  可选，更新已有笔记
 *
 * 返回：
 *   success, created, updated, skipped, noteId, sha256
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
  if (!nb) {
    return c.json({ error: "目标笔记本不存在", code: "NOTEBOOK_NOT_FOUND" }, 404);
  }
  if (nb.isDeleted === 1) {
    return c.json({ error: "目标笔记本已删除", code: "NOTEBOOK_TRASHED" }, 400);
  }
  const { permission } = resolveNotebookPermission(targetNotebookId, userId);
  if (!hasPermission(permission, "write")) {
    return c.json({ error: "您在该笔记本无写入权限", code: "FORBIDDEN" }, 403);
  }

  const workspaceId = nb.workspaceId;

  // 检查是否已有相同 sourcePathHash 的笔记（去重）
  const existingBySource = db
    .prepare(
      `SELECT id, version FROM notes
       WHERE userId = ? AND json_extract(content, '$._sync.sourcePathHash') = ?
       LIMIT 1`
    )
    .get(userId, sourcePathHash) as { id: string; version: number } | undefined;

  // 如果指定了 existingNoteId，校验权限
  let updateTarget: { id: string; version: number } | null = null;
  if (existingNoteId) {
    const target = db
      .prepare("SELECT id, version, userId, workspaceId FROM notes WHERE id = ?")
      .get(existingNoteId) as { id: string; version: number; userId: string; workspaceId: string | null } | undefined;
    if (!target) {
      return c.json({ error: "指定的笔记不存在", code: "NOTE_NOT_FOUND" }, 404);
    }
    if (target.userId !== userId) {
      return c.json({ error: "无权修改他人的笔记", code: "FORBIDDEN" }, 403);
    }
    updateTarget = target;
  } else if (existingBySource) {
    // 通过 sourcePathHash 找到已有笔记
    updateTarget = existingBySource;
  }

  // 如果是更新，检查 sha256 是否变化
  if (updateTarget) {
    const meta = db
      .prepare("SELECT content FROM notes WHERE id = ?")
      .get(updateTarget.id) as { content: string } | undefined;
    if (meta) {
      try {
        const parsed = JSON.parse(meta.content);
        if (parsed?._sync?.sha256 === sha256) {
          return c.json({
            success: true,
            created: false,
            updated: false,
            skipped: true,
            reason: "unchanged",
            noteId: updateTarget.id,
            sha256,
          });
        }
      } catch { /* content 不是 JSON，继续更新 */ }
    }
  }

  const title = filenameToTitle(filename);
  const now = new Date().toISOString();
  const isText = isTextFile(filename);
  const isBinary = isBinaryFile(filename);

  // 构建正文
  let content: string;
  let finalContentText: string;

  if (isText && contentText) {
    // 文本文件：直接作为正文，末尾追加 sync 元信息注释
    const syncMeta = `\n\n<!-- nowen-folder-sync: relativePath=${relativePath} sha256=${sha256} sourcePathHash=${sourcePathHash} -->`;
    content = contentText + syncMeta;
    finalContentText = contentText;
  } else if (isBinary) {
    // 二进制文件：创建索引笔记
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
    content = lines.join("\n");
    finalContentText = content;
  } else {
    // 其他文本类型
    const text = contentText || "";
    const syncMeta = `\n\n<!-- nowen-folder-sync: relativePath=${relativePath} sha256=${sha256} sourcePathHash=${sourcePathHash} -->`;
    content = text + syncMeta;
    finalContentText = text;
  }

  // 将 sync 元信息嵌入 content JSON（如果 content 是 JSON 格式）
  // 对于纯文本，直接存为字符串
  // 我们用一个轻量方式：在 contentText 之外，用 content 存带 _sync 元数据的 JSON
  const contentJson = JSON.stringify({
    type: isText ? "text" : "index",
    body: content,
    _sync: {
      sourceType: "desktop-folder-sync",
      sourcePathHash,
      sha256,
      relativePath,
      filename,
      importedAt: now,
    },
  });

  if (updateTarget) {
    // 更新已有笔记
    db.prepare(
      `UPDATE notes SET
        title = ?,
        content = ?,
        contentText = ?,
        notebookId = ?,
        workspaceId = ?,
        version = version + 1,
        updatedAt = datetime('now')
       WHERE id = ?`
    ).run(title, contentJson, finalContentText, targetNotebookId, workspaceId, updateTarget.id);

    const updated = db.prepare("SELECT version, updatedAt FROM notes WHERE id = ?").get(updateTarget.id) as { version: number; updatedAt: string };

    try {
      broadcastNoteUpdated(updateTarget.id, {
        version: updated.version,
        updatedAt: updated.updatedAt,
        title,
        contentText: finalContentText.slice(0, 200),
        actorUserId: userId,
      });
    } catch { /* ignore */ }

    return c.json({
      success: true,
      created: false,
      updated: true,
      skipped: false,
      noteId: updateTarget.id,
      sha256,
    });
  }

  // 创建新笔记
  const noteId = uuid();
  try {
    db.prepare(
      `INSERT INTO notes (id, userId, notebookId, workspaceId, title, content, contentText)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(noteId, userId, targetNotebookId, workspaceId, title, contentJson, finalContentText);
  } catch (e: any) {
    if (String(e?.code || "").startsWith("SQLITE_CONSTRAINT")) {
      return c.json({ error: "笔记创建失败：ID 冲突", code: "ID_CONFLICT" }, 409);
    }
    throw e;
  }

  return c.json({
    success: true,
    created: true,
    updated: false,
    skipped: false,
    noteId,
    sha256,
  });
});

/**
 * POST /api/folder-sync/check-dedup
 *
 * 批量检查 sourcePathHash 是否已存在，返回已存在的 noteId 映射。
 * Electron 上传前先调这个，避免重复上传未变化的文件。
 *
 * 请求 JSON：
 *   sourcePathHashes: string[]
 *
 * 返回：
 *   { [sourcePathHash]: noteId }
 */
app.post("/check-dedup", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const body = await c.req.json();
  const hashes = body.sourcePathHashes as string[] | undefined;

  if (!Array.isArray(hashes) || hashes.length === 0) {
    return c.json({});
  }
  if (hashes.length > 500) {
    return c.json({ error: "单次最多检查 500 条", code: "TOO_MANY" }, 400);
  }

  const result: Record<string, string> = {};
  // 用 json_extract 查找 _sync.sourcePathHash
  // 注意：SQLite json_extract 性能在大表上可能较慢，但 folder-sync 场景通常量不大
  for (const hash of hashes) {
    const row = db
      .prepare(
        `SELECT id FROM notes
         WHERE userId = ? AND json_extract(content, '$._sync.sourcePathHash') = ?
         LIMIT 1`
      )
      .get(userId, hash) as { id: string } | undefined;
    if (row) {
      result[hash] = row.id;
    }
  }

  return c.json(result);
});

export default app;
