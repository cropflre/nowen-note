import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { loadRegistryConfig } from "./config.js";
import { withImmediateTransaction } from "./db/transaction.js";
import { createAdminRoutes } from "./routes/admin.js";
import { createHealthRoutes } from "./routes/health.js";
import { createOAuthRoutes } from "./routes/oauth.js";
import { openRegistry } from "./schema.js";
import { AuditLog, safeLog } from "./security/audit.js";
import { requireCookieWriteProtection } from "./security/csrf.js";
import { REGISTRY_PACKAGE_LIMITS, validateRegistryPackage } from "./security/packageValidation.js";
import { RateLimiter, rateLimitMiddleware, resolveClientIp } from "./security/rateLimit.js";
import { SessionService } from "./security/session.js";
import { canonicalJson, documentDigest, signDocument } from "./security/signing.js";

const config = loadRegistryConfig();
const artifactRoot = path.join(config.dataRoot, "artifacts");
fs.mkdirSync(artifactRoot, { recursive: true });
const db = openRegistry(path.join(config.dataRoot, "registry.db"));
const sessions = new SessionService(db, config.sessionSecret, config.sessionTtlSeconds);
const limiter = new RateLimiter(db);
const audit = new AuditLog(db);
const app = new Hono();
const now = () => new Date().toISOString();

const digest = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest();

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
  if (c.req.method === "OPTIONS") {
    c.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    c.header("Access-Control-Allow-Headers", "Content-Type,Authorization,X-CSRF-Token,X-TOTP-Code");
    return c.body(null, 204);
  }
  await next();
  safeLog("info", "registry.request", { requestId, method: c.req.method, path: c.req.path, status: c.res.status, durationMs: Date.now() - startedAt });
});
app.use("*", rateLimitMiddleware(limiter, config.trustedProxies));
app.use("*", requireCookieWriteProtection(config.allowedOrigins, sessions, (c) => sessions.authenticate(c)));

app.route("/health", createHealthRoutes(db, config));
app.route("/oauth", createOAuthRoutes(db, config, sessions, audit));
app.route("/v2/admin", createAdminRoutes(db, config, sessions, limiter, audit));

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
    if (!body.id || !body.publicKey) throw new Error("key id and public key are required");
    const keyId = body.id;
    const publicKey = body.publicKey;
    if (crypto.createPublicKey(publicKey).asymmetricKeyType !== "ed25519") throw new Error("publisher public key must be Ed25519");
    transaction(() => {
      db.prepare("INSERT INTO publisher_keys(id,publisherId,publicKey,validFrom,validUntil) VALUES (?,?,?,?,?)").run(keyId, publisherId, publicKey, now(), body.validUntil || null);
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

app.post("/v2/publish", async (c) => {
  try {
    const contentType = c.req.header("content-type") || "";
    if (!/^multipart\/form-data(?:\s*;|$)/i.test(contentType)) return c.json({ error: "multipart/form-data is required" }, 415);
    const contentLengthRaw = c.req.header("content-length");
    if (!contentLengthRaw) return c.json({ error: "Content-Length is required" }, 411);
    const contentLength = Number(contentLengthRaw);
    if (!Number.isSafeInteger(contentLength) || contentLength <= 0) return c.json({ error: "invalid Content-Length" }, 400);
    if (contentLength > REGISTRY_PACKAGE_LIMITS.multipartBytes) return c.json({ error: "multipart body exceeds 21MB" }, 413);
    const developerId = developer(c);
    const form = await c.req.parseBody();
    const artifact = form.artifact;
    if (!(artifact instanceof File)) throw new Error("artifact is required");
    const manifest = JSON.parse(String(form.manifest || "{}")) as Record<string, any>;
    const signed = JSON.parse(String(form.signature || "{}")) as Record<string, any>;
    if (typeof manifest.publisher !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(manifest.publisher)) throw new Error("invalid publisher id");
    member(manifest.publisher, developerId);
    if (manifest.apiVersion !== 2 || typeof manifest.id !== "string" || !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(manifest.id)
      || !manifest.id.startsWith(`${manifest.publisher}.`) || typeof manifest.version !== "string"
      || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version)
      || typeof manifest.main !== "string" || !/^[0-9A-Za-z._/-]+$/.test(manifest.main) || manifest.main.includes("..")
      || path.posix.isAbsolute(manifest.main) || !manifest.repository || !manifest.license
      || manifest.runtime !== "sandbox-js" && manifest.runtime !== "node-action") throw new Error("invalid V2 manifest");
    if (artifact.size <= 0 || artifact.size > REGISTRY_PACKAGE_LIMITS.compressedBytes) throw new Error("artifact must be between 1 byte and 20MB");
    const existing = db.prepare("SELECT publisherId,trustLevel FROM extensions WHERE id=?").get(manifest.id) as { publisherId: string; trustLevel: string } | undefined;
    if (existing && existing.publisherId !== manifest.publisher) throw new Error("existing extension belongs to a different publisher");
    const trustLevel = existing?.trustLevel || "community";
    if (trustLevel === "community" && manifest.runtime !== "sandbox-js") throw new Error("Community extensions must use sandbox-js runtime");
    const publishLimits = { maxArtifactBytes: REGISTRY_PACKAGE_LIMITS.compressedBytes, cooldownSeconds: 60, dailyCount: 20, dailyBytes: 100 * 1024 * 1024 };
    limiter.assertPublishAvailable(manifest.publisher, artifact.size, publishLimits);
    const bytes = Buffer.from(await artifact.arrayBuffer());
    const sha256 = digest(bytes).toString("hex");
    if (typeof signed.sha256 !== "string" || signed.sha256 !== sha256 || typeof signed.keyId !== "string" || typeof signed.signature !== "string") throw new Error("artifact checksum or signature envelope is invalid");
    const key = db.prepare("SELECT publicKey FROM publisher_keys WHERE id=? AND publisherId=? AND state='active' AND (validUntil IS NULL OR validUntil>?)").get(signed.keyId, manifest.publisher, now()) as { publicKey: string } | undefined;
    if (!key) throw new Error("publisher signing key is unavailable");
    const publisherPublicKey = crypto.createPublicKey(key.publicKey);
    if (publisherPublicKey.asymmetricKeyType !== "ed25519" || !crypto.verify(null, digest(bytes), publisherPublicKey, Buffer.from(signed.signature, "base64"))) throw new Error("publisher signature invalid");
    if (db.prepare("SELECT 1 FROM extension_versions WHERE extensionId=? AND version=?").get(manifest.id, manifest.version)) throw new Error("immutable version already exists");
    const validated = await validateRegistryPackage(bytes);
    if (canonicalJson(manifest) !== canonicalJson(validated.embeddedManifest)) throw new Error("multipart manifest must exactly match embedded manifest.json");
    const mainFile = validated.zip.file(manifest.main);
    if (!mainFile) throw new Error("manifest main entry is missing from artifact");
    const source = await mainFile.async("string");
    const findings = ["child_process", "process.env", "require(", "node:fs"].filter((needle) => source.includes(needle));
    if (manifest.runtime === "sandbox-js" && findings.length) throw new Error(`sandbox static scan rejected: ${findings.join(",")}`);
    limiter.consumePublish(manifest.publisher, bytes.length, publishLimits);
    const extensionDir = path.join(artifactRoot, manifest.id);
    fs.mkdirSync(extensionDir, { recursive: true });
    const artifactPath = path.join(extensionDir, `${manifest.version}.nowen-plugin`);
    fs.writeFileSync(artifactPath, bytes, { flag: "wx" });
    const artifactUrl = new URL(`/v2/artifacts/${manifest.id}/${manifest.version}`, config.publicUrl).toString();
    const at = now();
    transaction(() => {
      const extensionChange = db.prepare(`INSERT INTO extensions(id,publisherId,name,description,repository,license,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,repository=excluded.repository,license=excluded.license,updatedAt=excluded.updatedAt
        WHERE extensions.publisherId=excluded.publisherId`).run(manifest.id, manifest.publisher, manifest.name, manifest.description || "", manifest.repository, manifest.license, at, at);
      if (extensionChange.changes !== 1) throw new Error("existing extension belongs to a different publisher");
      db.prepare(`INSERT INTO extension_versions(extensionId,version,apiVersion,runtime,manifestJson,artifactPath,artifactUrl,sha256,publisherKeyId,signature,scanState,scanReportJson,publishedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(manifest.id, manifest.version, 2, manifest.runtime, JSON.stringify(validated.embeddedManifest), artifactPath, artifactUrl, sha256, signed.keyId, signed.signature, "passed", JSON.stringify({ files: validated.names.length, extractedBytes: validated.extractedBytes, staticFindings: findings }), at);
      audit.append({ actorType: "developer", actorId: developerId, action: "extension.publish", targetType: "extension_version", targetId: `${manifest.id}@${manifest.version}`, metadata: { publisherId: manifest.publisher, sha256, sizeBytes: bytes.length }, ipAddress: resolveClientIp(c, config.trustedProxies) });
    });
    return c.json({ extensionId: manifest.id, version: manifest.version, sha256, scan: "passed" }, 201);
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
    const publishers = db.prepare(`SELECT publisherId AS publisher,id AS keyId,publicKey,state,validFrom,validUntil
      FROM publisher_keys ORDER BY publisherId,id`).all();
    const extensionRows = db.prepare("SELECT * FROM extensions WHERE listed=1 ORDER BY id").all() as Array<Record<string, any>>;
    const extensions = extensionRows.map((extension) => ({
      id: extension.id,
      publisher: extension.publisherId,
      name: extension.name,
      description: extension.description,
      trustLevel: extension.trustLevel,
      versions: (db.prepare(`SELECT version,apiVersion,runtime,artifactUrl,sha256,publisherKeyId,signature,publishedAt,manifestJson
        FROM extension_versions WHERE extensionId=? ORDER BY publishedAt DESC,version DESC`).all(extension.id) as Array<Record<string, any>>)
        .map(({ manifestJson, ...version }) => {
          const manifest = JSON.parse(manifestJson);
          return { ...version, nowen: manifest.engines.nowen, permissions: manifest.permissions, permissionConfig: manifest.permissionConfig, platforms: manifest.platforms, runtimePlatform: manifest.runtimePlatform, uiPlatform: manifest.uiPlatform };
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
    const content = { protocolVersion: 2, sequence: sequenceRow.sequence, generatedAt, expiresAt, signerKeyId: config.signerKeyId, publishers, extensions, advisories };
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
app.get("/v2/artifacts/:id/:version", (c) => { const row = db.prepare("SELECT artifactPath FROM extension_versions WHERE extensionId=? AND version=?").get(c.req.param("id"), c.req.param("version")) as { artifactPath: string } | undefined; if (!row) return c.json({ error: "not found" }, 404); return new Response(fs.readFileSync(row.artifactPath), { headers: { "Content-Type": "application/zip", "Cache-Control": "public,max-age=31536000,immutable" } }); });

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
