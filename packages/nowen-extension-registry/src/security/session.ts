import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Context } from "hono";
import { withImmediateTransaction } from "../db/transaction.js";

export const SESSION_COOKIE = "nowen_registry_session";

export interface SessionIdentity {
  sessionId: string;
  developerId: string | null;
  adminUserId: string | null;
  csrfHash: string;
  expiresAt: string;
  viaCookie: boolean;
}
export interface IssuedSession {
  sessionId: string;
  token: string;
  csrfToken: string;
  expiresAt: string;
}

function digest(secret: string, value: string): string {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

function randomToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function parseCookie(header: string | undefined, name: string): string | null {
  for (const part of (header || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return null;
}

export function sessionCookie(token: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export class SessionService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly secret: string,
    private readonly ttlSeconds: number,
  ) {}

  issue(identity: { developerId?: string; adminUserId?: string }, rotatedFrom?: string): IssuedSession {
    if (Boolean(identity.developerId) === Boolean(identity.adminUserId)) throw new Error("session identity must contain exactly one actor");
    const token = randomToken();
    const csrfToken = randomToken();
    const sessionId = crypto.randomUUID();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + this.ttlSeconds * 1000).toISOString();
    this.db.prepare(`INSERT INTO sessions(id,tokenHash,csrfHash,developerId,adminUserId,expiresAt,lastUsedAt,revokedAt,rotatedFrom,createdAt)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      sessionId, digest(this.secret, token), digest(this.secret, csrfToken), identity.developerId || null,
      identity.adminUserId || null, expiresAt, createdAt.toISOString(), null, rotatedFrom || null, createdAt.toISOString(),
    );
    return { sessionId, token, csrfToken, expiresAt };
  }

  authenticate(c: Context): SessionIdentity {
    const authorization = c.req.header("authorization");
    const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1] || null;
    const cookieToken = parseCookie(c.req.header("cookie"), SESSION_COOKIE);
    const token = bearer || cookieToken;
    if (!token) throw new Error("authentication required");
    const row = this.db.prepare(`SELECT id AS sessionId,developerId,adminUserId,csrfHash,expiresAt
      FROM sessions WHERE tokenHash=? AND revokedAt IS NULL`).get(digest(this.secret, token)) as Omit<SessionIdentity, "viaCookie"> | undefined;
    if (!row || Date.parse(row.expiresAt) <= Date.now()) throw new Error("session expired or revoked");
    this.db.prepare("UPDATE sessions SET lastUsedAt=? WHERE id=?").run(new Date().toISOString(), row.sessionId);
    return { ...row, viaCookie: !bearer };
  }

  verifyCsrf(identity: SessionIdentity, csrfToken: string): boolean {
    const actual = Buffer.from(digest(this.secret, csrfToken));
    const expected = Buffer.from(identity.csrfHash);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  rotate(c: Context, onRotated?: (previous: SessionIdentity, issued: IssuedSession) => void): IssuedSession {
    const current = this.authenticate(c);
    return withImmediateTransaction(this.db, () => {
      const revoked = this.db.prepare("UPDATE sessions SET revokedAt=? WHERE id=? AND revokedAt IS NULL").run(new Date().toISOString(), current.sessionId);
      if (revoked.changes !== 1) throw new Error("session already revoked");
      const issued = this.issue({ developerId: current.developerId || undefined, adminUserId: current.adminUserId || undefined }, current.sessionId);
      onRotated?.(current, issued);
      return issued;
    });
  }

  revoke(c: Context, onRevoked?: (current: SessionIdentity) => void): SessionIdentity {
    const current = this.authenticate(c);
    return withImmediateTransaction(this.db, () => {
      const revoked = this.db.prepare("UPDATE sessions SET revokedAt=? WHERE id=? AND revokedAt IS NULL").run(new Date().toISOString(), current.sessionId);
      if (revoked.changes !== 1) throw new Error("session already revoked");
      onRevoked?.(current);
      return current;
    });
  }
}
