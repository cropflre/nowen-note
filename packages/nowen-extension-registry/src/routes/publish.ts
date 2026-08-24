import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Hono, type Context } from "hono";
import type { RegistryConfig } from "../config.js";
import { withImmediateTransaction } from "../db/transaction.js";
import type { ArtifactStore } from "../storage/artifactStore.js";
import type { AuditLog } from "../security/audit.js";
import { safeLog } from "../security/audit.js";
import { parseRegistryManifestV2 } from "../security/manifestV2.js";
import { REGISTRY_PACKAGE_LIMITS, validateRegistryPackage } from "../security/packageValidation.js";
import { assertPublisherKeyWindow, normalizePublisherKey } from "../security/publisherKeys.js";
import { type RateLimiter, resolveClientIp } from "../security/rateLimit.js";
import type { SessionService } from "../security/session.js";
import { canonicalJson } from "../security/signing.js";

interface PublishRouteDependencies {
  db: DatabaseSync;
  config: RegistryConfig;
  sessions: SessionService;
  limiter: RateLimiter;
  audit: AuditLog;
  artifactStore: ArtifactStore;
}

interface PublisherKeyRow {
  publicKey: string;
  state: string;
  validFrom: string;
  validUntil: string | null;
  revokedAt: string | null;
}

const publishLimits = {
  maxArtifactBytes: REGISTRY_PACKAGE_LIMITS.compressedBytes,
  cooldownSeconds: 60,
  dailyCount: 20,
  dailyBytes: 100 * 1024 * 1024,
};

export function createPublishRoutes(dependencies: PublishRouteDependencies): Hono {
  const { db, config, sessions, limiter, audit, artifactStore } = dependencies;
  const app = new Hono();

  app.post("/", async (c) => {
    let stagedKey: string | undefined;
    try {
      const contentType = c.req.header("content-type") || "";
      if (!/^multipart\/form-data(?:\s*;|$)/i.test(contentType)) return c.json({ error: "multipart/form-data is required" }, 415);
      const developerId = requireDeveloper(c, sessions, limiter);
      const form = await c.req.parseBody();
      const artifact = form.artifact;
      if (!(artifact instanceof File)) throw new Error("artifact is required");
      const multipartManifest = JSON.parse(String(form.manifest || "{}")) as unknown;
      const manifest = parseRegistryManifestV2(multipartManifest);
      const signed = JSON.parse(String(form.signature || "{}")) as Record<string, unknown>;
      requirePublisherMember(db, manifest.publisher, developerId);
      if (artifact.size <= 0 || artifact.size > REGISTRY_PACKAGE_LIMITS.compressedBytes) throw new Error("artifact must be between 1 byte and 20MB");
      const existing = db.prepare("SELECT publisherId,trustLevel FROM extensions WHERE id=?").get(manifest.id) as { publisherId: string; trustLevel: string } | undefined;
      if (existing && existing.publisherId !== manifest.publisher) throw new Error("existing extension belongs to a different publisher");
      if ((existing?.trustLevel || "community") === "community" && manifest.runtime !== "sandbox-js") throw new Error("Community extensions must use sandbox-js runtime");
      limiter.assertPublishAvailable(manifest.publisher, artifact.size, publishLimits);

      const bytes = Buffer.from(await artifact.arrayBuffer());
      const artifactDigest = crypto.createHash("sha256").update(bytes).digest("hex");
      if (signed.sha256 !== artifactDigest || typeof signed.keyId !== "string" || typeof signed.signature !== "string") {
        throw new Error("artifact checksum or signature envelope is invalid");
      }
      const publisherKeyId = signed.keyId;
      const publisherSignature = signed.signature;
      const key = db.prepare(`SELECT publicKey,state,validFrom,validUntil,revokedAt FROM publisher_keys WHERE id=? AND publisherId=?`)
        .get(publisherKeyId, manifest.publisher) as PublisherKeyRow | undefined;
      if (!key || key.state !== "active" || key.revokedAt) throw new Error("publisher signing key is unavailable");
      assertPublisherKeyWindow(key, Date.now(), true);
      const publisherPublicKey = crypto.createPublicKey(normalizePublisherKey(key.publicKey));
      const digestBytes = Buffer.from(artifactDigest, "hex");
      if (!crypto.verify(null, digestBytes, publisherPublicKey, Buffer.from(publisherSignature, "base64"))) throw new Error("publisher signature invalid");
      if (db.prepare("SELECT 1 FROM extension_versions WHERE extensionId=? AND version=?").get(manifest.id, manifest.version)) throw new Error("immutable version already exists");

      const validated = await validateRegistryPackage(bytes);
      if (canonicalJson(multipartManifest) !== canonicalJson(validated.embeddedManifest)) throw new Error("multipart manifest must exactly match embedded manifest.json");
      const mainFile = validated.zip.file(validated.manifest.main);
      if (!mainFile) throw new Error("manifest main entry is missing from artifact");
      const source = await mainFile.async("string");
      const findings = ["child_process", "process.env", "require(", "node:fs"].filter((needle) => source.includes(needle));
      if (manifest.runtime === "sandbox-js" && findings.length) throw new Error(`sandbox static scan rejected: ${findings.join(",")}`);
      limiter.consumePublish(manifest.publisher, bytes.length, publishLimits);

      const operationId = crypto.randomUUID();
      stagedKey = await artifactStore.stage(operationId, bytes);
      const artifactKey = await artifactStore.commit(stagedKey, artifactDigest);
      stagedKey = undefined;
      const at = new Date().toISOString();
      withImmediateTransaction(db, () => {
        const extensionChange = db.prepare(`INSERT INTO extensions(id,publisherId,name,description,repository,license,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,repository=excluded.repository,license=excluded.license,updatedAt=excluded.updatedAt
          WHERE extensions.publisherId=excluded.publisherId`).run(manifest.id, manifest.publisher, manifest.name, manifest.description || "", manifest.repository, manifest.license, at, at);
        if (extensionChange.changes !== 1) throw new Error("existing extension belongs to a different publisher");
        const object = db.prepare("SELECT storageKey,sizeBytes,state FROM artifact_objects WHERE sha256=?").get(artifactDigest) as { storageKey: string; sizeBytes: number; state: string } | undefined;
        if (object && (object.storageKey !== artifactKey || object.sizeBytes !== bytes.length || object.state !== "committed")) {
          throw new Error("artifact object metadata conflicts with immutable content");
        }
        if (!object) db.prepare(`INSERT INTO artifact_objects(sha256,storageKey,sizeBytes,state,createdAt,committedAt) VALUES (?,?,?,'committed',?,?)`)
          .run(artifactDigest, artifactKey, bytes.length, at, at);
        db.prepare(`INSERT INTO extension_versions(extensionId,version,apiVersion,runtime,manifestJson,artifactKey,sha256,sizeBytes,publisherKeyId,signature,scanState,scanReportJson,publishedAt)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          manifest.id, manifest.version, 2, manifest.runtime, JSON.stringify(validated.manifest), artifactKey, artifactDigest, bytes.length,
          publisherKeyId, publisherSignature, "passed", JSON.stringify({ files: validated.names.length, extractedBytes: validated.extractedBytes, staticFindings: findings }), at,
        );
        audit.append({
          actorType: "developer",
          actorId: developerId,
          action: "extension.publish",
          targetType: "extension_version",
          targetId: `${manifest.id}@${manifest.version}`,
          metadata: { publisherId: manifest.publisher, sha256: artifactDigest, sizeBytes: bytes.length, artifactKey },
          ipAddress: resolveClientIp(c, config.trustedProxies),
        });
      });
      return c.json({ extensionId: manifest.id, version: manifest.version, sha256: artifactDigest, scan: "passed" }, 201);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    } finally {
      if (stagedKey) {
        await artifactStore.removeStaged(stagedKey).catch((error) => safeLog("warn", "registry.artifact_stage_cleanup_failed", { error: (error as Error).message }));
      }
    }
  });

  return app;
}

function requireDeveloper(c: Context, sessions: SessionService, limiter: RateLimiter): string {
  const identity = sessions.authenticate(c);
  if (!identity.developerId) throw new Error("developer session required");
  if (!limiter.consume("account", identity.developerId)) throw new Error("account rate limit exceeded");
  return identity.developerId;
}

function requirePublisherMember(db: DatabaseSync, publisherId: string, developerId: string): void {
  const membership = db.prepare("SELECT 1 FROM publisher_members WHERE publisherId=? AND developerId=? AND role IN ('owner','admin')").get(publisherId, developerId);
  if (!membership) throw new Error("publisher access denied");
}
