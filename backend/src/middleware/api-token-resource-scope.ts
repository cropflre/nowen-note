import type { Context, Next } from "hono";
import { getDb } from "../db/schema";
import { listKnowledgeTree } from "../services/knowledgeTree.js";
import { createHash } from "node:crypto";
import { hasPermission, resolveNotebookPermission } from "./acl";
import { logAudit } from "../services/audit";

export type ApiTokenResourcePermission = "read" | "write";

interface NotebookGrant {
  notebookId: string;
  level: number;
}

interface TokenAccessContext {
  tokenId: string;
  userId: string;
  resourceMode: "unrestricted" | "restricted";
  scopes: Set<string>;
  notebooks: Map<string, number>;
}

class ApiTokenAccessError extends Error {
  constructor(
    message: string,
    readonly code = "API_TOKEN_RESOURCE_DENIED",
    readonly status = 403,
  ) {
    super(message);
    this.name = "ApiTokenAccessError";
  }
}

function parseScopes(value: string | undefined): Set<string> {
  return new Set((value || "").split(",").map((item) => item.trim()).filter(Boolean));
}

function loadNotebookGrants(tokenId: string, includeDeleted = false): Map<string, number> {
  const db = getDb();
  const rows = db.prepare(`
    WITH RECURSIVE scoped(id, level, recurse) AS (
      SELECT
        r.resourceId,
        CASE WHEN r.permission = 'write' THEN 2 ELSE 1 END,
        r.includeDescendants
      FROM api_token_resources r
      WHERE r.tokenId = ? AND r.resourceType = 'notebook'
      UNION
      SELECT
        n.id,
        scoped.level,
        scoped.recurse
      FROM notebooks n
      JOIN scoped ON n.parentId = scoped.id
      WHERE scoped.recurse = 1 AND (? = 1 OR n.isDeleted = 0)
    )
    SELECT id AS notebookId, MAX(level) AS level
    FROM scoped
    GROUP BY id
  `).all(tokenId, includeDeleted ? 1 : 0) as NotebookGrant[];

  return new Map(rows.map((row) => [row.notebookId, Number(row.level) || 1]));
}

function getContext(c: Context): TokenAccessContext | null {
  if (c.req.header("X-Auth-Mode") !== "api-token") return null;
  const tokenId = c.req.header("X-Api-Token-Id") || "";
  const userId = c.req.header("X-User-Id") || "";
  if (!tokenId || !userId) {
    throw new ApiTokenAccessError("API Token 上下文不完整", "API_TOKEN_CONTEXT_INVALID", 401);
  }
  const resourceMode = c.req.header("X-Api-Resource-Mode") === "restricted"
    ? "restricted"
    : "unrestricted";
  return {
    tokenId,
    userId,
    resourceMode,
    scopes: parseScopes(c.req.header("X-Api-Scopes")),
    notebooks: resourceMode === "restricted" ? loadNotebookGrants(tokenId) : new Map(),
  };
}

function requireScope(ctx: TokenAccessContext, scope: string): void {
  if (ctx.scopes.has(scope)) return;
  throw new ApiTokenAccessError(`当前 API Token 缺少 scope: ${scope}`, "API_TOKEN_SCOPE_REQUIRED");
}

function canRead(ctx: TokenAccessContext, notebookId: string | null | undefined): boolean {
  if (ctx.resourceMode !== "restricted") return true;
  return Boolean(notebookId && (ctx.notebooks.get(notebookId) || 0) >= 1);
}

function canWrite(ctx: TokenAccessContext, notebookId: string | null | undefined): boolean {
  if (ctx.resourceMode !== "restricted") return true;
  return Boolean(notebookId && (ctx.notebooks.get(notebookId) || 0) >= 2);
}

function assertNotebook(ctx: TokenAccessContext, notebookId: string | null | undefined, write = false): void {
  const allowed = write ? canWrite(ctx, notebookId) : canRead(ctx, notebookId);
  if (allowed) return;
  throw new ApiTokenAccessError(
    `API Token 无权${write ? "写入" : "读取"}笔记本: ${notebookId || "未指定"}`,
  );
}

function resolveNoteNotebookId(noteId: string): string | null {
  const row = getDb().prepare("SELECT notebookId FROM notes WHERE id = ?").get(noteId) as
    | { notebookId: string }
    | undefined;
  return row?.notebookId || null;
}

function resolveAttachmentNotebookIds(attachmentId: string): string[] {
  const db = getDb();
  const ids = new Set<string>();
  const primary = db.prepare(`
    SELECT n.notebookId
    FROM attachments a
    LEFT JOIN notes n ON n.id = a.noteId
    WHERE a.id = ?
  `).get(attachmentId) as { notebookId?: string | null } | undefined;
  if (primary?.notebookId) ids.add(primary.notebookId);

  try {
    const refs = db.prepare(`
      SELECT DISTINCT n.notebookId
      FROM attachment_references ar
      JOIN notes n ON n.id = ar.noteId
      WHERE ar.attachmentId = ?
    `).all(attachmentId) as Array<{ notebookId?: string | null }>;
    for (const row of refs) if (row.notebookId) ids.add(row.notebookId);
  } catch {
    // 老数据库尚无 attachment_references 时，退回首次归属笔记。
  }
  return Array.from(ids);
}

function assertAttachment(ctx: TokenAccessContext, attachmentId: string, write = false): void {
  const notebookIds = resolveAttachmentNotebookIds(attachmentId);
  const allowed = write
    ? notebookIds.length > 0 && notebookIds.every((id) => canWrite(ctx, id))
    : notebookIds.some((id) => canRead(ctx, id));
  if (!allowed) throw new ApiTokenAccessError("附件不属于当前 API Token 的笔记本范围");
}

function jsonResponse(body: unknown, status: number, source?: Headers): Response {
  const headers = new Headers(source);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.delete("Content-Length");
  headers.delete("Content-Encoding");
  headers.delete("Transfer-Encoding");
  return new Response(JSON.stringify(body), { status, headers });
}

async function readResponseJson(response: Response): Promise<any> {
  try {
    return await response.clone().json();
  } catch {
    return null;
  }
}

async function replaceFilteredResponse(c: Context, filter: (body: any) => any): Promise<void> {
  const body = await readResponseJson(c.res);
  if (body === null) return;
  c.res = jsonResponse(filter(body), c.res.status, c.res.headers);
}

/**
 * Restricted Token 的笔记本列表不能依赖 /api/notebooks 的默认“个人空间”查询。
 * Token 已经显式保存了 notebookId 白名单，因此这里以授权表为发现入口，再与用户
 * 当前 ACL 求交集。这样工作区成员身份被撤销后，历史 Token grant 也不会继续泄露资源。
 */
function listGrantedNotebookCatalog(ctx: TokenAccessContext): any[] {
  const ids = Array.from(ctx.notebooks.keys()).filter((id) => canRead(ctx, id));
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => "?").join(",");
  const rows = getDb().prepare(`
    SELECT
      nb.*,
      COALESCE((
        SELECT COUNT(*)
        FROM notes n
        WHERE n.notebookId = nb.id AND n.isTrashed = 0
      ), 0) AS noteCount,
      ws.name AS workspaceName
    FROM notebooks nb
    LEFT JOIN workspaces ws ON ws.id = nb.workspaceId
    WHERE nb.id IN (${placeholders})
      AND nb.isDeleted = 0
    ORDER BY
      CASE WHEN nb.workspaceId IS NULL THEN 0 ELSE 1 END ASC,
      COALESCE(ws.name, '') COLLATE NOCASE ASC,
      nb.sortOrder ASC,
      nb.name COLLATE NOCASE ASC,
      nb.id ASC
  `).all(...ids) as Array<Record<string, any>>;

  return rows.filter((row) => {
    const { permission } = resolveNotebookPermission(String(row.id || ""), ctx.userId);
    return hasPermission(permission, "read");
  });
}

function requiredScope(pathname: string, method: string): string | null {
  const write = !["GET", "HEAD", "OPTIONS"].includes(method);
  if (pathname === "/api/me") return null;
  if (pathname.startsWith("/api/tokens")) return "__login_only__";
  if (pathname.startsWith("/api/task-digest")) return "__login_only__";
  if (pathname === "/api/automations" || pathname.startsWith("/api/automations/")) return write ? "automations:write" : "automations:read";
  if (pathname.startsWith("/api/ai/task-plan")) return "__login_only__";
  if (pathname === "/api/task-reminders" || pathname.startsWith("/api/task-reminders/")) return write ? "tasks:write" : "tasks:read";
  if (pathname === "/api/tasks" || pathname.startsWith("/api/tasks/") || pathname === "/api/task-projects" || pathname.startsWith("/api/task-projects/")) return write ? "tasks:write" : "tasks:read";
  if (pathname === "/api/knowledge-tree" || pathname.startsWith("/api/knowledge-tree/")) return write ? "notebooks:write" : "notebooks:read";
  if (pathname.startsWith("/api/notebooks")) return write ? "notebooks:write" : "notebooks:read";
  if (pathname.startsWith("/api/note-templates")) return write ? "notes:write" : "notes:read";
  if (pathname.startsWith("/api/notes")) return write ? "notes:write" : "notes:read";
  if (pathname.startsWith("/api/blocks")) return write ? "notes:write" : "notes:read";
  if (pathname.startsWith("/api/search")) return "notes:read";
  if (pathname.startsWith("/api/attachment-folders") || pathname.startsWith("/api/files/trash")) {
    return write ? "attachments:write" : "notes:read";
  }
  if (pathname.startsWith("/api/files") || pathname.startsWith("/api/attachments")) {
    return write ? "attachments:write" : "notes:read";
  }
  if (pathname.startsWith("/api/tags")) return write ? "tags:write" : "tags:read";
  if (pathname === "/api/ai/ask") return "notes:read";
  if (pathname === "/api/ai/chat") return "notes:write";
  if (pathname.startsWith("/api/export")) return "export:import";
  return "__unsupported__";
}

async function handleNotebooks(c: Context, next: Next, ctx: TokenAccessContext): Promise<void> {
  const path = c.req.path;
  const method = c.req.method.toUpperCase();
  const segments = path.split("/").filter(Boolean);

  if (path === "/api/notebooks" || path === "/api/notebooks/shared-with-me") {
    if (method === "GET") {
      await next();
      if (path === "/api/notebooks" && c.res.status >= 200 && c.res.status < 300) {
        c.res = jsonResponse(listGrantedNotebookCatalog(ctx), c.res.status, c.res.headers);
        return;
      }
      await replaceFilteredResponse(c, (body) => Array.isArray(body)
        ? body.filter((item) => canRead(ctx, item?.id))
        : body);
      return;
    }
    const body = await c.req.raw.clone().json().catch(() => ({})) as { parentId?: string };
    if (!body.parentId) {
      throw new ApiTokenAccessError("restricted Token 只能在已授权父笔记本下创建子笔记本");
    }
    assertNotebook(ctx, body.parentId, true);
    await next();
    return;
  }

  if (["reorder", "trash"].includes(segments[2] || "")) {
    throw new ApiTokenAccessError("restricted Token 不允许批量笔记本管理操作");
  }
  const notebookId = decodeURIComponent(segments[2] || "");
  const suffix = segments.slice(3).join("/");
  if (/members|share-link|transfer/.test(suffix)) {
    throw new ApiTokenAccessError("restricted Token 不允许管理成员、分享链接或跨空间转移");
  }
  assertNotebook(ctx, notebookId, method !== "GET" && method !== "HEAD");
  if (method !== "GET" && method !== "HEAD") {
    const body = await c.req.raw.clone().json().catch(() => ({})) as { parentId?: string | null };
    if (body.parentId) assertNotebook(ctx, body.parentId, true);
  }
  await next();
}

async function handleNotes(c: Context, next: Next, ctx: TokenAccessContext): Promise<void> {
  const path = c.req.path;
  const method = c.req.method.toUpperCase();
  const segments = path.split("/").filter(Boolean);

  if (path === "/api/notes") {
    if (method === "GET") {
      const requested = c.req.query("notebookId");
      if (requested) assertNotebook(ctx, requested, false);
      await next();
      await replaceFilteredResponse(c, (body) => Array.isArray(body)
        ? body.filter((item) => canRead(ctx, item?.notebookId))
        : body);
      return;
    }
    const body = await c.req.raw.clone().json().catch(() => ({})) as { notebookId?: string };
    assertNotebook(ctx, body.notebookId, true);
    await next();
    return;
  }

  if (["reorder", "trash"].includes(segments[2] || "")) {
    throw new ApiTokenAccessError("restricted Token 不允许批量笔记管理操作");
  }
  const noteId = decodeURIComponent(segments[2] || "");
  const write = method !== "GET" && method !== "HEAD";
  assertNotebook(ctx, resolveNoteNotebookId(noteId), write);
  if (write && method !== "DELETE") {
    const body = await c.req.raw.clone().json().catch(() => ({})) as { notebookId?: string };
    if (body.notebookId) assertNotebook(ctx, body.notebookId, true);
  }
  await next();
}

async function handleSearch(c: Context, next: Next, ctx: TokenAccessContext): Promise<void> {
  await next();
  await replaceFilteredResponse(c, (body) => Array.isArray(body)
    ? body.filter((item) => canRead(ctx, item?.notebookId))
    : body);
}

async function handleBlocks(c: Context, next: Next, ctx: TokenAccessContext): Promise<void> {
  const path = c.req.path;
  const method = c.req.method.toUpperCase();
  const segments = path.split("/").filter(Boolean);
  if (["search", "resolve", "graph"].includes(segments[2] || "")) {
    await next();
    return;
  }
  const noteId = segments[2] === "note" ? decodeURIComponent(segments[3] || "") : decodeURIComponent(segments[2] || "");
  if (!noteId) throw new ApiTokenAccessError("块接口缺少 noteId");
  assertNotebook(ctx, resolveNoteNotebookId(noteId), !["GET", "HEAD"].includes(method));
  await next();
}

function fileBelongsToScope(ctx: TokenAccessContext, file: any): boolean {
  const ids = new Set<string>();
  if (file?.primaryNote?.notebookId) ids.add(file.primaryNote.notebookId);
  if (Array.isArray(file?.references)) {
    for (const ref of file.references) if (ref?.notebookId) ids.add(ref.notebookId);
  }
  return Array.from(ids).some((id) => canRead(ctx, id));
}

/** File-manager folders have no notebook binding: scoped PATs must not enumerate or mutate them. */
function requirePersonalFileManagerToken(ctx: TokenAccessContext, c: Context): void {
  if (ctx.resourceMode !== "unrestricted") {
    throw new ApiTokenAccessError("个人网盘操作需要未限定笔记本资源的 Token", "API_TOKEN_RESOURCE_DENIED");
  }
  if (c.req.query("workspaceId") && c.req.query("workspaceId") !== "personal") {
    throw new ApiTokenAccessError("MCP 网盘仅支持个人空间", "API_TOKEN_RESOURCE_DENIED");
  }
}

function assertPersonalManagedFile(ctx: TokenAccessContext, fileId: string): void {
  const file = getDb().prepare("SELECT userId,workspaceId,uploadSource FROM attachments WHERE id=?")
    .get(fileId) as { userId: string; workspaceId: string | null; uploadSource: string | null } | undefined;
  if (!file || file.userId !== ctx.userId || file.workspaceId !== null || file.uploadSource !== "file_manager") {
    throw new ApiTokenAccessError("MCP 只能管理本人个人网盘上传的文件", "API_TOKEN_RESOURCE_DENIED");
  }
}

async function handlePersonalFileManagement(c: Context, next: Next, ctx: TokenAccessContext): Promise<void> {
  requirePersonalFileManagerToken(ctx, c);
  const path = c.req.path;
  const method = c.req.method.toUpperCase();
  if (path === "/api/attachment-folders" || path === "/api/attachment-folders/") {
    if (!["GET", "POST"].includes(method)) throw new ApiTokenAccessError("文件夹接口不允许此操作", "API_TOKEN_ENDPOINT_DENIED");
    await next();
    return;
  }
  const folder = /^\/api\/attachment-folders\/([^/]+)$/.exec(path);
  if (folder) {
    if (method !== "PATCH") throw new ApiTokenAccessError("MCP 禁止删除文件夹", "API_TOKEN_ENDPOINT_DENIED");
    const body = await c.req.raw.clone().json().catch(() => ({})) as Record<string, unknown>;
    if (typeof body.expectedName !== "string" || !Object.hasOwn(body, "expectedParentId")) {
      throw new ApiTokenAccessError("请先预览文件夹并提交原名称和位置", "MCP_PREVIEW_REQUIRED", 409);
    }
    const row = getDb().prepare("SELECT name,parentId FROM attachment_folders WHERE id=? AND userId=?")
      .get(decodeURIComponent(folder[1]), ctx.userId) as { name: string; parentId: string | null } | undefined;
    if (!row || row.name !== body.expectedName || row.parentId !== body.expectedParentId) {
      throw new ApiTokenAccessError("文件夹名称或位置已改变，请重新预览", "MCP_FOLDER_CONFLICT", 409);
    }
    await next();
    return;
  }
  if (path === "/api/files/batch-move" && method === "POST") {
    const body = await c.req.raw.clone().json().catch(() => ({})) as Record<string, unknown>;
    if (!Array.isArray(body.ids) || body.ids.length < 1 || body.ids.length > 50
        || body.ids.some((id) => typeof id !== "string" || !id)) {
      throw new ApiTokenAccessError("单次仅允许整理 1 至 50 个文件", "API_TOKEN_ENDPOINT_DENIED");
    }
    if (!body.expectedFolderIds || typeof body.expectedFolderIds !== "object" || Array.isArray(body.expectedFolderIds)) {
      throw new ApiTokenAccessError("缺少预览时的文件位置快照", "MCP_PREVIEW_REQUIRED", 409);
    }
    for (const id of body.ids) assertPersonalManagedFile(ctx, id);
    await next();
    return;
  }
  if (path === "/api/files/trash" || path === "/api/files/trash/") {
    if (method !== "GET") throw new ApiTokenAccessError("回收站列表仅可读取", "API_TOKEN_ENDPOINT_DENIED");
    await next();
    if (c.res.status >= 200 && c.res.status < 300) {
      await replaceFilteredResponse(c, (data) => {
        if (!data || !Array.isArray(data.entries)) return data;
        const entries = data.entries.filter((item: any) => {
          try { assertPersonalManagedFile(ctx, item.id); return true; } catch { return false; }
        });
        return { ...data, entries, total: entries.length };
      });
    }
    return;
  }
  if (path === "/api/files/trash/restore" && method === "POST") {
    const body = await c.req.raw.clone().json().catch(() => ({})) as Record<string, unknown>;
    if (!Array.isArray(body.ids) || body.ids.length < 1 || body.ids.length > 50
        || !body.expectedTrashedAt || typeof body.expectedTrashedAt !== "object" || Array.isArray(body.expectedTrashedAt)) {
      throw new ApiTokenAccessError("恢复需要 1 至 50 个文件和回收站时间快照", "MCP_PREVIEW_REQUIRED", 409);
    }
    for (const id of body.ids) {
      if (typeof id !== "string") throw new ApiTokenAccessError("文件 ID 无效", "API_TOKEN_ENDPOINT_DENIED");
      assertPersonalManagedFile(ctx, id);
    }
    await next();
    return;
  }
  const file = /^\/api\/files\/([^/]+)$/.exec(path);
  if (file) {
    const id = decodeURIComponent(file[1]);
    if (method === "GET") { assertPersonalManagedFile(ctx, id); await next(); return; }
    if (!["PATCH", "DELETE"].includes(method)) throw new ApiTokenAccessError("不允许此文件操作", "API_TOKEN_ENDPOINT_DENIED");
    assertPersonalManagedFile(ctx, id);
    if (method === "DELETE") {
      throw new ApiTokenAccessError("P1 禁止通过 MCP 删除网盘文件；只允许管理回收站恢复", "API_TOKEN_ENDPOINT_DENIED");
    }
    const body = await c.req.raw.clone().json().catch(() => ({})) as Record<string, unknown>;
    if (typeof body.expectedFilename !== "string" || typeof body.filename !== "string") {
      throw new ApiTokenAccessError("重命名必须提交原文件名与新文件名", "MCP_PREVIEW_REQUIRED", 409);
    }
    await next();
    return;
  }
  throw new ApiTokenAccessError("MCP 禁止此网盘管理接口或永久清理", "API_TOKEN_ENDPOINT_DENIED");
}

async function handleFiles(c: Context, next: Next, ctx: TokenAccessContext): Promise<void> {
  const path = c.req.path;
  const method = c.req.method.toUpperCase();
  const segments = path.split("/").filter(Boolean);

  if (path === "/api/files/upload") {
    throw new ApiTokenAccessError("restricted Token 禁止上传未绑定笔记的附件");
  }
  if (path === "/api/files") {
    if (method !== "GET") throw new ApiTokenAccessError("restricted Token 不允许此文件管理操作");
    const requested = c.req.query("notebookId");
    if (requested) assertNotebook(ctx, requested, false);
    await next();
    await replaceFilteredResponse(c, (body) => {
      if (!body || !Array.isArray(body.items)) return body;
      const items = body.items.filter((item: any) => fileBelongsToScope(ctx, item));
      return { ...body, items, total: items.length };
    });
    return;
  }
  const attachmentId = decodeURIComponent(segments[2] || "");
  assertAttachment(ctx, attachmentId, method !== "GET" && method !== "HEAD");
  await next();
  if (method === "GET") {
    await replaceFilteredResponse(c, (body) => {
      if (!body || typeof body !== "object") return body;
      const references = Array.isArray(body.references)
        ? body.references.filter((item: any) => canRead(ctx, item?.notebookId))
        : body.references;
      const primaryNote = canRead(ctx, body.primaryNote?.notebookId) ? body.primaryNote : null;
      return { ...body, primaryNote, references };
    });
  }
}

async function handleAttachments(c: Context, next: Next, ctx: TokenAccessContext): Promise<void> {
  const path = c.req.path;
  const method = c.req.method.toUpperCase();
  const segments = path.split("/").filter(Boolean);
  if (path === "/api/attachments" && method === "POST") {
    const form = await c.req.raw.clone().formData().catch(() => null);
    const noteIdValue = form?.get("noteId");
    const noteId = typeof noteIdValue === "string" ? noteIdValue : "";
    assertNotebook(ctx, resolveNoteNotebookId(noteId), true);
    await next();
    return;
  }
  if (segments.length >= 3) {
    assertAttachment(ctx, decodeURIComponent(segments[2]), method !== "GET" && method !== "HEAD");
    await next();
    return;
  }
  throw new ApiTokenAccessError("restricted Token 不允许此附件操作");
}

async function handleTags(c: Context, next: Next, ctx: TokenAccessContext): Promise<void> {
  const path = c.req.path;
  const method = c.req.method.toUpperCase();
  const match = path.match(/^\/api\/tags\/note\/([^/]+)\/tag\/([^/]+)$/);
  if (match) {
    assertNotebook(ctx, resolveNoteNotebookId(decodeURIComponent(match[1])), true);
    await next();
    return;
  }
  if (path === "/api/tags" && method === "GET") {
    const allowedTagIds = new Set<string>();
    if (ctx.notebooks.size > 0) {
      const ids = Array.from(ctx.notebooks.keys());
      const placeholders = ids.map(() => "?").join(",");
      const rows = getDb().prepare(`
        SELECT DISTINCT nt.tagId
        FROM note_tags nt
        JOIN notes n ON n.id = nt.noteId
        WHERE n.notebookId IN (${placeholders})
      `).all(...ids) as Array<{ tagId: string }>;
      for (const row of rows) allowedTagIds.add(row.tagId);
    }
    await next();
    await replaceFilteredResponse(c, (body) => Array.isArray(body)
      ? body.filter((item) => allowedTagIds.has(item?.id))
      : body);
    return;
  }
  if (path === "/api/tags" && method === "POST") {
    throw new ApiTokenAccessError("restricted Token 不允许创建全局标签；仅可增删作用域内笔记的标签关联");
  }
  throw new ApiTokenAccessError("restricted Token 不允许修改全局标签；仅可增删作用域内笔记的标签关联");
}

async function handleAi(c: Context, next: Next, ctx: TokenAccessContext): Promise<void> {
  if (c.req.path === "/api/ai/chat") {
    await next();
    return;
  }
  const body = await c.req.raw.clone().json().catch(() => ({})) as {
    notebookId?: string;
    includeChildren?: boolean;
  };
  if (!body.notebookId) {
    throw new ApiTokenAccessError("restricted Token 调用知识库问答时必须指定 notebookId");
  }
  assertNotebook(ctx, body.notebookId, false);
  if (body.includeChildren) {
    const descendants = getDb().prepare(`
      WITH RECURSIVE tree(id) AS (
        SELECT id FROM notebooks WHERE id = ?
        UNION ALL
        SELECT n.id FROM notebooks n JOIN tree t ON n.parentId = t.id WHERE n.isDeleted = 0
      )
      SELECT id FROM tree
    `).all(body.notebookId) as Array<{ id: string }>;
    if (!descendants.every((row) => canRead(ctx, row.id))) {
      throw new ApiTokenAccessError("知识库问答请求包含未授权的子笔记本");
    }
  }
  await next();
}

/** PAT 的项目管理仅限个人空间，绝不暴露团队项目。 */
/**
 * MCP knowledge-tree writes are restricted to personal notebook/note nodes.
 * Never let a notebook-scoped Token mutate an ungranted child subtree or cross into
 * the workspace/root through a forged nodeId or parentId.
 */
function treeNodeRow(id: string): {
  id: string; userId: string; workspaceId: string | null;
  parentId: string | null; resourceType: string; resourceId: string; isDeleted: number;
} | undefined {
  return getDb().prepare(
    "SELECT id, userId, workspaceId, parentId, resourceType, resourceId, isDeleted FROM knowledge_tree_nodes WHERE id = ?"
  ).get(id) as any;
}

function treeDescendants(id: string): string[] {
  const rows = getDb().prepare(`
    WITH RECURSIVE descendants(id) AS (
      SELECT id FROM knowledge_tree_nodes WHERE id = ?
      UNION
      SELECT child.id FROM knowledge_tree_nodes child
      JOIN descendants parent ON child.parentId = parent.id
    )
    SELECT id FROM descendants LIMIT 10001
  `).all(id) as Array<{ id: string }>;
  if (rows.length > 10000) {
    throw new ApiTokenAccessError("单次 MCP 目录操作节点过多，请在客户端拆分", "API_TOKEN_ENDPOINT_DENIED");
  }
  return rows.map((row) => row.id);
}

function assertTreeNodeForToken(ctx: TokenAccessContext, nodeId: string, write = false, recoveryGrants?: Map<string, number>): void {
  const node = treeNodeRow(nodeId);
  if (!node || node.workspaceId !== null || node.userId !== ctx.userId) {
    throw new ApiTokenAccessError("目录节点不属于当前用户个人空间", "API_TOKEN_RESOURCE_DENIED");
  }
  if (node.resourceType !== "note" && node.resourceType !== "notebook") {
    throw new ApiTokenAccessError("MCP 目前只允许修改笔记和文件夹", "API_TOKEN_ENDPOINT_DENIED");
  }
  if (node.resourceType === "note" && write) requireScope(ctx, "notes:write");

  let current = node;
  const seen = new Set<string>();
  let notebookId: string | undefined;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.resourceType === "notebook") {
      notebookId = current.resourceId;
      break;
    }
    if (!current.parentId) break;
    const parent = treeNodeRow(current.parentId);
    if (!parent || parent.workspaceId !== null || parent.userId !== ctx.userId) {
      throw new ApiTokenAccessError("目录父节点不属于个人空间", "API_TOKEN_RESOURCE_DENIED");
    }
    current = parent;
  }
  if (!notebookId && ctx.resourceMode === "restricted") {
    throw new ApiTokenAccessError("restricted Token 不允许操作无笔记本归属的根节点", "API_TOKEN_RESOURCE_DENIED");
  }
  if (notebookId) {
    if (recoveryGrants && ctx.resourceMode === "restricted") {
      if ((recoveryGrants.get(notebookId) || 0) < (write ? 2 : 1)) {
        throw new ApiTokenAccessError("回收站目录超出 Token 原始笔记本授权", "API_TOKEN_RESOURCE_DENIED");
      }
    } else assertNotebook(ctx, notebookId, write);
  }
}

function assertTreeSubtreeForToken(ctx: TokenAccessContext, nodeId: string, recoveryGrants?: Map<string, number>): void {
  for (const id of treeDescendants(nodeId)) assertTreeNodeForToken(ctx, id, true, recoveryGrants);
}

function calculateTreeRevision(
  nodes: Array<{ id: string; parentId: string | null; resourceType: string; resourceId: string;
    title: string; updatedAt: string; isDeleted: number; childCount: number }>,
  nodeId: string,
  subtree = false,
): string {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visited = new Set<string>([nodeId]);
  if (subtree) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of nodes) {
        if (node.parentId && visited.has(node.parentId) && !visited.has(node.id)) {
          visited.add(node.id);
          changed = true;
        }
      }
    }
  }
  return createHash("sha256").update(JSON.stringify(Array.from(visited).sort().map((id) => {
    const node = byId.get(id)!;
    return [node.id, node.parentId, node.resourceType, node.resourceId,
      node.title, node.updatedAt, node.isDeleted, node.childCount];
  }))).digest("hex");
}

function assertTreeMutationPrecondition(
  ctx: TokenAccessContext,
  nodeId: string,
  body: Record<string, unknown>,
  subtree = false,
): void {
  const required = ["expectedUpdatedAt", "expectedTitle", "expectedParentId", "expectedChildCount"];
  if (required.some((key) => !(key in body)) || (subtree && !body.expectedSubtreeRevision)) {
    throw new ApiTokenAccessError("请先预览目录状态并提交完整预期版本", "MCP_PREVIEW_REQUIRED", 409);
  }
  const nodes = listKnowledgeTree({ userId: ctx.userId, workspaceId: null, includeDeleted: true });
  const node = nodes.find((item) => item.id === nodeId);
  if (!node || node.updatedAt !== body.expectedUpdatedAt || node.title !== body.expectedTitle
      || node.parentId !== body.expectedParentId || node.childCount !== body.expectedChildCount
      || (subtree && calculateTreeRevision(nodes, nodeId, true) !== body.expectedSubtreeRevision)) {
    throw new ApiTokenAccessError("目录或子树状态已变化，请重新预览后操作", "MCP_TREE_VERSION_CONFLICT", 409);
  }
}

async function handleTokenKnowledgeTree(c: Context, next: Next, ctx: TokenAccessContext): Promise<void> {
  const path = c.req.path.replace(/\/$/, "") || "/api/knowledge-tree";
  const method = c.req.method.toUpperCase();
  const workspaceId = c.req.query("workspaceId");
  if (workspaceId && workspaceId !== "personal") {
    if (method !== "GET") throw new ApiTokenAccessError("Token 不允许修改团队知识树", "API_TOKEN_RESOURCE_DENIED");
  }

  if (path === "/api/knowledge-tree" && method === "GET") {
    await next();
    if (ctx.resourceMode !== "restricted" || c.res.status < 200 || c.res.status >= 300) return;
    await replaceFilteredResponse(c, (body) => {
      if (!body || !Array.isArray(body.nodes)) return body;
      const byId = new Map<string, any>(body.nodes.map((item: any) => [item.id, item]));
      // Tombstones are visible only for explicit recycle-bin queries and only
      // within original descendant grants; normal token read grants are unchanged.
      const availableGrants = c.req.query("includeDeleted") === "1"
        ? loadNotebookGrants(ctx.tokenId, true) : ctx.notebooks;
      const allowed = (node: any): boolean => {
        let current = node;
        const seen = new Set<string>();
        while (current && !seen.has(current.id)) {
          seen.add(current.id);
          if (current.resourceType === "notebook") return ctx.resourceMode !== "restricted"
            || (availableGrants.get(current.resourceId) || 0) >= 1;
          current = current.parentId ? byId.get(current.parentId) : undefined;
        }
        return false;
      };
      const selected = body.nodes.filter(allowed);
      const selectedIds = new Set(selected.map((node: any) => node.id));
      const notes = new Set(selected.filter((node: any) => node.resourceType === "note").map((node: any) => node.resourceId));
      const counts = new Map<string, number>();
      for (const node of selected) if (node.parentId && selectedIds.has(node.parentId)) {
        counts.set(node.parentId, (counts.get(node.parentId) || 0) + 1);
      }
      return {
        ...body,
        nodes: selected.map((node: any) => ({
          ...node,
          parentId: node.parentId && selectedIds.has(node.parentId) ? node.parentId : null,
          childCount: counts.get(node.id) || 0,
        })),
        passwordAuthorizedNotes: Array.isArray(body.passwordAuthorizedNotes)
          ? body.passwordAuthorizedNotes.filter((entry: any) => notes.has(entry.noteId))
          : [],
      };
    });
    return;
  }

  if (workspaceId && workspaceId !== "personal") {
    throw new ApiTokenAccessError("Token 不允许修改团队知识树", "API_TOKEN_RESOURCE_DENIED");
  }

  if (path === "/api/knowledge-tree/nodes" && method === "POST") {
    const body = await c.req.raw.clone().json().catch(() => ({})) as Record<string, unknown>;
    if (body.nodeType !== "folder" && body.nodeType !== "markdown") {
      throw new ApiTokenAccessError("MCP 只能创建普通文件夹或 Markdown 笔记", "API_TOKEN_ENDPOINT_DENIED");
    }
    if (!body.parentId) {
      if (ctx.resourceMode === "restricted") {
        throw new ApiTokenAccessError("restricted Token 只能在已授权文件夹内创建", "API_TOKEN_RESOURCE_DENIED");
      }
    } else {
      if (typeof body.parentId !== "string") throw new ApiTokenAccessError("parentId 非法");
      const parent = treeNodeRow(body.parentId);
      if (!parent || parent.resourceType !== "notebook" || parent.isDeleted) {
        throw new ApiTokenAccessError("目标文件夹不存在", "API_TOKEN_RESOURCE_DENIED");
      }
      assertTreeNodeForToken(ctx, body.parentId, true);
    }
    if (body.nodeType === "markdown") requireScope(ctx, "notes:write");
    if (typeof body.parentId === "string") {
      assertTreeMutationPrecondition(ctx, body.parentId, body);
    } else if ("expectedUpdatedAt" in body) {
      throw new ApiTokenAccessError("根目录创建不能伪造父节点预期版本", "MCP_PREVIEW_REQUIRED", 409);
    }
    await next();
    return;
  }

  const match = /^\/api\/knowledge-tree\/nodes\/([^/]+)(?:\/(move|restore))?$/.exec(path);
  const operation = match?.[2] || "";
  if (!match || !(
    (method === "PATCH" && !operation)
    || (method === "PUT" && operation === "move")
    || (method === "DELETE" && !operation)
    || (method === "POST" && operation === "restore")
  )) {
    throw new ApiTokenAccessError("MCP 不允许此知识树批量、权限或高风险接口", "API_TOKEN_ENDPOINT_DENIED");
  }
  const nodeId = decodeURIComponent(match[1]);
  const body = await c.req.raw.clone().json().catch(() => ({})) as Record<string, unknown>;
  if (method === "PATCH" && (typeof body.title !== "string" || !body.title.trim() || body.isExpanded !== undefined)) {
    throw new ApiTokenAccessError("MCP 仅允许修改非空目录标题", "API_TOKEN_ENDPOINT_DENIED");
  }
  if (method === "DELETE" && c.req.query("mode") === "promote") {
    throw new ApiTokenAccessError("MCP 禁止提升子节点的删除模式", "API_TOKEN_ENDPOINT_DENIED");
  }
  const recoveryGrants = operation === "restore" && ctx.resourceMode === "restricted"
    ? loadNotebookGrants(ctx.tokenId, true) : undefined;
  assertTreeNodeForToken(ctx, nodeId, true, recoveryGrants);
  assertTreeMutationPrecondition(ctx, nodeId, body, method === "PUT" || method === "DELETE" || method === "POST");
  if (method === "PUT") {
    if (!("parentId" in body) || (body.parentId !== null && typeof body.parentId !== "string")) {
      throw new ApiTokenAccessError("必须明确目标 parentId", "API_TOKEN_ENDPOINT_DENIED");
    }
    if (body.parentId === null && ctx.resourceMode === "restricted") {
      throw new ApiTokenAccessError("restricted Token 禁止移动节点到根目录", "API_TOKEN_RESOURCE_DENIED");
    }
    if (typeof body.parentId === "string") {
      const parent = treeNodeRow(body.parentId);
      if (!parent || parent.isDeleted || parent.resourceType !== "notebook") {
        throw new ApiTokenAccessError("目标文件夹不可用", "API_TOKEN_RESOURCE_DENIED");
      }
      assertTreeNodeForToken(ctx, body.parentId, true);
    }
  }
  if (method === "PUT" || method === "DELETE" || method === "POST") {
    assertTreeSubtreeForToken(ctx, nodeId, recoveryGrants);
  }
  await next();
}

/**
 * PAT access is always limited to the token owner's personal automation resources.
 * Prohibit system events, plugin callbacks, administrative runtime and other users'
 * workflows even for an unrestricted token.
 */
async function handleTokenAutomations(c: Context, next: Next, ctx: TokenAccessContext): Promise<void> {
  const path = c.req.path.replace(/\/$/, "");
  const method = c.req.method.toUpperCase();
  if (path === "/api/automations") {
    if (method === "GET") {
      await next();
      if (c.res.status >= 200 && c.res.status < 300) {
        await replaceFilteredResponse(c, (items) =>
          Array.isArray(items) ? items.filter((item: any) =>
            item.userId === ctx.userId && item.workspaceId == null) : []);
      }
      return;
    }
    if (method === "POST") {
      const body = await c.req.raw.clone().json().catch(() => ({})) as Record<string, unknown>;
      if (body.workspaceId != null) {
        throw new ApiTokenAccessError("MCP 工作流仅允许个人空间", "API_TOKEN_RESOURCE_DENIED");
      }
      if (body.definition == null || typeof body.name !== "string") {
        throw new ApiTokenAccessError("工作流定义或名称无效", "API_TOKEN_ENDPOINT_DENIED");
      }
      await next();
      return;
    }
  }
  const match = /^\/api\/automations\/([^/]+)(?:\/(enable|disable|runs))?$/.exec(path);
  if (!match || !(
    (method === "GET" && (!match[2] || match[2] === "runs"))
    || (method === "PUT" && !match[2])
    || (method === "DELETE" && !match[2])
    || (method === "POST" && (match[2] === "enable" || match[2] === "disable"))
  )) {
    throw new ApiTokenAccessError("Token 不允许管理系统事件、运行历史重放或直接执行工作流", "API_TOKEN_ENDPOINT_DENIED");
  }
  const workflowId = decodeURIComponent(match[1]);
  const workflow = getDb().prepare(
    "SELECT id,userId,workspaceId FROM automation_workflows WHERE id=?"
  ).get(workflowId) as { id: string; userId: string; workspaceId: string | null } | undefined;
  if (!workflow || workflow.userId !== ctx.userId || workflow.workspaceId != null) {
    throw new ApiTokenAccessError("工作流不属于当前用户个人空间", "API_TOKEN_RESOURCE_DENIED");
  }
  if (method !== "GET") {
    const body = await c.req.raw.clone().json().catch(() => ({})) as Record<string, unknown>;
    if (typeof body.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(body.expectedRevision)) {
      throw new ApiTokenAccessError("请先预览工作流并提交版本指纹", "MCP_PREVIEW_REQUIRED", 409);
    }
    if (method === "PUT" && body.workspaceId != null) {
      throw new ApiTokenAccessError("MCP 工作流不可移动到团队空间", "API_TOKEN_RESOURCE_DENIED");
    }
    if (method === "DELETE" && body.confirmation !== "DELETE_WORKFLOW") {
      throw new ApiTokenAccessError("删除需要明确确认 DELETE_WORKFLOW", "MCP_CONFIRMATION_REQUIRED", 409);
    }
  }
  await next();
}

async function handleTokenTaskProjects(c: Context, next: Next, ctx: TokenAccessContext): Promise<void> {
  const path = c.req.path;
  const method = c.req.method.toUpperCase();
  const workspaceId = c.req.query("workspaceId");
  if (workspaceId && workspaceId !== "personal") {
    throw new ApiTokenAccessError("项目 Token 暂只支持个人空间", "API_TOKEN_RESOURCE_DENIED");
  }
  if (path === "/api/task-projects") {
    if (method !== "GET" && method !== "POST") {
      throw new ApiTokenAccessError("项目接口不允许该操作", "API_TOKEN_ENDPOINT_DENIED");
    }
    if (method === "POST") {
      const body = await c.req.raw.clone().json().catch(() => ({})) as Record<string, unknown>;
      if (body.workspaceId || body.userId) {
        throw new ApiTokenAccessError("不得通过 Token 创建跨空间项目", "API_TOKEN_RESOURCE_DENIED");
      }
    }
    await next();
    return;
  }
  const match = /^\/api\/task-projects\/([^/]+)$/.exec(path);
  if (!match || method !== "PUT") {
    throw new ApiTokenAccessError("项目 Token 不允许删除或批量操作", "API_TOKEN_ENDPOINT_DENIED");
  }
  const project = getDb().prepare("SELECT userId, workspaceId FROM task_projects WHERE id = ?")
    .get(decodeURIComponent(match[1])) as { userId: string; workspaceId: string | null } | undefined;
  if (!project || project.userId !== ctx.userId || project.workspaceId !== null) {
    throw new ApiTokenAccessError("项目不属于当前用户的个人空间", "API_TOKEN_RESOURCE_DENIED");
  }
  const body = await c.req.raw.clone().json().catch(() => ({})) as Record<string, unknown>;
  if (body.workspaceId || body.userId) {
    throw new ApiTokenAccessError("不得通过 Token 修改项目归属", "API_TOKEN_RESOURCE_DENIED");
  }
  await next();
}

async function assertTokenPersonalTaskLinks(ctx: TokenAccessContext, body: Record<string, unknown>): Promise<void> {
  if (body.workspaceId || body.noteId) {
    throw new ApiTokenAccessError("任务 Token 不允许关联工作区或笔记", "API_TOKEN_RESOURCE_DENIED");
  }
  if (body.parentId) {
    if (typeof body.parentId !== "string") throw new ApiTokenAccessError("父任务 ID 非法");
    const parent = getDb().prepare("SELECT userId, workspaceId FROM tasks WHERE id = ?")
      .get(body.parentId) as { userId: string; workspaceId: string | null } | undefined;
    if (!parent || parent.userId !== ctx.userId || parent.workspaceId !== null) {
      throw new ApiTokenAccessError("父任务不属于当前个人空间", "API_TOKEN_RESOURCE_DENIED");
    }
  }
  if (body.projectId) {
    if (typeof body.projectId !== "string") throw new ApiTokenAccessError("项目 ID 非法");
    const project = getDb().prepare("SELECT userId, workspaceId FROM task_projects WHERE id = ?")
      .get(body.projectId) as { userId: string; workspaceId: string | null } | undefined;
    if (!project || project.userId !== ctx.userId || project.workspaceId !== null) {
      throw new ApiTokenAccessError("项目不属于当前个人空间", "API_TOKEN_RESOURCE_DENIED");
    }
  }
}

async function handleTokenTaskReminders(c: Context, next: Next, ctx: TokenAccessContext): Promise<void> {
  const match = /^\/api\/task-reminders\/([^/]+)$/.exec(c.req.path);
  const method = c.req.method.toUpperCase();
  // Keep global schedules, delivery ACK and test-now outside PAT access.
  if (!match || !["GET", "POST"].includes(method)
    || ["overview", "schedule", "recent", "test-now"].includes(match[1])) {
    throw new ApiTokenAccessError("API Token 仅支持读取或创建个人任务提醒");
  }
  const task = getDb().prepare("SELECT userId, workspaceId FROM tasks WHERE id = ?")
    .get(decodeURIComponent(match[1])) as { userId: string; workspaceId: string | null } | undefined;
  if (!task || task.userId !== ctx.userId || task.workspaceId !== null) {
    throw new ApiTokenAccessError("只能访问本人个人任务的提醒");
  }
  await next();
}

/** PAT 的任务访问与笔记本白名单分离：默认仅本人个人任务。
 * 即使令牌是 unrestricted，也不得通过切换 workspaceId 访问共享工作区。
 */
async function handleTokenTasks(c: Context, next: Next, ctx: TokenAccessContext): Promise<void> {
  const path = c.req.path;
  const method = c.req.method.toUpperCase();
  const scope = c.req.query("workspaceId");
  if (scope && scope !== "personal") {
    throw new ApiTokenAccessError("任务 Token 暂只支持个人任务", "API_TOKEN_RESOURCE_DENIED");
  }
  if (path === "/api/tasks") {
    if (method !== "GET" && method !== "POST") {
      throw new ApiTokenAccessError("任务接口不允许该操作", "API_TOKEN_ENDPOINT_DENIED");
    }
    if (method === "POST") {
      const body = await c.req.raw.clone().json().catch(() => ({})) as Record<string, unknown>;
      await assertTokenPersonalTaskLinks(ctx, body);
    }
    await next();
    return;
  }
  if (path === "/api/tasks/stats/summary" && method === "GET") {
    await next();
    return;
  }
  const saveNoteMatch = /^\/api\/tasks\/([^/]+)\/note$/.exec(path);
  if (saveNoteMatch && method === "POST") {
    requireScope(ctx, "notes:write");
    const task = getDb().prepare("SELECT userId,workspaceId,updatedAt FROM tasks WHERE id=?")
      .get(decodeURIComponent(saveNoteMatch[1])) as
      { userId: string; workspaceId: string | null; updatedAt: string } | undefined;
    if (!task || task.userId !== ctx.userId || task.workspaceId !== null) {
      throw new ApiTokenAccessError("只能保存本人个人任务", "API_TOKEN_RESOURCE_DENIED");
    }
    const body = await c.req.raw.clone().json().catch(() => ({})) as Record<string, unknown>;
    if (typeof body.notebookId !== "string") {
      throw new ApiTokenAccessError("必须选择目标笔记本", "MCP_PREVIEW_REQUIRED", 409);
    }
    assertNotebook(ctx, body.notebookId, true);
    const source = getDb().prepare("SELECT title,description FROM tasks WHERE id=?")
      .get(decodeURIComponent(saveNoteMatch[1])) as { title: string; description: string | null };
    if (!body.expectedTaskUpdatedAt || body.expectedTaskUpdatedAt !== task.updatedAt
      || body.expectedTaskTitle !== source.title
      || body.expectedTaskDescription !== (source.description || "")) {
      throw new ApiTokenAccessError("任务内容已变化，请重新预览详情", "MCP_TASK_VERSION_CONFLICT", 409);
    }
    await next();
    return;
  }
  const archiveMatch = /^\/api\/tasks\/([^/]+)\/archive$/.exec(path);
  if (archiveMatch && method === "PATCH") {
    const task = getDb().prepare("SELECT userId, workspaceId, parentId FROM tasks WHERE id = ?")
      .get(decodeURIComponent(archiveMatch[1])) as
      { userId: string; workspaceId: string | null; parentId: string | null } | undefined;
    if (!task || task.userId !== ctx.userId || task.workspaceId !== null || task.parentId) {
      throw new ApiTokenAccessError("只能归档本人个人空间的顶层任务", "API_TOKEN_RESOURCE_DENIED");
    }
    await next();
    return;
  }
  const match = /^\/api\/tasks\/([^/]+)$/.exec(path);
  if (!match || !["GET", "PUT"].includes(method)) {
    throw new ApiTokenAccessError("任务 Token 不允许批量、删除或其他高风险操作", "API_TOKEN_ENDPOINT_DENIED");
  }
  const task = getDb().prepare("SELECT userId,workspaceId FROM tasks WHERE id=?")
    .get(decodeURIComponent(match[1])) as { userId: string; workspaceId: string | null } | undefined;
  if (!task || task.userId !== ctx.userId || task.workspaceId !== null) {
    throw new ApiTokenAccessError("任务不属于当前用户的个人空间", "API_TOKEN_RESOURCE_DENIED");
  }
  if (method === "PUT") {
    const body = await c.req.raw.clone().json().catch(() => ({})) as Record<string, unknown>;
    await assertTokenPersonalTaskLinks(ctx, body);
  }
  await next();
  if (method === "GET" && c.res.status >= 200 && c.res.status < 300) {
    await replaceFilteredResponse(c, (body) => {
      if (!body || !Array.isArray(body.children)) return body;
      return { ...body, children: body.children.filter((child: any) =>
        child.userId === ctx.userId && child.workspaceId == null) };
    });
  }
}

export async function enforceApiTokenAccess(c: Context, next: Next): Promise<Response | void> {
  let ctx: TokenAccessContext | null = null;
  try {
    ctx = getContext(c);
    if (!ctx) {
      await next();
      return;
    }

    const required = requiredScope(c.req.path, c.req.method.toUpperCase());
    if (required === "__login_only__") {
      throw new ApiTokenAccessError("此操作需要用户登录，API Token 无权访问", "API_TOKEN_SELF_MANAGEMENT_DENIED");
    }
    if (required === "__unsupported__") {
      if (ctx.resourceMode === "restricted") {
        throw new ApiTokenAccessError(`restricted Token 未授权访问端点: ${c.req.path}`, "API_TOKEN_ENDPOINT_DENIED");
      }
      await next();
      return;
    }
    if (required) requireScope(ctx, required);
    // 对 unrestricted 和 restricted PAT 同样应用个人任务资源边界。
    if (c.req.path === "/api/automations" || c.req.path.startsWith("/api/automations/")) {
      await handleTokenAutomations(c, next, ctx);
      return;
    }
    if (c.req.path === "/api/tasks" || c.req.path.startsWith("/api/tasks/")) {
      await handleTokenTasks(c, next, ctx);
      return;
    }
    if (c.req.path === "/api/task-reminders" || c.req.path.startsWith("/api/task-reminders/")) {
      await handleTokenTaskReminders(c, next, ctx);
      return;
    }
    if (c.req.path === "/api/task-projects" || c.req.path.startsWith("/api/task-projects/")) {
      await handleTokenTaskProjects(c, next, ctx);
      return;
    }
    if (c.req.path === "/api/knowledge-tree" || c.req.path.startsWith("/api/knowledge-tree/")) {
      await handleTokenKnowledgeTree(c, next, ctx);
      return;
    }
    if (c.req.path.startsWith("/api/attachment-folders")
      || c.req.path.startsWith("/api/files/trash")
      || c.req.path === "/api/files/batch-move"
      || (c.req.path.startsWith("/api/files/") && ["PATCH", "DELETE"].includes(c.req.method.toUpperCase()))) {
      await handlePersonalFileManagement(c, next, ctx);
      return;
    }

    if (ctx.resourceMode !== "restricted") {
      await next();
      return;
    }

    c.req.raw.headers.set("X-Api-Allowed-Notebook-Ids", Array.from(ctx.notebooks.keys()).join(","));
    if (c.req.path.startsWith("/api/note-templates")) {
      throw new ApiTokenAccessError("restricted Token 不允许访问工作区级笔记模板");
    }
    if (c.req.path.startsWith("/api/notebooks")) await handleNotebooks(c, next, ctx);
    else if (c.req.path.startsWith("/api/notes")) await handleNotes(c, next, ctx);
    else if (c.req.path.startsWith("/api/search")) await handleSearch(c, next, ctx);
    else if (c.req.path.startsWith("/api/blocks")) await handleBlocks(c, next, ctx);
    else if (c.req.path.startsWith("/api/files")) await handleFiles(c, next, ctx);
    else if (c.req.path.startsWith("/api/attachments")) await handleAttachments(c, next, ctx);
    else if (c.req.path.startsWith("/api/tags")) await handleTags(c, next, ctx);
    else if (c.req.path === "/api/ai/ask" || c.req.path === "/api/ai/chat") await handleAi(c, next, ctx);
    else await next();

    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method.toUpperCase())) {
      logAudit(ctx.userId, "system", "api_token_request", {
        tokenId: ctx.tokenId,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
      }, { targetType: "api_token", targetId: ctx.tokenId });
    }
  } catch (error) {
    if (error instanceof ApiTokenAccessError) {
      return c.json({ error: error.message, code: error.code }, error.status as 401 | 403);
    }
    throw error;
  }
}
