/**
 * Personal API Token 管理路由（/api/tokens）
 * ---------------------------------------------------------------------------
 * 支持 scopes、过期/吊销、使用统计，以及笔记本资源级授权。
 */
import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/schema";
import {
  API_TOKEN_SCOPES,
  generateApiTokenRaw,
  hashApiToken,
  initApiTokensTable,
  isValidScope,
  API_TOKEN_PREFIX,
  pruneTokenUsage,
  type ApiTokenResourceMode,
} from "../lib/api-tokens";
import { apiTokensRepository } from "../repositories";
import { hasPermission, resolveNotebookPermission } from "../middleware/acl";
import { logAudit } from "../services/audit";

const app = new Hono();
initApiTokensTable(getDb());
pruneTokenUsage(getDb());

type ResourcePermission = "read" | "write";
interface NotebookResourceInput {
  notebookId: string;
  permission: ResourcePermission;
  includeDescendants: boolean;
}

function safeParseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isApiTokenAuth(c: any): boolean {
  const authz = c.req.header("Authorization") || "";
  return authz.startsWith("Bearer ") && authz.slice(7).startsWith(API_TOKEN_PREFIX);
}

function rejectApiTokenManagement(c: any) {
  if (!isApiTokenAuth(c)) return null;
  return c.json(
    { error: "不允许使用 API Token 管理其他 API Token，请使用登录凭证操作" },
    403,
  );
}

function normalizeResourceMode(value: unknown): ApiTokenResourceMode {
  return value === "restricted" ? "restricted" : "unrestricted";
}

function normalizeResources(value: unknown): NotebookResourceInput[] {
  if (!Array.isArray(value)) return [];
  const byNotebook = new Map<string, NotebookResourceInput>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const notebookId = String((raw as any).notebookId || "").trim();
    if (!notebookId) continue;
    const permission: ResourcePermission = (raw as any).permission === "write" ? "write" : "read";
    const includeDescendants = Boolean((raw as any).includeDescendants);
    const previous = byNotebook.get(notebookId);
    byNotebook.set(notebookId, {
      notebookId,
      permission: previous?.permission === "write" ? "write" : permission,
      includeDescendants: Boolean(previous?.includeDescendants || includeDescendants),
    });
  }
  return Array.from(byNotebook.values());
}

function validateResources(userId: string, resources: NotebookResourceInput[]): string | null {
  for (const resource of resources) {
    const { permission } = resolveNotebookPermission(resource.notebookId, userId);
    if (!hasPermission(permission, "read")) {
      return `无权授权笔记本: ${resource.notebookId}`;
    }
    if (resource.permission === "write" && !hasPermission(permission, "write")) {
      return `当前用户对笔记本 ${resource.notebookId} 没有写权限`;
    }
  }
  return null;
}

function listResources(tokenId: string) {
  return getDb().prepare(`
    SELECT
      r.resourceId AS notebookId,
      r.permission,
      r.includeDescendants,
      n.name AS notebookName,
      n.parentId
    FROM api_token_resources r
    LEFT JOIN notebooks n ON n.id = r.resourceId
    WHERE r.tokenId = ? AND r.resourceType = 'notebook'
    ORDER BY n.name COLLATE NOCASE ASC, r.resourceId ASC
  `).all(tokenId) as Array<{
    notebookId: string;
    permission: ResourcePermission;
    includeDescendants: number;
    notebookName: string | null;
    parentId: string | null;
  }>;
}

function replaceResources(tokenId: string, resources: NotebookResourceInput[]): void {
  const db = getDb();
  const replace = db.transaction(() => {
    db.prepare("DELETE FROM api_token_resources WHERE tokenId = ?").run(tokenId);
    const insert = db.prepare(`
      INSERT INTO api_token_resources
        (id, tokenId, resourceType, resourceId, permission, includeDescendants)
      VALUES (?, ?, 'notebook', ?, ?, ?)
    `);
    for (const resource of resources) {
      insert.run(
        uuid(),
        tokenId,
        resource.notebookId,
        resource.permission,
        resource.includeDescendants ? 1 : 0,
      );
    }
  });
  replace();
}

function serializeResources(tokenId: string) {
  return listResources(tokenId).map((resource) => ({
    ...resource,
    includeDescendants: resource.includeDescendants === 1,
  }));
}

/** 列出当前用户的 Token。 */
app.get("/", (c) => {
  const userId = c.req.header("X-User-Id")!;
  const rows = getDb().prepare(`
    SELECT id, name, scopes, resourceMode, expiresAt, lastUsedAt, lastUsedIp, createdAt, revokedAt
    FROM api_tokens
    WHERE userId = ?
    ORDER BY revokedAt IS NOT NULL, createdAt DESC
  `).all(userId) as Array<{
    id: string;
    name: string;
    scopes: string;
    resourceMode: string;
    expiresAt: string | null;
    lastUsedAt: string | null;
    lastUsedIp: string | null;
    createdAt: string;
    revokedAt: string | null;
  }>;

  return c.json({
    tokens: rows.map((row) => ({
      ...row,
      scopes: safeParseJsonArray(row.scopes),
      resourceMode: normalizeResourceMode(row.resourceMode),
      notebookResources: serializeResources(row.id),
    })),
    availableScopes: API_TOKEN_SCOPES,
    availableResourcePermissions: ["read", "write"],
  });
});

/** 创建 Token，明文仅返回一次。 */
app.post("/", async (c) => {
  const denied = rejectApiTokenManagement(c);
  if (denied) return denied;

  const userId = c.req.header("X-User-Id")!;
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    scopes?: string[];
    expiresAt?: string | null;
    expiresInDays?: number;
    resourceMode?: ApiTokenResourceMode;
    notebookResources?: NotebookResourceInput[];
  };

  const name = (body.name || "").trim();
  if (!name) return c.json({ error: "请提供 token 名称" }, 400);
  if (name.length > 64) return c.json({ error: "名称长度最多 64 字符" }, 400);

  const normalizedScopes: string[] = [];
  for (const scope of Array.isArray(body.scopes) ? body.scopes : []) {
    if (typeof scope !== "string") continue;
    if (!isValidScope(scope)) return c.json({ error: `未知 scope: ${scope}` }, 400);
    if (!normalizedScopes.includes(scope)) normalizedScopes.push(scope);
  }
  if (normalizedScopes.length === 0) return c.json({ error: "请至少选择一个 scope" }, 400);

  let expiresAt: string | null = null;
  if (typeof body.expiresInDays === "number" && body.expiresInDays > 0) {
    expiresAt = new Date(Date.now() + body.expiresInDays * 86400_000).toISOString();
  } else if (body.expiresAt) {
    const timestamp = Date.parse(body.expiresAt);
    if (Number.isNaN(timestamp)) return c.json({ error: "expiresAt 格式不合法" }, 400);
    if (timestamp < Date.now()) return c.json({ error: "expiresAt 不能早于当前时间" }, 400);
    expiresAt = new Date(timestamp).toISOString();
  }

  const resources = normalizeResources(body.notebookResources);
  const resourceMode = normalizeResourceMode(body.resourceMode ?? (resources.length > 0 ? "restricted" : "unrestricted"));
  const resourceError = validateResources(userId, resources);
  if (resourceError) return c.json({ error: resourceError }, 403);

  const raw = generateApiTokenRaw();
  const id = uuid();
  apiTokensRepository.create({
    id,
    userId,
    name,
    tokenHash: hashApiToken(raw),
    scopes: normalizedScopes,
    expiresAt,
  });
  getDb().prepare("UPDATE api_tokens SET resourceMode = ? WHERE id = ?").run(resourceMode, id);
  replaceResources(id, resources);

  logAudit(userId, "system", "api_token_created", {
    tokenId: id,
    name,
    scopes: normalizedScopes,
    expiresAt,
    resourceMode,
    notebookResources: resources,
  }, { targetType: "api_token", targetId: id });

  return c.json({
    id,
    name,
    scopes: normalizedScopes,
    resourceMode,
    notebookResources: serializeResources(id),
    expiresAt,
    createdAt: new Date().toISOString(),
    token: raw,
    warning: "该 token 只会显示这一次，请妥善保存。可在需要时随时吊销。",
  }, 201);
});

/** 当前用户可授权给 Token 的笔记本。 */
app.get("/notebook-options", (c) => {
  const denied = rejectApiTokenManagement(c);
  if (denied) return denied;
  const userId = c.req.header("X-User-Id")!;
  const rows = getDb().prepare(`
    SELECT id, name, parentId, workspaceId, userId
    FROM notebooks
    WHERE isDeleted = 0
    ORDER BY sortOrder ASC, name COLLATE NOCASE ASC
  `).all() as Array<{
    id: string;
    name: string;
    parentId: string | null;
    workspaceId: string | null;
    userId: string;
  }>;

  const notebooks = rows.flatMap((row) => {
    const { permission } = resolveNotebookPermission(row.id, userId);
    if (!hasPermission(permission, "read")) return [];
    return [{
      ...row,
      canWrite: hasPermission(permission, "write"),
    }];
  });
  return c.json({ notebooks });
});

/** 修改已有 Token 的资源模式与笔记本授权，不轮换明文。 */
app.patch("/:id/resources", async (c) => {
  const denied = rejectApiTokenManagement(c);
  if (denied) return denied;
  const userId = c.req.header("X-User-Id")!;
  const tokenId = c.req.param("id");
  const token = getDb().prepare("SELECT id, userId, revokedAt FROM api_tokens WHERE id = ? AND userId = ?")
    .get(tokenId, userId) as { id: string; userId: string; revokedAt: string | null } | undefined;
  if (!token) return c.json({ error: "token 不存在" }, 404);
  if (token.revokedAt) return c.json({ error: "已吊销 token 不能再修改授权" }, 409);

  const body = (await c.req.json().catch(() => ({}))) as {
    resourceMode?: ApiTokenResourceMode;
    notebookResources?: NotebookResourceInput[];
  };
  const resourceMode = normalizeResourceMode(body.resourceMode);
  const resources = normalizeResources(body.notebookResources);
  const resourceError = validateResources(userId, resources);
  if (resourceError) return c.json({ error: resourceError }, 403);

  const db = getDb();
  const update = db.transaction(() => {
    db.prepare("UPDATE api_tokens SET resourceMode = ? WHERE id = ? AND userId = ?")
      .run(resourceMode, tokenId, userId);
    replaceResources(tokenId, resources);
  });
  update();

  logAudit(userId, "system", "api_token_resources_updated", {
    tokenId,
    resourceMode,
    notebookResources: resources,
  }, { targetType: "api_token", targetId: tokenId });

  return c.json({
    success: true,
    resourceMode,
    notebookResources: serializeResources(tokenId),
  });
});

/** 使用统计。 */
app.get("/usage", (c) => {
  const userId = c.req.header("X-User-Id")!;
  const parsed = Number.parseInt(c.req.query("days") || "7", 10);
  const days = Number.isFinite(parsed) && parsed >= 1 && parsed <= 90 ? parsed : 7;
  const today = new Date();
  const todayDay = today.toISOString().slice(0, 10);
  const startDay = new Date(today.getTime() - (days - 1) * 86400_000).toISOString().slice(0, 10);
  const prevStartDay = new Date(today.getTime() - (days * 2 - 1) * 86400_000).toISOString().slice(0, 10);
  const prevEndDay = new Date(today.getTime() - days * 86400_000).toISOString().slice(0, 10);
  const dailyRows = apiTokensRepository.getDailyUsage(userId, startDay, todayDay);
  const dailyMap = new Map(dailyRows.map((row) => [row.day, row.count]));
  const series: Array<{ day: string; count: number }> = [];
  for (let index = days - 1; index >= 0; index -= 1) {
    const day = new Date(today.getTime() - index * 86400_000).toISOString().slice(0, 10);
    series.push({ day, count: dailyMap.get(day) || 0 });
  }
  return c.json({
    days,
    total: series.reduce((sum, item) => sum + item.count, 0),
    prevTotal: apiTokensRepository.getPrevPeriodTotal(userId, prevStartDay, prevEndDay) || 0,
    series,
    byToken: apiTokensRepository.getUsageByToken(userId, startDay, todayDay),
  });
});

/** 吊销 Token。 */
app.delete("/:id", (c) => {
  const denied = rejectApiTokenManagement(c);
  if (denied) return denied;
  const userId = c.req.header("X-User-Id")!;
  const id = c.req.param("id");
  const row = getDb().prepare("SELECT id, userId, revokedAt FROM api_tokens WHERE id = ? AND userId = ?")
    .get(id, userId) as { id: string; userId: string; revokedAt: string | null } | undefined;
  if (!row) return c.json({ error: "token 不存在" }, 404);
  if (row.revokedAt) return c.json({ success: true, alreadyRevoked: true });
  apiTokensRepository.revokeById(id);
  logAudit(userId, "system", "api_token_revoked", { tokenId: id }, {
    targetType: "api_token",
    targetId: id,
  });
  return c.json({ success: true });
});

/** 永久删除本人已吊销的 Token；外键级联清理授权和使用统计，审计日志独立保留。 */
app.delete("/:id/permanent", (c) => {
  const denied = rejectApiTokenManagement(c);
  if (denied) return denied;
  const userId = c.req.header("X-User-Id")!;
  const id = c.req.param("id");
  const db = getDb();
  const row = db.prepare("SELECT revokedAt FROM api_tokens WHERE id = ? AND userId = ?")
    .get(id, userId) as { revokedAt: string | null } | undefined;
  if (!row) return c.json({ error: "token 不存在" }, 404);
  if (!row.revokedAt) return c.json({ error: "请先吊销 token 再删除" }, 409);

  const result = db.prepare("DELETE FROM api_tokens WHERE id = ? AND userId = ? AND revokedAt IS NOT NULL")
    .run(id, userId);
  if (result.changes === 0) return c.json({ error: "token 不存在" }, 404);
  logAudit(userId, "system", "api_token_deleted", { tokenId: id }, {
    targetType: "api_token",
    targetId: id,
  });
  return c.json({ success: true });
});

export default app;
