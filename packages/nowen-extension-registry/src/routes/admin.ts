import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { RegistryConfig } from "../config.js";
import { AuditLog } from "../security/audit.js";
import { RateLimiter } from "../security/rateLimit.js";
import { SessionService, clearSessionCookie, sessionCookie } from "../security/session.js";
import { decryptSecret, verifyTotp } from "../security/totp.js";

function verifyPassword(candidate: string, encoded: string): boolean {
  const [scheme, costRaw, blockSizeRaw, parallelRaw, saltRaw, digestRaw] = encoded.split("$");
  if (scheme !== "scrypt" || !costRaw || !blockSizeRaw || !parallelRaw || !saltRaw || !digestRaw) return false;
  const expected = Buffer.from(digestRaw, "base64");
  const actual = crypto.scryptSync(candidate, Buffer.from(saltRaw, "base64"), expected.length, {
    N: Number(costRaw), r: Number(blockSizeRaw), p: Number(parallelRaw), maxmem: 128 * 1024 * 1024,
  });
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function hashAdminPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const digest = crypto.scryptSync(password, salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString("base64")}$${digest.toString("base64")}`;
}

export function createAdminRoutes(db: DatabaseSync, config: RegistryConfig, sessions: SessionService, limiter: RateLimiter, audit: AuditLog): Hono {
  const app = new Hono();

  app.post("/session", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { username?: string; password?: string; totp?: string };
    const username = String(body.username || "").trim();
    if (!limiter.consume("account", `admin-login:${username || "unknown"}`, 10)) return c.json({ error: "login rate limit exceeded" }, 429);
    const admin = db.prepare("SELECT id,passwordHash FROM admin_users WHERE username=? AND enabled=1").get(username) as { id: string; passwordHash: string } | undefined;
    const totp = admin ? db.prepare("SELECT secretCiphertext,secretIv,secretTag FROM admin_totp WHERE adminUserId=? AND enabled=1").get(admin.id) as { secretCiphertext: string; secretIv: string; secretTag: string } | undefined : undefined;
    const validPassword = admin && typeof body.password === "string" && verifyPassword(body.password, admin.passwordHash);
    const validTotp = totp && typeof body.totp === "string" && verifyTotp(decryptSecret(totp.secretCiphertext, totp.secretIv, totp.secretTag, config.sessionSecret), body.totp);
    if (!admin || !validPassword || !validTotp) return c.json({ error: "admin authentication failed" }, 401);
    const issued = sessions.issue({ adminUserId: admin.id });
    c.header("Set-Cookie", sessionCookie(issued.token, config.sessionTtlSeconds));
    c.header("Cache-Control", "no-store");
    audit.append({ actorType: "admin", actorId: admin.id, action: "admin.session.create", targetType: "session" });
    return c.json({ csrfToken: issued.csrfToken, expiresAt: issued.expiresAt });
  });

  app.post("/logout", (c) => {
    try {
      const identity = sessions.authenticate(c);
      if (!identity.adminUserId) return c.json({ error: "admin session required" }, 403);
      sessions.revoke(c);
      c.header("Set-Cookie", clearSessionCookie());
      audit.append({ actorType: "admin", actorId: identity.adminUserId, action: "admin.session.revoke", targetType: "session", targetId: identity.sessionId });
      return c.json({ success: true });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 401);
    }
  });

  app.post("/advisories", async (c) => {
    try {
      const identity = sessions.authenticate(c);
      if (!identity.adminUserId) return c.json({ error: "admin session required" }, 403);
      const totpRow = db.prepare("SELECT secretCiphertext,secretIv,secretTag FROM admin_totp WHERE adminUserId=? AND enabled=1").get(identity.adminUserId) as { secretCiphertext: string; secretIv: string; secretTag: string } | undefined;
      const code = c.req.header("x-totp-code") || "";
      if (!totpRow || !verifyTotp(decryptSecret(totpRow.secretCiphertext, totpRow.secretIv, totpRow.secretTag, config.sessionSecret), code)) return c.json({ error: "current TOTP required" }, 403);
      const body = await c.req.json() as { id?: string; extensionId?: string; versions?: string[]; state?: string; severity?: string; title?: string; detailsUrl?: string; action?: string };
      if (!body.extensionId || !body.title || !Array.isArray(body.versions) || !["warning", "revoked", "malicious"].includes(body.state || "") || !["warn", "disable"].includes(body.action || "")) throw new Error("invalid advisory");
      const id = body.id || crypto.randomUUID();
      const at = new Date().toISOString();
      const extensionId = body.extensionId;
      const title = body.title;
      const state = body.state!;
      const action = body.action!;
      db.prepare(`INSERT INTO security_advisories(id,extensionId,versionsJson,state,severity,title,detailsUrl,action,createdAt,updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, extensionId, JSON.stringify(body.versions), state, body.severity || "medium", title, body.detailsUrl || null, action, at, at);
      audit.append({ actorType: "admin", actorId: identity.adminUserId, action: "advisory.create", targetType: "security_advisory", targetId: id, metadata: { extensionId, state, severity: body.severity } });
      return c.json({ id }, 201);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  return app;
}
