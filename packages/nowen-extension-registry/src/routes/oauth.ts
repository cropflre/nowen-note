import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { RegistryConfig } from "../config.js";
import { AuditLog } from "../security/audit.js";
import { SessionService, clearSessionCookie, sessionCookie } from "../security/session.js";
import { decryptSecret, encryptSecret } from "../security/totp.js";

function hash(secret: string, value: string): string {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}
function challenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

export function createOAuthRoutes(db: DatabaseSync, config: RegistryConfig, sessions: SessionService, audit: AuditLog): Hono {
  const app = new Hono();

  app.get("/github/start", (c) => {
    const state = crypto.randomBytes(32).toString("base64url");
    const verifier = crypto.randomBytes(64).toString("base64url");
    const encrypted = encryptSecret(verifier, config.sessionSecret);
    const createdAt = new Date();
    db.prepare("DELETE FROM oauth_states WHERE expiresAt<=? OR consumedAt IS NOT NULL").run(createdAt.toISOString());
    db.prepare(`INSERT INTO oauth_states(stateHash,verifierCiphertext,verifierIv,verifierTag,redirectUri,expiresAt,consumedAt,createdAt)
      VALUES (?,?,?,?,?,?,NULL,?)`).run(
      hash(config.sessionSecret, state), encrypted.ciphertext, encrypted.iv, encrypted.tag,
      config.githubCallbackUrl.toString(), new Date(createdAt.getTime() + 10 * 60_000).toISOString(), createdAt.toISOString(),
    );
    const authorize = new URL("https://github.com/login/oauth/authorize");
    authorize.searchParams.set("client_id", config.githubClientId);
    authorize.searchParams.set("redirect_uri", config.githubCallbackUrl.toString());
    authorize.searchParams.set("scope", "read:user");
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("code_challenge", challenge(verifier));
    authorize.searchParams.set("code_challenge_method", "S256");
    return c.redirect(authorize.toString());
  });

  app.get("/github/callback", async (c) => {
    const state = c.req.query("state");
    const code = c.req.query("code");
    if (!state || !code) return c.json({ error: "oauth code and state are required" }, 400);
    const stateHash = hash(config.sessionSecret, state);
    const consumedAt = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    let stored: { verifierCiphertext: string; verifierIv: string; verifierTag: string; redirectUri: string } | undefined;
    try {
      stored = db.prepare(`SELECT verifierCiphertext,verifierIv,verifierTag,redirectUri FROM oauth_states
        WHERE stateHash=? AND consumedAt IS NULL AND expiresAt>?`).get(stateHash, consumedAt) as typeof stored;
      if (!stored) throw new Error("oauth state is invalid, expired, or already consumed");
      const changed = db.prepare("UPDATE oauth_states SET consumedAt=? WHERE stateHash=? AND consumedAt IS NULL").run(consumedAt, stateHash);
      if (changed.changes !== 1) throw new Error("oauth state was already consumed");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      return c.json({ error: (error as Error).message }, 400);
    }

    const verifier = decryptSecret(stored.verifierCiphertext, stored.verifierIv, stored.verifierTag, config.sessionSecret);
    const exchange = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "Nowen-Registry" },
      body: JSON.stringify({
        client_id: config.githubClientId,
        client_secret: config.githubClientSecret,
        code,
        redirect_uri: stored.redirectUri,
        code_verifier: verifier,
      }),
    });
    if (!exchange.ok) return c.json({ error: "github token exchange failed" }, 502);
    const access = await exchange.json() as { access_token?: string };
    if (!access.access_token) return c.json({ error: "github did not return an access token" }, 502);
    const profileResponse = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${access.access_token}`, "User-Agent": "Nowen-Registry" } });
    if (!profileResponse.ok) return c.json({ error: "github profile request failed" }, 502);
    const profile = await profileResponse.json() as { id?: number; login?: string; avatar_url?: string };
    if (!profile.id || !profile.login) return c.json({ error: "github profile is incomplete" }, 502);
    const newId = crypto.randomUUID();
    db.prepare(`INSERT INTO developers(id,githubId,login,avatar,createdAt) VALUES (?,?,?,?,?)
      ON CONFLICT(githubId) DO UPDATE SET login=excluded.login,avatar=excluded.avatar`).run(newId, String(profile.id), profile.login, profile.avatar_url || null, consumedAt);
    const developer = db.prepare("SELECT id FROM developers WHERE githubId=?").get(String(profile.id)) as { id: string };
    const issued = sessions.issue({ developerId: developer.id });
    c.header("Set-Cookie", sessionCookie(issued.token, config.sessionTtlSeconds));
    c.header("Cache-Control", "no-store");
    audit.append({ actorType: "developer", actorId: developer.id, action: "session.create", targetType: "session" });
    return c.json({ login: profile.login, csrfToken: issued.csrfToken, expiresAt: issued.expiresAt });
  });

  app.post("/session/rotate", (c) => {
    try {
      const issued = sessions.rotate(c);
      c.header("Set-Cookie", sessionCookie(issued.token, config.sessionTtlSeconds));
      c.header("Cache-Control", "no-store");
      return c.json({ csrfToken: issued.csrfToken, expiresAt: issued.expiresAt });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 401);
    }
  });

  app.post("/session/revoke", (c) => {
    try {
      sessions.revoke(c);
      c.header("Set-Cookie", clearSessionCookie());
      return c.json({ success: true });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 401);
    }
  });

  return app;
}
