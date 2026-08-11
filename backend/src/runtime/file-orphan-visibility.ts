import type Database from "better-sqlite3";
import type { Context, Next } from "hono";

import { getDb } from "../db/schema.js";
import { createUserAttachmentAccessUrls } from "../lib/attachment-signed-url.js";

type FilesScope =
  | { kind: "personal"; workspaceId: null }
  | { kind: "workspace"; workspaceId: string };

type ReferenceNote = {
  id: string;
  title: string;
  notebookId: string | null;
  notebookName: string | null;
  notebookIcon: string | null;
  isTrashed: number;
};

type FileListRow = {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
  createdAt: string;
  noteId: string;
  hash: string | null;
  folderId: string | null;
  folderName: string | null;
  uploadSource: string | null;
};

const MANUAL_UPLOAD_SOURCE = "file_manager";

const THUMBNAILABLE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/bmp",
  "image/gif",
]);

function resolveScope(c: Context): FilesScope {
  const workspaceId = (c.req.query("workspaceId") || "").trim();
  return workspaceId
    ? { kind: "workspace", workspaceId }
    : { kind: "personal", workspaceId: null };
}

function appendAttachmentScope(
  where: string[],
  params: Array<string | number>,
  scope: FilesScope,
  userId: string,
  alias = "a",
): void {
  if (scope.kind === "workspace") {
    where.push(`${alias}.workspaceId = ?`);
    params.push(scope.workspaceId);
  } else {
    where.push(`${alias}.userId = ?`, `${alias}.workspaceId IS NULL`);
    params.push(userId);
  }
}

function appendNoteScope(
  where: string[],
  params: Array<string | number>,
  scope: FilesScope,
  userId: string,
  alias = "n",
): void {
  if (scope.kind === "workspace") {
    where.push(`${alias}.workspaceId = ?`);
    params.push(scope.workspaceId);
  } else {
    where.push(`${alias}.userId = ?`, `${alias}.workspaceId IS NULL`);
    params.push(userId);
  }
}

/**
 * 文件管理中的“孤儿”是一个只读状态，应立即反映 attachment_references 的真实结果。
 * 24 小时宽限只属于真正删除文件的 cleanup-orphans 接口，不能用于列表可见性。
 *
 * 文件管理手动上传（uploadSource=file_manager）代表用户明确保存的独立文件，属于
 * “未引用但受保护”，不应再被叫作孤儿，也不参与孤儿数量统计。
 */
export function getImmediateOrphanSummary(
  db: Database.Database,
  scope: FilesScope,
  userId: string,
): { count: number; bytes: number } {
  const where: string[] = [
    "EXISTS(SELECT 1 FROM notes owner_note WHERE owner_note.id = a.noteId)",
    "NOT EXISTS(SELECT 1 FROM attachment_references ar WHERE ar.attachmentId = a.id)",
    "COALESCE(a.uploadSource, '') <> 'file_manager'",
  ];
  const params: Array<string | number> = [];
  appendAttachmentScope(where, params, scope, userId);

  const row = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(COALESCE(a.size, 0)), 0) AS bytes
      FROM attachments a
     WHERE ${where.join(" AND ")}
  `).get(...params) as { count: number; bytes: number } | undefined;

  return {
    count: Number(row?.count || 0),
    bytes: Number(row?.bytes || 0),
  };
}

/**
 * 返回当前真正引用附件的首篇笔记。attachments.noteId 只是上传时归属，不能作为
 * “来源笔记/引用笔记”展示；删除正文图片后 attachment_references 会立即清掉。
 */
export function getCurrentReferenceNotes(
  db: Database.Database,
  attachmentIds: string[],
  scope: FilesScope,
  userId: string,
): Map<string, ReferenceNote> {
  const uniqueIds = Array.from(new Set(attachmentIds.filter(Boolean)));
  const result = new Map<string, ReferenceNote>();
  if (uniqueIds.length === 0) return result;

  const placeholders = uniqueIds.map(() => "?").join(",");
  const where = [`ar.attachmentId IN (${placeholders})`];
  const params: Array<string | number> = [...uniqueIds];
  appendNoteScope(where, params, scope, userId, "n");

  const rows = db.prepare(`
    SELECT ar.attachmentId,
           n.id,
           n.title,
           n.notebookId,
           n.isTrashed,
           n.updatedAt,
           nb.name AS notebookName,
           nb.icon AS notebookIcon
      FROM attachment_references ar
      INNER JOIN notes n ON n.id = ar.noteId
      LEFT JOIN notebooks nb ON nb.id = n.notebookId
     WHERE ${where.join(" AND ")}
     ORDER BY n.isTrashed ASC, n.updatedAt DESC, n.id ASC
  `).all(...params) as Array<{
    attachmentId: string;
    id: string;
    title: string;
    notebookId: string | null;
    isTrashed: number;
    updatedAt: string;
    notebookName: string | null;
    notebookIcon: string | null;
  }>;

  for (const row of rows) {
    if (result.has(row.attachmentId)) continue;
    result.set(row.attachmentId, {
      id: row.id,
      title: row.title || "",
      notebookId: row.notebookId,
      notebookName: row.notebookName,
      notebookIcon: row.notebookIcon,
      isTrashed: Number(row.isTrashed || 0),
    });
  }
  return result;
}

/** 返回本批附件里由文件管理手动上传、因此受自动清理保护的 id。 */
export function getProtectedManualUploadIds(
  db: Database.Database,
  attachmentIds: string[],
  scope: FilesScope,
  userId: string,
): Set<string> {
  const uniqueIds = Array.from(new Set(attachmentIds.filter(Boolean)));
  const result = new Set<string>();
  if (uniqueIds.length === 0) return result;

  const placeholders = uniqueIds.map(() => "?").join(",");
  const where = [
    `a.id IN (${placeholders})`,
    "a.uploadSource = ?",
  ];
  const params: Array<string | number> = [...uniqueIds, MANUAL_UPLOAD_SOURCE];
  appendAttachmentScope(where, params, scope, userId);

  const rows = db.prepare(`
    SELECT a.id
      FROM attachments a
     WHERE ${where.join(" AND ")}
  `).all(...params) as Array<{ id: string }>;

  for (const row of rows) result.add(row.id);
  return result;
}

function resolveOrderBy(sort: string | undefined): string {
  switch ((sort || "").toLowerCase()) {
    case "name_asc": return "a.filename COLLATE NOCASE ASC";
    case "name_desc": return "a.filename COLLATE NOCASE DESC";
    case "size_asc": return "a.size ASC";
    case "size_desc": return "a.size DESC";
    case "created_asc": return "a.createdAt ASC";
    case "created_desc":
    default: return "a.createdAt DESC";
  }
}

function toOrphanFileOut(row: FileListRow) {
  const mime = (row.mimeType || "").toLowerCase();
  const image = mime.startsWith("image/");
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    size: row.size,
    createdAt: row.createdAt,
    category: image ? "image" : "file",
    url: `/api/attachments/${row.id}`,
    ...(image && THUMBNAILABLE_MIMES.has(mime)
      ? { thumbnailUrl: `/api/attachments/${row.id}?w=240` }
      : {}),
    hash: row.hash ?? null,
    folderId: row.folderId ?? null,
    folderName: row.folderName ?? null,
    // 真正孤儿没有当前引用，也不是文件管理手动上传的受保护资产。
    primaryNote: null,
    isManualUpload: false,
    isAutoCleanupProtected: false,
  };
}

function buildImmediateOrphanList(
  db: Database.Database,
  c: Context,
  scope: FilesScope,
  userId: string,
) {
  const category = (c.req.query("category") || "all").toLowerCase();
  const mime = c.req.query("mime") || "";
  const notebookId = c.req.query("notebookId") || "";
  const noteId = c.req.query("noteId") || "";
  const folderId = c.req.query("folderId") || "";
  const q = (c.req.query("q") || "").trim();
  const page = Math.max(1, Number(c.req.query("page") || 1));
  const pageSize = Math.min(200, Math.max(1, Number(c.req.query("pageSize") || 50)));

  const where: string[] = [
    "NOT EXISTS(SELECT 1 FROM attachment_references ar WHERE ar.attachmentId = a.id)",
    "COALESCE(a.uploadSource, '') <> 'file_manager'",
  ];
  const params: Array<string | number> = [];
  appendAttachmentScope(where, params, scope, userId);

  if (category === "image") {
    where.push("a.mimeType LIKE 'image/%'");
  } else if (category === "file") {
    where.push("(a.mimeType IS NULL OR a.mimeType NOT LIKE 'image/%')");
  }
  if (mime) {
    where.push("a.mimeType = ?");
    params.push(mime.toLowerCase());
  }
  if (notebookId) {
    where.push("n.notebookId = ?");
    params.push(notebookId);
  }
  if (q) {
    where.push("a.filename LIKE ? COLLATE NOCASE");
    params.push(`%${q}%`);
  }
  if (folderId) {
    if (folderId === "__unarchived") {
      where.push("a.folderId IS NULL");
    } else {
      where.push("a.folderId = ?");
      params.push(folderId);
    }
  }
  // “某笔记引用的文件”和“无任何引用”互斥，明确返回空集。
  if (noteId) where.push("1 = 0");

  const whereSql = where.join(" AND ");
  const totalRow = db.prepare(`
    SELECT COUNT(*) AS count
      FROM attachments a
      INNER JOIN notes n ON n.id = a.noteId
      LEFT JOIN notebooks nb ON nb.id = n.notebookId
      LEFT JOIN attachment_folders af ON af.id = a.folderId
     WHERE ${whereSql}
  `).get(...params) as { count: number };

  const rows = db.prepare(`
    SELECT a.id,
           a.filename,
           a.mimeType,
           a.size,
           a.path,
           a.createdAt,
           a.noteId,
           a.hash,
           a.folderId,
           a.uploadSource,
           af.name AS folderName
      FROM attachments a
      INNER JOIN notes n ON n.id = a.noteId
      LEFT JOIN notebooks nb ON nb.id = n.notebookId
      LEFT JOIN attachment_folders af ON af.id = a.folderId
     WHERE ${whereSql}
     ORDER BY ${resolveOrderBy(c.req.query("sort"))}
     LIMIT ? OFFSET ?
  `).all(...params, pageSize, (page - 1) * pageSize) as FileListRow[];

  return {
    items: rows.map(toOrphanFileOut),
    accessUrls: createUserAttachmentAccessUrls(userId, rows),
    total: Number(totalRow?.count || 0),
    page,
    pageSize,
  };
}

function replaceJsonResponse(c: Context, payload: unknown): void {
  const original = c.res;
  const headers = new Headers(original.headers);
  headers.set("Content-Type", "application/json; charset=UTF-8");
  headers.delete("Content-Length");
  c.res = new Response(JSON.stringify(payload), {
    status: original.status,
    statusText: original.statusText,
    headers,
  });
}

function isFilesRoot(pathname: string): boolean {
  return /\/api\/files\/?$/.test(pathname);
}

function isFilesStats(pathname: string): boolean {
  return /\/api\/files\/stats\/?$/.test(pathname);
}

function isFilesDetail(pathname: string): boolean {
  return /\/api\/files\/[^/]+\/?$/.test(pathname) && !isFilesStats(pathname);
}

/**
 * 该中间件在原 filesRouter 完成鉴权和功能开关校验后再修正响应：
 * - 孤儿列表：立即反映真实引用，并排除用户主动保存的手动上传文件；
 * - 统计徽标：与孤儿列表使用相同口径；
 * - 普通列表“来源笔记”：改成当前真实引用；
 * - 列表和详情：为文件管理手动上传下发受保护标记，供 UI 展示绿色盾牌。
 */
export async function fileOrphanVisibilityMiddleware(c: Context, next: Next): Promise<void> {
  await next();

  if (c.req.method !== "GET" || !c.res.ok) return;
  const pathname = new URL(c.req.url).pathname;
  const userId = c.req.header("X-User-Id") || "";
  if (!userId) return;

  const db = getDb();
  const scope = resolveScope(c);

  if (isFilesStats(pathname)) {
    let payload: any;
    try {
      payload = await c.res.clone().json();
    } catch {
      return;
    }
    payload.unreferenced = getImmediateOrphanSummary(db, scope, userId);
    replaceJsonResponse(c, payload);
    return;
  }

  if (isFilesRoot(pathname)) {
    if ((c.req.query("filter") || "").toLowerCase() === "unreferenced") {
      replaceJsonResponse(c, buildImmediateOrphanList(db, c, scope, userId));
      return;
    }

    let payload: any;
    try {
      payload = await c.res.clone().json();
    } catch {
      return;
    }
    if (!Array.isArray(payload?.items) || payload.items.length === 0) return;

    const ids = payload.items
      .map((item: any) => typeof item?.id === "string" ? item.id : "")
      .filter(Boolean);
    const references = getCurrentReferenceNotes(db, ids, scope, userId);
    const protectedIds = getProtectedManualUploadIds(db, ids, scope, userId);
    payload.items = payload.items.map((item: any) => {
      const protectedManualUpload = protectedIds.has(item.id);
      return {
        ...item,
        primaryNote: references.get(item.id) || null,
        isManualUpload: protectedManualUpload,
        isAutoCleanupProtected: protectedManualUpload,
      };
    });
    replaceJsonResponse(c, payload);
    return;
  }

  if (isFilesDetail(pathname)) {
    let payload: any;
    try {
      payload = await c.res.clone().json();
    } catch {
      return;
    }
    const id = typeof payload?.id === "string" ? payload.id : "";
    if (!id) return;

    // 详情接口已经由原 filesRouter 完成用户/工作区可见性校验。这里直接读取该行的
    // 保留策略，避免工作区详情请求没有携带 workspaceId 时被误按个人空间判断。
    const retentionRow = db.prepare(
      "SELECT uploadSource FROM attachments WHERE id = ?",
    ).get(id) as { uploadSource: string | null } | undefined;
    const protectedManualUpload = retentionRow?.uploadSource === MANUAL_UPLOAD_SOURCE;

    payload.isManualUpload = protectedManualUpload;
    payload.isAutoCleanupProtected = protectedManualUpload;
    replaceJsonResponse(c, payload);
  }
}
