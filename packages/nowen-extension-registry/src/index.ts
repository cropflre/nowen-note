import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { loadRegistryConfig } from "./config.js";
import { withImmediateTransaction } from "./db/transaction.js";
import { createAdminRoutes } from "./routes/admin.js";
import { artifactDownloadUrl, createArtifactRoutes } from "./routes/artifacts.js";
import { createHealthRoutes } from "./routes/health.js";
import { createOAuthRoutes } from "./routes/oauth.js";
import { createPublishRoutes } from "./routes/publish.js";
import { openRegistry } from "./schema.js";
import { AuditLog, safeLog } from "./security/audit.js";
import { enforceRequestBodyBudget } from "./security/bodyBudget.js";
import { requireCookieWriteProtection } from "./security/csrf.js";
import { assertPublisherKeyWindow, normalizePublisherKey } from "./security/publisherKeys.js";
import { RateLimiter, rateLimitMiddleware, resolveClientIp } from "./security/rateLimit.js";
import { RegistryRootManager } from "./security/rootRotation.js";
import { SessionService } from "./security/session.js";
import { documentDigest, signDocument } from "./security/signing.js";
import { LocalArtifactStore } from "./storage/localArtifactStore.js";
import { S3ArtifactStore } from "./storage/s3ArtifactStore.js";

const config = loadRegistryConfig();
const artifactStore = config.artifactStorage.driver === "local"
  ? new LocalArtifactStore(config.artifactStorage.root)
  : new S3ArtifactStore(config.artifactStorage);
const db = openRegistry(path.join(config.dataRoot, "registry.db"));
const sessions = new SessionService(db, config.sessionSecret, config.sessionTtlSeconds);
const limiter = new RateLimiter(db);
const audit = new AuditLog(db);
const rootManager = new RegistryRootManager(db, config, audit);
rootManager.initialize();
const app = new Hono();
const now = () => new Date().toISOString();

function normalizeMirrorBaseUrl(raw: string): string {
  const value = new URL(raw);
  if (!/^https?:$/.test(value.protocol) || (config.environment === "production" && value.protocol !== "https:")) throw new Error("Registry mirror base URL is invalid");
  if (value.username || value.password || value.search || value.hash) throw new Error("Registry mirror base URL cannot contain credentials, query, or fragment");
  value.pathname = `${value.pathname.replace(/\/+$/g, "")}/`;
  return value.toString();
}

function developer(c: Context): string {
  const identity = sessions.authenticate(c);
  if (!identity.developerId) throw new Error("developer session required");
  if (!limiter.consume("account", identity.developerId)) throw new Error("account rate limit exceeded");
  return identity.developerId;
}

function member(publisher: string, developerId: string): void {
  if (!db.prepare("SELECT 1 FROM publisher_members WHERE publisherId=? AND developerId=? AND role IN ('owner','admin')").get(publisher, developerId)) throw new Error("publisher access denied");
}

function transaction<T>(action: () => T): T {
  return withImmediateTransaction(db, action);
}

app.use("*", async (c, next) => {
  const requestId = c.req.header("x-request-id") || crypto.randomUUID();
  const startedAt = Date.now();
  c.header("X-Request-Id", requestId);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cache-Control", "no-store");
  const origin = c.req.header("origin");
  if (origin && config.allowedOrigins.has(origin)) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Access-Control-Allow-Credentials", "true");
    c.header("Vary", "Origin");
  }
  await next();
  safeLog("info", "registry.request", { requestId, method: c.req.method, path: c.req.path, status: c.res.status, durationMs: Date.now() - startedAt });
});
app.use("*", rateLimitMiddleware(limiter, config.trustedProxies));
app.use("*", enforceRequestBodyBudget());
app.use("*", requireCookieWriteProtection(config.allowedOrigins, sessions, (c) => sessions.authenticate(c)));
app.use("*", async (c, next) => {
  if (c.req.method !== "OPTIONS") return next();
  c.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type,Authorization,X-CSRF-Token,X-TOTP-Code");
  return c.body(null, 204);
});

app.route("/health", createHealthRoutes(db, config, artifactStore));
app.route("/oauth", createOAuthRoutes(db, config, sessions, audit));
app.route("/v2/admin", createAdminRoutes(db, config, sessions, limiter, audit, rootManager));
app.route("/v2/publish", createPublishRoutes({ db, config, sessions, limiter, audit, artifactStore }));
app.route("/v2/artifacts", createArtifactRoutes(db, config, artifactStore));

app.post("/v2/publishers", async (c) => {
  try {
    const developerId = developer(c);
    const body = await c.req.json() as { id?: string; displayName?: string; description?: string; website?: string; github?: string };
    if (!body.id || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(body.id) || !body.displayName) throw new Error("invalid publisher");
    const publisherId = body.id;
    const displayName = body.displayName;
    transaction(() => {
      db.prepare("INSERT INTO publishers(id,displayName,description,website,github,createdAt) VALUES (?,?,?,?,?,?)").run(publisherId, displayName, body.description || "", body.website || null, body.github || null, now());
      db.prepare("INSERT INTO publisher_members(publisherId,developerId,role) VALUES (?,?,'owner')").run(publisherId, developerId);
      audit.append({ actorType: "developer", actorId: developerId, action: "publisher.create", targetType: "publisher", targetId: publisherId, ipAddress: resolveClientIp(c, config.trustedProxies) });
    });
    return c.json({ id: publisherId }, 201);
  } catch (error) { return c.json({ error: (error as Error).message }, 400); }
});

app.post("/v2/publishers/:id/keys", async (c) => {
  try {
    const developerId = developer(c);
    const publisherId = c.req.param("id");
    member(publisherId, developerId);
    const body = await c.req.json() as { id?: string; publicKey?: string; validUntil?: string };
    if (!body.id || !body.publicKey || !body.validUntil) throw new Error("key id, public key and validUntil are required");
    const keyId = body.id;
    const publicKey = normalizePublisherKey(body.publicKey);
    const validFrom = now();
    const validUntil = body.validUntil;
    assertPublisherKeyWindow({ validFrom, validUntil }, Date.now(), true);
    transaction(() => {
      db.prepare("INSERT INTO publisher_keys(id,publisherId,publicKey,validFrom,validUntil) VALUES (?,?,?,?,?)").run(keyId, publisherId, publicKey, validFrom, validUntil);
      audit.append({ actorType: "developer", actorId: developerId, action: "publisher_key.create", targetType: "publisher_key", targetId: keyId, metadata: { publisherId }, ipAddress: resolveClientIp(c, config.trustedProxies) });
    });
    return c.json({ id: keyId }, 201);
  } catch (error) { return c.json({ error: (error as Error).message }, 400); }
});

app.post("/v2/publishers/:id/keys/:key/revoke", (c) => {
  try {
    const developerId = developer(c);
    const publisherId = c.req.param("id");
    const keyId = c.req.param("key");
    member(publisherId, developerId);
    transaction(() => {
      const changed = db.prepare("UPDATE publisher_keys SET state='revoked',revokedAt=? WHERE id=? AND publisherId=? AND state='active'").run(now(), keyId, publisherId);
      if (changed.changes !== 1) throw new Error("active publisher key not found");
      audit.append({ actorType: "developer", actorId: developerId, action: "publisher_key.revoke", targetType: "publisher_key", targetId: keyId, metadata: { publisherId }, ipAddress: resolveClientIp(c, config.trustedProxies) });
    });
    return c.json({ success: true });
  } catch (error) { return c.json({ error: (error as Error).message }, 400); }
});

app.get("/v2/index.json", (c) => {
  const signed = transaction(() => {
    db.prepare(`INSERT INTO registry_metadata_sequence(documentType,sequence) VALUES ('index',0)
      ON CONFLICT(documentType) DO NOTHING`).run();
    db.prepare("UPDATE registry_metadata_sequence SET sequence=sequence+1 WHERE documentType='index'").run();
    const sequenceRow = db.prepare("SELECT sequence FROM registry_metadata_sequence WHERE documentType='index'").get() as { sequence: number };
    const generatedAt = now();
    const expiresAt = new Date(Date.parse(generatedAt) + config.metadataTtlSeconds * 1_000).toISOString();
    const publishers = (db.prepare(`SELECT publisherId AS publisher,id AS keyId,publicKey,state,validFrom,validUntil,revokedAt
      FROM publisher_keys ORDER BY publisherId,id`).all() as Array<Record<string, unknown>>).map((publisher) => {
        if (typeof publisher.validFrom !== "string" || (typeof publisher.validUntil !== "string" && publisher.validUntil !== null)) throw new Error("publisher key validity metadata is invalid");
        assertPublisherKeyWindow({ validFrom: publisher.validFrom, validUntil: publisher.validUntil }, Date.now(), publisher.state === "active");
        if (typeof publisher.publicKey !== "string") throw new Error("publisher public key metadata is invalid");
        const publicKey = normalizePublisherKey(publisher.publicKey);
        const { revokedAt, ...metadata } = publisher;
        if (metadata.state === "active" && revokedAt !== null) throw new Error("active publisher key cannot have revokedAt");
        if (metadata.state === "revoked" && (typeof revokedAt !== "string" || !Number.isFinite(Date.parse(revokedAt)))) throw new Error("revoked publisher key metadata is invalid");
        if (metadata.state !== "active" && metadata.state !== "revoked") throw new Error("publisher key state is invalid");
        return { ...metadata, publicKey };
      });
    const extensionRows = db.prepare("SELECT * FROM extensions WHERE listed=1 ORDER BY id").all() as Array<Record<string, any>>;
    const extensions = extensionRows.map((extension) => ({
      id: extension.id,
      publisher: extension.publisherId,
      name: extension.name,
      description: extension.description,
      trustLevel: extension.trustLevel,
      versions: (db.prepare(`SELECT version,apiVersion,runtime,artifactKey,sha256,sizeBytes,publisherKeyId,signature,publishedAt,manifestJson
        FROM extension_versions WHERE extensionId=? ORDER BY publishedAt DESC,version DESC`).all(extension.id) as Array<Record<string, any>>)
        .map(({ manifestJson, ...version }) => {
          const manifest = JSON.parse(manifestJson);
          const artifactUrl = artifactDownloadUrl(config, extension.id, version.version, version.artifactKey);
          return { ...version, artifactUrl, nowen: manifest.engines.nowen, permissions: manifest.permissions, permissionConfig: manifest.permissionConfig, platforms: manifest.platforms, runtimePlatform: manifest.runtimePlatform, uiPlatform: manifest.uiPlatform };
        }),
    }));
    const advisories = (db.prepare(`SELECT id,sequence,pluginId,affectedVersionRange,issuedAt,expiresAt,severity,action,state,replaces,title,detailsUrl,signerKeyId,signature
      FROM security_advisories WHERE expiresAt>? ORDER BY sequence,id`).all(generatedAt) as Array<Record<string, any>>).map((advisory) => ({
      id: advisory.id,
      sequence: advisory.sequence,
      pluginId: advisory.pluginId,
      affectedVersionRange: advisory.affectedVersionRange,
      issuedAt: advisory.issuedAt,
      expiresAt: advisory.expiresAt,
      severity: advisory.severity,
      action: advisory.action,
      state: advisory.state,
      replaces: advisory.replaces,
      title: advisory.title,
      ...(advisory.detailsUrl ? { detailsUrl: advisory.detailsUrl } : {}),
      signerKeyId: advisory.signerKeyId,
      signature: advisory.signature,
    }));
    const rootRotations = rootManager.listPublishedRotations();
    const mirrors = (db.prepare("SELECT id,baseUrl,priority FROM registry_mirrors WHERE enabled=1 ORDER BY priority,id").all() as Array<{ id: string; baseUrl: string; priority: number }>)
      .map((mirror) => ({ id: mirror.id, baseUrl: normalizeMirrorBaseUrl(mirror.baseUrl), priority: mirror.priority }));
    const content = { protocolVersion: 2, sequence: sequenceRow.sequence, generatedAt, expiresAt, signerKeyId: config.signerKeyId, rootRotations, mirrors, publishers, extensions, advisories };
    const metadataDigest = documentDigest(content);
    const unsigned = { ...content, digest: metadataDigest };
    const document = { ...unsigned, signature: signDocument(unsigned, config.signingPrivateKey) };
    db.prepare(`UPDATE registry_metadata_sequence SET digest=?,signerKeyId=?,generatedAt=?,expiresAt=? WHERE documentType='index'`).run(
      metadataDigest, config.signerKeyId, generatedAt, expiresAt,
    );
    return document;
  });
  return c.json(signed);
});

app.get("/v2/extensions/:id", (c) => { const extension = db.prepare("SELECT * FROM extensions WHERE id=? AND listed=1").get(c.req.param("id")); return extension ? c.json(extension) : c.json({ error: "not found" }, 404); });

app.post("/v2/extensions/:id/reviews", async (c) => {
  try {
    const developerId = developer(c); const body = await c.req.json() as { version?: string; rating?: number; comment?: string };
    if (!body.version || !Number.isInteger(body.rating) || body.rating! < 1 || body.rating! > 5) throw new Error("invalid review");
    const at = now(); const version = body.version; const rating = body.rating!;
    transaction(() => { db.prepare(`INSERT INTO extension_reviews(id,extensionId,version,developerId,rating,comment,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(extensionId,version,developerId) DO UPDATE SET rating=excluded.rating,comment=excluded.comment,updatedAt=excluded.updatedAt`).run(crypto.randomUUID(), c.req.param("id"), version, developerId, rating, String(body.comment || "").slice(0, 2_000), at, at); audit.append({ actorType: "developer", actorId: developerId, action: "review.upsert", targetType: "extension", targetId: c.req.param("id"), metadata: { version, rating }, ipAddress: resolveClientIp(c, config.trustedProxies) }); });
    return c.json({ success: true });
  } catch (error) { return c.json({ error: (error as Error).message }, 400); }
});
app.get("/v2/extensions/:id/reviews", (c) => c.json(db.prepare("SELECT version,rating,comment,createdAt,updatedAt FROM extension_reviews WHERE extensionId=? ORDER BY updatedAt DESC LIMIT 200").all(c.req.param("id"))));

app.post("/v2/extensions/:id/reports", async (c) => {
  try {
    const developerId = developer(c); const body = await c.req.json() as { version?: string; reason?: string; details?: string }; if (!body.reason) throw new Error("report reason is required");
    const id = crypto.randomUUID(); const at = now(); const reason = body.reason;
    transaction(() => { db.prepare("INSERT INTO extension_reports(id,extensionId,version,developerId,reason,details,status,createdAt,updatedAt) VALUES (?,?,?,?,?,?,'pending',?,?)").run(id, c.req.param("id"), body.version || null, developerId, reason, String(body.details || "").slice(0, 4_000), at, at); audit.append({ actorType: "developer", actorId: developerId, action: "report.create", targetType: "extension_report", targetId: id, metadata: { extensionId: c.req.param("id"), version: body.version, reason }, ipAddress: resolveClientIp(c, config.trustedProxies) }); });
    return c.json({ id }, 201);
  } catch (error) { return c.json({ error: (error as Error).message }, 400); }
});

app.post("/v2/telemetry", async (c) => {
  try { const body = await c.req.json() as { event?: string; extensionId?: string }; if (!body.event || !body.extensionId || !/^(install|update|uninstall|crash)$/.test(body.event) || !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(body.extensionId)) throw new Error("invalid telemetry"); const day = now().slice(0, 10); const event = body.event; const extensionId = body.extensionId; db.prepare(`INSERT INTO daily_extension_stats(day,extensionId,event,count) VALUES (?,?,?,1) ON CONFLICT(day,extensionId,event) DO UPDATE SET count=count+1`).run(day, extensionId, event); return c.json({ accepted: true, privacy: "aggregate-only" }, 202); }
  catch (error) { return c.json({ error: (error as Error).message }, 400); }
});

app.onError((error, c) => { safeLog("error", "registry.unhandled", { error: error.message, path: c.req.path }); return c.json({ error: "internal registry error" }, 500); });

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  serve({ fetch: app.fetch, port: config.port });
  safeLog("info", "registry.started", { port: config.port, environment: config.environment });
}

export default app;
