import type { Context, Next } from "hono";
import { getDb } from "../db/schema";
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

function loadNotebookGrants(tokenId: string): Map<string, number> {
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
      WHERE scoped.recurse = 1 AND n.isDeleted = 0
    )
    SELECT id AS notebookId, MAX(level) AS level
    FROM scoped
    GROUP BY id
  `).all(tokenId) as NotebookGrant[];

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

function requiredScope(pathname: string, method: string): string | null {
  const write = !["GET", "HEAD", "OPTIONS"].includes(method);
  if (pathname === "/api/me") return null;
  if (pathname.startsWith("/api/tokens")) return "__login_only__";
  if (pathname.startsWith("/api/notebooks")) return write ? "notebooks:write" : "notebooks:read";
  if (pathname.startsWith("/api/notes")) return write ? "notes:write" : "notes:read";
  if (pathname.startsWith("/api/search")) return "notes:read";
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

function fileBelongsToScope(ctx: TokenAccessContext, file: any): boolean {
  const ids = new Set<string>();
  if (file?.primaryNote?.notebookId) ids.add(file.primaryNote.notebookId);
  if (Array.isArray(file?.references)) {
    for (const ref of file.references) if (ref?.notebookId) ids.add(ref.notebookId);
  }
  return Array.from(ids).some((id) => canRead(ctx, id));
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
    await next();
    return;
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
      throw new ApiTokenAccessError("API Token 不能管理或创建其他 Token", "API_TOKEN_SELF_MANAGEMENT_DENIED");
    }
    if (required === "__unsupported__") {
      throw new ApiTokenAccessError(`API Token 未授权访问端点: ${c.req.path}`, "API_TOKEN_ENDPOINT_DENIED");
    }
    if (required) requireScope(ctx, required);

    if (ctx.resourceMode !== "restricted") {
      await next();
      return;
    }

    c.req.raw.headers.set("X-Api-Allowed-Notebook-Ids", Array.from(ctx.notebooks.keys()).join(","));
    if (c.req.path.startsWith("/api/notebooks")) await handleNotebooks(c, next, ctx);
    else if (c.req.path.startsWith("/api/notes")) await handleNotes(c, next, ctx);
    else if (c.req.path.startsWith("/api/search")) await handleSearch(c, next, ctx);
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
