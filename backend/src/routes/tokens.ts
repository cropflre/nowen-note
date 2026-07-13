/**
 * Personal API Token 管理路由（/api/tokens）
 * ---------------------------------------------------------------------------
 * - GET    /api/tokens           列出当前用户的 token（明文不会返回，只返回前 4 位预览）
 * - POST   /api/tokens           创建 token，**明文只返回这一次**
 * - DELETE /api/tokens/:id       吊销 token（不删除记录，保留审计）
 *
 * 受全局 JWT 中间件保护；不能用 API token 自己创建 token（只接受 login JWT）。
 */
import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import {
  API_TOKEN_SCOPES,
  generateApiTokenRaw,
  hashApiToken,
  isValidScope,
  API_TOKEN_PREFIX,
} from "../lib/api-tokens";
import { apiTokensRepository } from "../repositories";
import { logAudit } from "../services/audit";

const app = new Hono();

/** 列出当前用户的 token（明文字段永远不返回） */
app.get("/", async (c) => {
  const userId = c.req.header("X-User-Id")!;
  const rows = await apiTokensRepository.listByUserAsync(userId);

  return c.json({
    tokens: rows.map((r) => ({
      id: r.id,
      name: r.name,
      scopes: safeParseJsonArray(r.scopes),
      expiresAt: r.expiresAt,
      lastUsedAt: r.lastUsedAt,
      lastUsedIp: r.lastUsedIp,
      createdAt: r.createdAt,
      revokedAt: r.revokedAt,
    })),
    availableScopes: API_TOKEN_SCOPES,
  });
});

/** 创建 token，返回明文（仅此一次） */
app.post("/", async (c) => {
  const userId = c.req.header("X-User-Id")!;
  // 拒绝使用 API token 创建新 token（防止 token 自我增殖被滥用）。
  // 判别方式：Authorization 头里的 Bearer 是否以 nkn_ 开头。
  const authz = c.req.header("Authorization") || "";
  if (authz.startsWith("Bearer ") && authz.slice(7).startsWith(API_TOKEN_PREFIX)) {
    return c.json(
      { error: "不允许使用 API Token 创建新的 API Token，请使用登录凭证操作" },
      403,
    );
  }

  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    scopes?: string[];
    /** 过期时间（ISO 字符串）；不传或 null 表示永不过期 */
    expiresAt?: string | null;
    /** 或传 expiresInDays 方便前端快选 30/90/365 */
    expiresInDays?: number;
  };

  const name = (body.name || "").trim();
  if (!name) return c.json({ error: "请提供 token 名称" }, 400);
  if (name.length > 64) return c.json({ error: "名称长度最多 64 字符" }, 400);

  // 校验 scopes
  const scopes = Array.isArray(body.scopes) ? body.scopes : [];
  const normalizedScopes: string[] = [];
  for (const s of scopes) {
    if (typeof s !== "string") continue;
    if (!isValidScope(s)) return c.json({ error: `未知 scope: ${s}` }, 400);
    if (!normalizedScopes.includes(s)) normalizedScopes.push(s);
  }

  // 过期时间
  let expiresAt: string | null = null;
  if (typeof body.expiresInDays === "number" && body.expiresInDays > 0) {
    expiresAt = new Date(Date.now() + body.expiresInDays * 86400_000).toISOString();
  } else if (body.expiresAt) {
    const t = Date.parse(body.expiresAt);
    if (isNaN(t)) return c.json({ error: "expiresAt 格式不合法" }, 400);
    if (t < Date.now()) return c.json({ error: "expiresAt 不能早于当前时间" }, 400);
    expiresAt = new Date(t).toISOString();
  }

  const raw = generateApiTokenRaw();
  const hash = hashApiToken(raw);
  const id = uuid();

  await apiTokensRepository.createAsync({
    id,
    userId,
    name,
    tokenHash: hash,
    scopes: normalizedScopes,
    expiresAt,
  });

  // SEC-AUDIT-01: 记录 token 创建（不记录明文 token）
  logAudit(userId, "system", "api_token_created", {
    tokenId: id, name, scopes: normalizedScopes, expiresAt,
  }, { targetType: "api_token", targetId: id });

  return c.json(
    {
      id,
      name,
      scopes: normalizedScopes,
      expiresAt,
      createdAt: new Date().toISOString(),
      token: raw,
      warning: "该 token 只会显示这一次，请妥善保存。可在需要时随时吊销。",
    },
    201,
  );
});

/**
 * GET /api/tokens/usage?days=7
 * ---------------------------------------------------------------------------
 * 返回当前用户所有 token 的使用统计：
 *   - total: 近 days 天总调用
 *   - prevTotal: 再往前 days 天总调用（用于环比同比）
 *   - series: 近 days 天逐天调用量（补零，升序）
 *   - byToken: 近 days 天按 token 聚合的调用量（降序）
 *
 * 只会返回当前用户名下的 token 数据，不包含其他用户。
 */
app.get("/usage", async (c) => {
  const userId = c.req.header("X-User-Id")!;
  const daysParam = parseInt(c.req.query("days") || "7", 10);
  // 限制在 1–90，超出范围默认 7
  const days =
    Number.isFinite(daysParam) && daysParam >= 1 && daysParam <= 90 ? daysParam : 7;

  // 生成今天、本期起点、上期起点（均 UTC）
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

  // 将 dailyRows 按 day 建索引，然后连续补零
  const dailyMap = new Map<string, number>();
  for (const r of dailyRows) dailyMap.set(r.day, r.count);
  const series: Array<{ day: string; count: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400_000)
      .toISOString()
      .slice(0, 10);
    series.push({ day: d, count: dailyMap.get(d) || 0 });
  }
  const total = series.reduce((s, x) => s + x.count, 0);

  return c.json({
    days,
    total,
    prevTotal: prevTotal || 0,
    series,
    byToken: byTokenRows,
  });
});

/** 吊销 token（软删，保留审计） */
app.delete("/:id", async (c) => {
  const userId = c.req.header("X-User-Id")!;
  const id = c.req.param("id");

  const row = await apiTokensRepository.getByIdAndUserAsync(id, userId);
  if (!row) return c.json({ error: "token 不存在" }, 404);
  if (row.userId !== userId) return c.json({ error: "无权操作该 token" }, 403);
  if (row.revokedAt) return c.json({ success: true, alreadyRevoked: true });

  await apiTokensRepository.revokeByIdAsync(id);

  // SEC-AUDIT-01: 记录 token 吊销
  logAudit(userId, "system", "api_token_revoked", {
    tokenId: id,
  }, { targetType: "api_token", targetId: id });

  return c.json({ success: true });
});

function safeParseJsonArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export default app;
