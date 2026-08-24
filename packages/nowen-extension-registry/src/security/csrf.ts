import type { Context, Next } from "hono";
import type { SessionIdentity, SessionService } from "./session.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function requireCookieWriteProtection(
  allowedOrigins: ReadonlySet<string>,
  sessions: SessionService,
  resolveIdentity: (c: Context) => SessionIdentity,
) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    let identity: SessionIdentity;
    try {
      identity = resolveIdentity(c);
    } catch {
      return next();
    }
    if (!identity.viaCookie) return next();
    const origin = c.req.header("origin");
    if (!origin || !allowedOrigins.has(origin)) return c.json({ error: "origin denied" }, 403);
    const csrfToken = c.req.header("x-csrf-token");
    if (!csrfToken || !sessions.verifyCsrf(identity, csrfToken)) return c.json({ error: "csrf validation failed" }, 403);
    return next();
  };
}
