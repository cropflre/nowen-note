import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { RegistryConfig } from "../config.js";
import { withImmediateTransaction } from "../db/transaction.js";
import { AuditLog } from "../security/audit.js";
import { RateLimiter } from "../security/rateLimit.js";
import { SessionService, clearSessionCookie, sessionCookie } from "../security/session.js";
import { documentDigest, signDocument } from "../security/signing.js";
import { decryptSecret, verifyTotp } from "../security/totp.js";

type AdvisorySeverity = "critical" | "high" | "medium" | "low";
type AdvisoryAction = "disable" | "recommend" | "warn" | "info";

const EXPECTED_ACTION: Record<AdvisorySeverity, AdvisoryAction> = {
  critical: "disable",
  high: "recommend",
  medium: "warn",
  low: "info",
};

function validVersionRangeSyntax(range: string): boolean {
  if (!range.trim()) return false;
  return range.split("||").every((alternative) => {
    const comparators = alternative.trim().split(/[\s,]+/).filter(Boolean);
    return comparators.length > 0 && comparators.every((comparator) => comparator === "*"
      || /^x$/i.test(comparator)
      || /^(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/i.test(comparator)
      || /^(>=|<=|>|<|=|\^|~)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(comparator));
  });
}

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
    const issued = withImmediateTransaction(db, () => {
      const created = sessions.issue({ adminUserId: admin.id });
      audit.append({ actorType: "admin", actorId: admin.id, action: "admin.session.create", targetType: "session", targetId: created.sessionId });
      return created;
    });
    c.header("Set-Cookie", sessionCookie(issued.token, config.sessionTtlSeconds));
    c.header("Cache-Control", "no-store");
    return c.json({ csrfToken: issued.csrfToken, expiresAt: issued.expiresAt });
  });

  app.post("/logout", (c) => {
    try {
      const identity = sessions.authenticate(c);
      if (!identity.adminUserId) return c.json({ error: "admin session required" }, 403);
      sessions.revoke(c, (current) => audit.append({ actorType: "admin", actorId: identity.adminUserId, action: "admin.session.revoke", targetType: "session", targetId: current.sessionId }));
      c.header("Set-Cookie", clearSessionCookie());
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
      const body = await c.req.json() as {
        id?: string; pluginId?: string; affectedVersionRange?: string; expiresAt?: string; severity?: AdvisorySeverity;
        action?: AdvisoryAction; state?: "active" | "withdrawn"; replaces?: string | null; title?: string; detailsUrl?: string;
      };
      const id = body.id || crypto.randomUUID();
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) || body.state !== "active" && body.state !== "withdrawn") throw new Error("invalid advisory id or state");
      const state = body.state;
      const issuedAt = new Date().toISOString();
      if (!body.expiresAt || !Number.isFinite(Date.parse(body.expiresAt)) || Date.parse(body.expiresAt) <= Date.parse(issuedAt)) throw new Error("advisory expiresAt must be after issuedAt");
      const expiresAt = body.expiresAt;
      const advisory = withImmediateTransaction(db, () => {
        const previous = db.prepare("SELECT * FROM security_advisories WHERE id=?").get(id) as Record<string, any> | undefined;
        let pluginId = body.pluginId;
        let affectedVersionRange = body.affectedVersionRange;
        let severity = body.severity;
        let action = body.action;
        let replaces = body.replaces ?? null;
        let title = body.title;
        let detailsUrl = body.detailsUrl || null;
        if (state === "withdrawn") {
          if (!previous || previous.state !== "active") throw new Error("withdrawal requires an existing active advisory with the same id");
          if (db.prepare("SELECT 1 FROM security_advisories WHERE replaces=? AND state='active'").get(id)) throw new Error("advisory referenced by an active replacement cannot be withdrawn directly");
          pluginId = previous.pluginId; affectedVersionRange = previous.affectedVersionRange; severity = previous.severity;
          action = previous.action; replaces = previous.replaces; title = previous.title; detailsUrl = previous.detailsUrl;
        } else if (previous) {
          throw new Error("active advisory id already exists; use a replacement id or withdraw it");
        }
        if (!pluginId || !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(pluginId) || !affectedVersionRange || !validVersionRangeSyntax(affectedVersionRange)
          || !severity || !action || EXPECTED_ACTION[severity] !== action || !title?.trim()) throw new Error("invalid advisory fields or severity/action mapping");
        if (replaces) {
          const replaced = db.prepare("SELECT id,pluginId,sequence,state FROM security_advisories WHERE id=?").get(replaces) as { id: string; pluginId: string; sequence: number; state: string } | undefined;
          if (!replaced || replaced.id === id || replaced.pluginId !== pluginId || replaced.state !== "active") throw new Error("replaces must reference an active advisory for the same plugin");
        }
        db.prepare(`INSERT INTO registry_metadata_sequence(documentType,sequence) VALUES ('advisory',0)
          ON CONFLICT(documentType) DO NOTHING`).run();
        db.prepare("UPDATE registry_metadata_sequence SET sequence=sequence+1 WHERE documentType='advisory'").run();
        const sequenceRow = db.prepare("SELECT sequence FROM registry_metadata_sequence WHERE documentType='advisory'").get() as { sequence: number };
        const unsigned = {
          id, sequence: sequenceRow.sequence, pluginId, affectedVersionRange, issuedAt, expiresAt,
          severity, action, state, replaces, title: title.trim(),
          ...(detailsUrl ? { detailsUrl } : {}),
          signerKeyId: config.signerKeyId,
        };
        const signature = signDocument(unsigned, config.signingPrivateKey);
        const signed = { ...unsigned, signature };
        if (state === "withdrawn") {
          db.prepare(`UPDATE security_advisories SET sequence=?,pluginId=?,affectedVersionRange=?,issuedAt=?,expiresAt=?,severity=?,action=?,state=?,replaces=?,title=?,detailsUrl=?,signerKeyId=?,signature=?,updatedAt=? WHERE id=?`).run(
            signed.sequence, signed.pluginId, signed.affectedVersionRange, signed.issuedAt, signed.expiresAt, signed.severity, signed.action,
            signed.state, signed.replaces, signed.title, signed.detailsUrl || null, signed.signerKeyId, signed.signature, issuedAt, id,
          );
        } else {
          db.prepare(`INSERT INTO security_advisories(id,sequence,pluginId,affectedVersionRange,issuedAt,expiresAt,severity,action,state,replaces,title,detailsUrl,signerKeyId,signature,createdAt,updatedAt)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            id, signed.sequence, signed.pluginId, signed.affectedVersionRange, signed.issuedAt, signed.expiresAt, signed.severity,
            signed.action, signed.state, signed.replaces, signed.title, signed.detailsUrl || null, signed.signerKeyId, signed.signature, issuedAt, issuedAt,
          );
        }
        db.prepare(`UPDATE registry_metadata_sequence SET digest=?,signerKeyId=?,generatedAt=?,expiresAt=? WHERE documentType='advisory'`).run(
          documentDigest(unsigned), config.signerKeyId, issuedAt, expiresAt,
        );
        audit.append({ actorType: "admin", actorId: identity.adminUserId, action: `advisory.${state}`, targetType: "security_advisory", targetId: id, metadata: { pluginId, sequence: signed.sequence, replaces, severity } });
        return signed;
      });
      return c.json(advisory, 201);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  return app;
}
