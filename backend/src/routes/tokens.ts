/**
 * Personal API Token 管理路由（/api/tokens）
 * ---------------------------------------------------------------------------
 * 支持 scopes、过期/吊销、使用统计，以及笔记本资源级授权。
 *
 * 所有数据库操作均通过 Database Runtime Provider 执行，SQLite / PostgreSQL
 * 共享同一业务接口，不在路由模块导入阶段打开 SQLite。
 */
import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import {
  API_TOKEN_PREFIX,
  API_TOKEN_SCOPES,
  generateApiTokenRaw,
  hashApiToken,
  isValidScope,
} from "../lib/api-tokens";
import {
  apiTokenResourcesRepository,
  apiTokensRepository,
  type ApiTokenResourceMode,
  type ApiTokenResourcePermission,
} from "../repositories";
import { logAudit } from "../services/audit";

const app = new Hono();
let pruneUsagePromise: Promise<void> | undefined;

interface NotebookResourceRequest {
  notebookId: string;
  permission: ApiTokenResourcePermission;
  includeDescendants: boolean;
}

async function ensureTokenUsageMaintenance(): Promise<void> {
  if (!pruneUsagePromise) {
    const cutoffDay = new Date(Date.now() - 90 * 86400_000)
      .toISOString()
      .slice(0, 10);
    pruneUsagePromise = apiTokensRepository
      .pruneUsageBeforeAsync(cutoffDay)
      .catch((error) => {
        pruneUsagePromise = undefined;
        console.warn("[tokens] prune token usage failed:", error);
      });
  }
  await pruneUsagePromise;
}

app.use("*", async (_c, next) => {
  await ensureTokenUsageMaintenance();
  await next();
});

function safeParseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
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

function normalizeResources(value: unknown): NotebookResourceRequest[] {
  if (!Array.isArray(value)) return [];

  const byNotebook = new Map<string, NotebookResourceRequest>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const notebookId = String((raw as any).notebookId || "").trim();
    if (!notebookId) continue;

    const permission: ApiTokenResourcePermission =
      (raw as any).permission === "write" ? "write" : "read";
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

async function validateResources(
  userId: string,
  resources: NotebookResourceRequest[],
): Promise<string | null> {
  if (resources.length === 0) return null;

  const options = await apiTokenResourcesRepository.listAuthorizedNotebookOptionsAsync(userId);
  const accessByNotebook = new Map(options.map((option) => [option.id, option]));

  for (const resource of resources) {
    const option = accessByNotebook.get(resource.notebookId);
    if (!option) return `无权授权笔记本: ${resource.notebookId}`;
    if (resource.permission === "write" && !option.canWrite) {
      return `当前用户对笔记本 ${resource.notebookId} 没有写权限`;
    }
  }

  return null;
}

function withResourceIds(resources: NotebookResourceRequest[]) {
  return resources.map((resource) => ({
    id: uuid(),
    ...resource,
  }));
}

async function serializeResources(tokenId: string) {
  return apiTokenResourcesRepository.listResourcesByTokenAsync(tokenId);
}

/** 列出当前用户的 Token。 */
app.get("/", async (c) => {
  const userId = c.req.header("X-User-Id")!;
  const rows = await apiTokenResourcesRepository.listTokensByUserAsync(userId);

  const tokens = await Promise.all(rows.map(async (row) => ({
    ...row,
    scopes: safeParseJsonArray(row.scopes),
    resourceMode: normalizeResourceMode(row.resourceMode),
    notebookResources: await serializeResources(row.id),
  })));

  return c.json({
    tokens,
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
    notebookResources?: NotebookResourceRequest[];
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
  if (normalizedScopes.length === 0) {
    return c.json({ error: "请至少选择一个 scope" }, 400);
  }

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
  const resourceMode = normalizeResourceMode(
    body.resourceMode ?? (resources.length > 0 ? "restricted" : "unrestricted"),
  );
  const resourceError = await validateResources(userId, resources);
  if (resourceError) return c.json({ error: resourceError }, 403);

  const raw = generateApiTokenRaw();
  const id = uuid();

  await apiTokenResourcesRepository.createTokenAsync({
    id,
    userId,
    name,
    tokenHash: hashApiToken(raw),
    scopes: normalizedScopes,
    expiresAt,
    resourceMode,
    resources: withResourceIds(resources),
  });

  const notebookResources = await serializeResources(id);
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
    notebookResources,
    expiresAt,
    createdAt: new Date().toISOString(),
    token: raw,
    warning: "该 token 只会显示这一次，请妥善保存。可在需要时随时吊销。",
  }, 201);
});

/** 当前用户可授权给 Token 的笔记本。 */
app.get("/notebook-options", async (c) => {
  const denied = rejectApiTokenManagement(c);
  if (denied) return denied;

  const userId = c.req.header("X-User-Id")!;
  const options = await apiTokenResourcesRepository.listAuthorizedNotebookOptionsAsync(userId);
  return c.json({
    notebooks: options.map(({ permission: _permission, ...option }) => option),
  });
});

/** 修改已有 Token 的资源模式与笔记本授权，不轮换明文。 */
app.patch("/:id/resources", async (c) => {
  const denied = rejectApiTokenManagement(c);
  if (denied) return denied;

  const userId = c.req.header("X-User-Id")!;
  const tokenId = c.req.param("id");
  const token = await apiTokensRepository.getByIdAndUserAsync(tokenId, userId);
  if (!token) return c.json({ error: "token 不存在" }, 404);
  if (token.revokedAt) return c.json({ error: "已吊销 token 不能再修改授权" }, 409);

  const body = (await c.req.json().catch(() => ({}))) as {
    resourceMode?: ApiTokenResourceMode;
    notebookResources?: NotebookResourceRequest[];
  };
  const resourceMode = normalizeResourceMode(body.resourceMode);
  const resources = normalizeResources(body.notebookResources);
  const resourceError = await validateResources(userId, resources);
  if (resourceError) return c.json({ error: resourceError }, 403);

  await apiTokenResourcesRepository.updateTokenResourcesAsync({
    tokenId,
    userId,
    resourceMode,
    resources: withResourceIds(resources),
  });

  const notebookResources = await serializeResources(tokenId);
  logAudit(userId, "system", "api_token_resources_updated", {
    tokenId,
    resourceMode,
    notebookResources: resources,
  }, { targetType: "api_token", targetId: tokenId });

  return c.json({
    success: true,
    resourceMode,
    notebookResources,
  });
});

/** 使用统计。 */
app.get("/usage", async (c) => {
  const userId = c.req.header("X-User-Id")!;
  const parsed = Number.parseInt(c.req.query("days") || "7", 10);
  const days = Number.isFinite(parsed) && parsed >= 1 && parsed <= 90 ? parsed : 7;
  const today = new Date();
  const todayDay = today.toISOString().slice(0, 10);
  const startDay = new Date(today.getTime() - (days - 1) * 86400_000)
    .toISOString()
    .slice(0, 10);
  const prevStartDay = new Date(today.getTime() - (days * 2 - 1) * 86400_000)
    .toISOString()
    .slice(0, 10);
  const prevEndDay = new Date(today.getTime() - days * 86400_000)
    .toISOString()
    .slice(0, 10);

  const [dailyRows, prevTotal, byTokenRows] = await Promise.all([
    apiTokensRepository.getDailyUsageAsync(userId, startDay, todayDay),
    apiTokensRepository.getPrevPeriodTotalAsync(userId, prevStartDay, prevEndDay),
    apiTokensRepository.getUsageByTokenAsync(userId, startDay, todayDay),
  ]);

  const dailyMap = new Map<string, number>();
  for (const row of dailyRows) dailyMap.set(row.day, Number(row.count));
  const series: Array<{ day: string; count: number }> = [];
  for (let index = days - 1; index >= 0; index -= 1) {
    const day = new Date(today.getTime() - index * 86400_000)
      .toISOString()
      .slice(0, 10);
    series.push({ day, count: dailyMap.get(day) || 0 });
  }

  return c.json({
    days,
    total: series.reduce((sum, item) => sum + item.count, 0),
    prevTotal: Number(prevTotal) || 0,
    series,
    byToken: byTokenRows.map((row) => ({ ...row, count: Number(row.count) })),
  });
});

/** 吊销 Token。 */
app.delete("/:id", async (c) => {
  const denied = rejectApiTokenManagement(c);
  if (denied) return denied;

  const userId = c.req.header("X-User-Id")!;
  const id = c.req.param("id");
  const row = await apiTokensRepository.getByIdAndUserAsync(id, userId);
  if (!row) return c.json({ error: "token 不存在" }, 404);
  if (row.revokedAt) return c.json({ success: true, alreadyRevoked: true });

  await apiTokensRepository.revokeByIdAsync(id);
  logAudit(userId, "system", "api_token_revoked", { tokenId: id }, {
    targetType: "api_token",
    targetId: id,
  });

  return c.json({ success: true });
});

export default app;
