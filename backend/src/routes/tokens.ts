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
import { getDb } from "../db/schema";
import {
  API_TOKEN_SCOPES,
  generateApiTokenRaw,
  hashApiToken,
  initApiTokensTable,
  isValidScope,
  API_TOKEN_PREFIX,
} from "../lib/api-tokens";

const app = new Hono();

// 保证表存在（幂等）
initApiTokensTable(getDb());

/** 列出当前用户的 token（明文字段永远不返回） */
app.get("/", (c) => {
  const userId = c.req.header("X-User-Id")!;
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, name, scopes, expiresAt, lastUsedAt, lastUsedIp, createdAt, revokedAt
       FROM api_tokens WHERE userId = ?
       ORDER BY revokedAt IS NOT NULL, createdAt DESC`,
    )
    .all(userId) as Array<{
    id: string;
    name: string;
    scopes: string;
    expiresAt: string | null;
    lastUsedAt: string | null;
    lastUsedIp: string | null;
    createdAt: string;
    revokedAt: string | null;
  }>;

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

  const db = getDb();
  db.prepare(
    `INSERT INTO api_tokens (id, userId, name, tokenHash, scopes, expiresAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, name, hash, JSON.stringify(normalizedScopes), expiresAt);

  return c.json(
    {
      id,
      name,
      scopes: normalizedScopes,
      expiresAt,
      createdAt: new Date().toISOString(),
      /** 明文 token：**仅此一次** 返回，之后任何 GET 都只能看到前缀预览 */
      token: raw,
      warning:
        "该 token 只会显示这一次，请妥善保存。可在需要时随时吊销。",
    },
    201,
  );
});

/** 吊销 token（软删，保留审计） */
app.delete("/:id", (c) => {
  const userId = c.req.header("X-User-Id")!;
  const id = c.req.param("id");
  const db = getDb();
  const row = db
    .prepare("SELECT id, userId, revokedAt FROM api_tokens WHERE id = ?")
    .get(id) as { id: string; userId: string; revokedAt: string | null } | undefined;
  if (!row) return c.json({ error: "token 不存在" }, 404);
  if (row.userId !== userId) return c.json({ error: "无权操作该 token" }, 403);
  if (row.revokedAt) return c.json({ success: true, alreadyRevoked: true });

  db.prepare("UPDATE api_tokens SET revokedAt = datetime('now') WHERE id = ?").run(id);
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
