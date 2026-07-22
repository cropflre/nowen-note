import crypto from "crypto";
import type { Context, Next } from "hono";
import type { Hono } from "hono";
import { getDb } from "../db/schema";
import { verifyShareAccessToken } from "../lib/auth-security";

export interface SingleShareAccessRow {
  id: string;
  noteId: string;
  ownerId: string;
  permission: string;
  password: string | null;
  credentialVersion: number;
  isActive: number;
  expiresAt: string | null;
  maxViews: number | null;
  viewCount: number;
}

export type SingleShareAccessResult =
  | { ok: true; sessionHash: string | null }
  | { ok: false; status: 401 | 404 | 410; payload: Record<string, unknown> };

export function findSingleShareByToken(token: string): SingleShareAccessRow | undefined {
  if (!token || token.length > 256) return undefined;
  return getDb().prepare(`
    SELECT id, noteId, ownerId, permission, password,
           COALESCE(credentialVersion, 1) AS credentialVersion,
           isActive, expiresAt, maxViews, viewCount
    FROM shares WHERE shareToken = ?
  `).get(token) as SingleShareAccessRow | undefined;
}

export function getShareSessionHash(c: Context, shareId: string): string | null {
  const raw = (c.req.header("X-Share-Session") || c.req.header("x-share-session") || "").trim();
  if (!raw || raw.length < 8 || raw.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(raw)) return null;
  return crypto.createHash("sha256").update(`${shareId}:${raw}`).digest("hex");
}

function isExpired(value: string | null): boolean {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

function hasKnownSession(shareId: string, sessionHash: string | null): boolean {
  if (!sessionHash) return false;
  return Boolean(getDb().prepare(
    "SELECT 1 AS ok FROM share_view_sessions WHERE shareId = ? AND sessionHash = ?",
  ).get(shareId, sessionHash));
}

export function authorizeSingleShareRequest(
  c: Context,
  share: SingleShareAccessRow | undefined,
  options: { requireCredential?: boolean } = {},
): SingleShareAccessResult {
  if (!share) return { ok: false, status: 404, payload: { error: "分享不存在", code: "SHARE_NOT_FOUND" } };
  if (!share.isActive) return { ok: false, status: 410, payload: { error: "分享已被撤销", code: "SHARE_REVOKED" } };
  if (isExpired(share.expiresAt)) {
    return { ok: false, status: 410, payload: { error: "分享链接已过期", code: "SHARE_EXPIRED" } };
  }

  const sessionHash = getShareSessionHash(c, share.id);
  if (share.maxViews && share.viewCount >= share.maxViews && !hasKnownSession(share.id, sessionHash)) {
    return { ok: false, status: 410, payload: { error: "分享链接已达到最大访问会话数", code: "SHARE_VIEW_LIMIT" } };
  }

  if (options.requireCredential && share.password) {
    const auth = c.req.header("Authorization") || "";
    if (!auth.startsWith("Bearer ")) {
      return { ok: false, status: 401, payload: { error: "需要密码验证", code: "SHARE_PASSWORD_REQUIRED", needPassword: true } };
    }
    const verified = verifyShareAccessToken(auth.slice(7), share.id, share.credentialVersion);
    if (!verified) {
      return { ok: false, status: 401, payload: { error: "分享访问令牌无效或已过期", code: "SHARE_ACCESS_TOKEN_INVALID" } };
    }
  }

  return { ok: true, sessionHash };
}

export function consumeShareViewSession(
  c: Context,
  share: SingleShareAccessRow,
): { ok: true; counted: boolean; viewCount: number } | { ok: false } {
  const db = getDb();
  const sessionHash = getShareSessionHash(c, share.id);
  return db.transaction(() => {
    if (sessionHash) {
      const existing = db.prepare(
        "SELECT 1 AS ok FROM share_view_sessions WHERE shareId = ? AND sessionHash = ?",
      ).get(share.id, sessionHash);
      if (existing) {
        db.prepare("UPDATE share_view_sessions SET lastSeenAt = datetime('now') WHERE shareId = ? AND sessionHash = ?")
          .run(share.id, sessionHash);
        const current = db.prepare("SELECT viewCount FROM shares WHERE id = ?").get(share.id) as { viewCount: number };
        return { ok: true as const, counted: false, viewCount: current.viewCount };
      }
    }

    const updated = db.prepare(`
      UPDATE shares SET viewCount = viewCount + 1
      WHERE id = ? AND isActive = 1
        AND (maxViews IS NULL OR viewCount < maxViews)
    `).run(share.id);
    if (!updated.changes) return { ok: false as const };

    if (sessionHash) {
      db.prepare(`
        INSERT OR IGNORE INTO share_view_sessions (shareId, sessionHash, createdAt, lastSeenAt)
        VALUES (?, ?, datetime('now'), datetime('now'))
      `).run(share.id, sessionHash);
    }
    const current = db.prepare("SELECT viewCount FROM shares WHERE id = ?").get(share.id) as { viewCount: number };
    return { ok: true as const, counted: true, viewCount: current.viewCount };
  })();
}

export function resetShareViewSessions(shareId: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare("DELETE FROM share_view_sessions WHERE shareId = ?").run(shareId);
    db.prepare("UPDATE shares SET viewCount = 0 WHERE id = ?").run(shareId);
  })();
}

export function installSingleShareGuard(router: Hono): void {
  const guard = async (c: Context, next: Next) => {
    const token = c.req.param("token");
    if (!token || token === "notebook-public") return next();
    const share = findSingleShareByToken(token);
    const path = c.req.path;
    const isVerify = path.endsWith(`/${token}/verify`);
    const isInfo = c.req.method === "GET" && path.endsWith(`/${token}`);
    const result = authorizeSingleShareRequest(c, share, { requireCredential: !isVerify && !isInfo });
    c.header("Cache-Control", "private, no-store");
    c.header("Pragma", "no-cache");
    if (!result.ok) return c.json(result.payload, result.status);
    await next();
  };
  router.use("/:token", guard);
  router.use("/:token/*", guard);
}
