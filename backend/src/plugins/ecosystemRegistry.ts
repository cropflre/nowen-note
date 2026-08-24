import crypto from "node:crypto";
import { getDb } from "../db/schema.js";
import { nowenVersionSatisfies } from "./manifest.js";
import {
  OFFICIAL_REGISTRY_TRUST_ROOTS,
  officialTrustRootsFor,
  RESERVED_OFFICIAL_REGISTRY_SOURCE_IDS,
} from "./officialRegistryTrustRoots.js";
import { PACKAGE_LIMITS } from "./packageValidator.js";
import { safeRegistryFetch } from "./communityRegistry.js";
import { RegistryMetadataGuard, type GuardedRegistryDocument } from "./registryMetadataGuard.js";
import { RegistryTrust, type RegistryRootRotation } from "./registryTrust.js";
import { SecurityAdvisoryService, type SecurityAdvisory } from "./securityAdvisoryService.js";
import { isEd25519PublicKey, verifyArtifactSignature } from "./signatures.js";
import type { PluginTrustLevel } from "./types.js";

export interface EcosystemSource { id: string; name: string; indexUrl: string; official: boolean; enabled: boolean; registryKeyId: string | null; registryPublicKey: string | null }
export interface EcosystemVersion { version: string; apiVersion: 2; runtime: "sandbox-js" | "node-action"; artifactUrl: string; sha256: string; publisherKeyId: string; signature: string; nowen: string; permissions: string[]; permissionConfig?: { externalFetchHosts?: string[] }; platforms?: string[]; runtimePlatform?: string[]; uiPlatform?: string[]; channel?: string; publishedAt?: string }
export interface EcosystemExtension { id: string; publisher: string; name: string; description?: string; trustLevel?: PluginTrustLevel; versions: EcosystemVersion[] }
export interface EcosystemIndex extends GuardedRegistryDocument {
  protocolVersion: 2;
  rootRotations?: RegistryRootRotation[];
  publishers: Array<{ publisher: string; keyId: string; publicKey: string; state: "active" | "revoked"; validFrom?: string; validUntil?: string }>;
  extensions: EcosystemExtension[];
  advisories?: SecurityAdvisory[];
}

function sha256(bytes: Buffer): string { return crypto.createHash("sha256").update(bytes).digest("hex"); }

export class EcosystemRegistry {
  readonly advisories = new SecurityAdvisoryService();
  private readonly trust = new RegistryTrust();
  private readonly metadataGuard = new RegistryMetadataGuard();

  listSources(): EcosystemSource[] {
    const official = new Map<string, EcosystemSource>();
    for (const root of OFFICIAL_REGISTRY_TRUST_ROOTS) {
      if (!official.has(root.sourceId)) official.set(root.sourceId, {
        id: root.sourceId,
        name: root.sourceName,
        indexUrl: root.indexUrl,
        official: true,
        enabled: true,
        registryKeyId: null,
        registryPublicKey: null,
      });
    }
    const custom = (getDb().prepare("SELECT * FROM plugin_sources ORDER BY name").all() as any[])
      .filter((row) => !Boolean(row.official) && !RESERVED_OFFICIAL_REGISTRY_SOURCE_IDS.has(row.id))
      .map((row) => ({ ...row, official: false, enabled: Boolean(row.enabled) } as EcosystemSource));
    return [...official.values(), ...custom];
  }

  upsertSource(source: Omit<EcosystemSource, "enabled" | "official"> & { enabled?: boolean; official?: boolean }): EcosystemSource[] {
    if (source.official || RESERVED_OFFICIAL_REGISTRY_SOURCE_IDS.has(source.id)) {
      throw Object.assign(new Error("Official Registry 配置与公钥只能随客户端编译发布"), { code: "OFFICIAL_REGISTRY_OVERRIDE_DENIED" });
    }
    if (!/^https:\/\//.test(source.indexUrl) || !source.registryKeyId || !source.registryPublicKey || !isEd25519PublicKey(source.registryPublicKey)) {
      throw Object.assign(new Error("Custom Registry 必须配置 HTTPS 与管理员 pinned Ed25519 公钥"), { code: "CUSTOM_REGISTRY_PIN_REQUIRED" });
    }
    const at = new Date().toISOString();
    const db = getDb();
    const existing = db.prepare("SELECT registryKeyId,registryPublicKey,official FROM plugin_sources WHERE id=?").get(source.id) as {
      registryKeyId: string | null; registryPublicKey: string | null; official: number;
    } | undefined;
    if (existing?.official) throw Object.assign(new Error("Official Registry 配置不可由 API 修改"), { code: "OFFICIAL_REGISTRY_OVERRIDE_DENIED" });
    db.transaction(() => {
      if (existing && (existing.registryKeyId !== source.registryKeyId || existing.registryPublicKey !== source.registryPublicKey)) {
        // 管理员显式重新 pin 时丢弃旧信任链和旧签名缓存，避免跨根继承信任。
        this.advisories.resetSource(source.id, at);
        db.prepare("DELETE FROM plugin_registry_metadata_state WHERE sourceId=?").run(source.id);
        db.prepare("DELETE FROM plugin_registry_root_chain WHERE sourceId=?").run(source.id);
        db.prepare("DELETE FROM plugin_trust_records WHERE sourceId=?").run(source.id);
        db.prepare("DELETE FROM marketplace_cache WHERE sourceId=?").run(source.id);
      }
      db.prepare(`INSERT INTO plugin_sources(id,name,indexUrl,official,enabled,registryKeyId,registryPublicKey,createdAt,updatedAt)
        VALUES (?,?,?,0,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,indexUrl=excluded.indexUrl,
        official=0,enabled=excluded.enabled,registryKeyId=excluded.registryKeyId,registryPublicKey=excluded.registryPublicKey,updatedAt=excluded.updatedAt`)
        .run(source.id, source.name, source.indexUrl, source.enabled === false ? 0 : 1, source.registryKeyId, source.registryPublicKey, at, at);
    })();
    return this.listSources();
  }

  async index(sourceId: string): Promise<EcosystemIndex> {
    if (RESERVED_OFFICIAL_REGISTRY_SOURCE_IDS.has(sourceId) && officialTrustRootsFor(sourceId).length === 0) {
      throw Object.assign(new Error("Official Registry 未编译信任根，已安全禁用"), { code: "OFFICIAL_REGISTRY_TRUST_ROOT_MISSING" });
    }
    const source = this.listSources().find((item) => item.id === sourceId && item.enabled);
    if (!source) throw Object.assign(new Error("V2 Registry Source 不存在或已禁用"), { code: "REGISTRY_SOURCE_NOT_FOUND" });
    this.trust.assertSourceConfigured(source);
    const parsed = JSON.parse((await safeRegistryFetch(source.indexUrl, 4 * 1024 * 1024)).toString("utf8")) as EcosystemIndex;
    if (parsed.protocolVersion !== 2 || !Array.isArray(parsed.publishers) || !Array.isArray(parsed.extensions)
      || parsed.rootRotations !== undefined && !Array.isArray(parsed.rootRotations)
      || parsed.advisories !== undefined && !Array.isArray(parsed.advisories)) {
      throw Object.assign(new Error("V2 Registry 元数据结构无效"), { code: "REGISTRY_METADATA_INVALID" });
    }
    const trust = this.trust.resolve(source, parsed.signerKeyId, parsed.rootRotations || []);
    const verifiedMetadata = this.metadataGuard.validate(sourceId, parsed, trust.signer.publicKey);
    const extensionIds = new Set<string>();
    for (const extension of parsed.extensions) {
      if (extensionIds.has(extension.id) || !extension.id.startsWith(`${extension.publisher}.`)) throw Object.assign(new Error("Registry extension namespace 或 ID 重复"), { code: "REGISTRY_METADATA_INVALID" });
      extensionIds.add(extension.id); const versions = new Set<string>();
      for (const version of extension.versions) {
        if (versions.has(version.version) || !/^[a-f0-9]{64}$/.test(version.sha256) || !version.signature) throw Object.assign(new Error("Registry version 元数据无效或重复"), { code: "REGISTRY_METADATA_INVALID" });
        versions.add(version.version);
      }
      const previous = getDb().prepare("SELECT metadataJson FROM marketplace_cache WHERE sourceId=? AND extensionId=?").get(sourceId, extension.id) as { metadataJson: string } | undefined;
      if (previous) {
        const old = JSON.parse(previous.metadataJson) as EcosystemExtension;
        for (const version of old.versions) {
          const replacement = extension.versions.find((item) => item.version === version.version);
          if (replacement && (replacement.sha256 !== version.sha256 || replacement.signature !== version.signature)) throw Object.assign(new Error(`Registry 试图覆盖不可变版本: ${extension.id}@${version.version}`), { code: "REGISTRY_IMMUTABILITY_VIOLATION" });
        }
      }
    }
    const now = new Date().toISOString();
    const db = getDb();
    db.transaction(() => {
      // fetch 与写入之间可能有并发刷新，必须在同一事务内重新执行防降级检查。
      this.metadataGuard.assertCurrent(verifiedMetadata);
      if (source.official) {
        db.prepare(`INSERT INTO plugin_sources(id,name,indexUrl,official,enabled,registryKeyId,registryPublicKey,createdAt,updatedAt)
          VALUES (?,?,?,1,1,NULL,NULL,?,?)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name,indexUrl=excluded.indexUrl,official=1,enabled=1,
          registryKeyId=NULL,registryPublicKey=NULL,updatedAt=excluded.updatedAt`)
          .run(source.id, source.name, source.indexUrl, now, now);
      }
      this.trust.persist(sourceId, trust, now);
      this.metadataGuard.persist(verifiedMetadata, now);
      const putExtension = db.prepare(`INSERT INTO marketplace_cache(sourceId,extensionId,metadataJson,fetchedAt) VALUES (?,?,?,?)
        ON CONFLICT(sourceId,extensionId) DO UPDATE SET metadataJson=excluded.metadataJson,fetchedAt=excluded.fetchedAt`);
      for (const extension of parsed.extensions) putExtension.run(sourceId, extension.id, JSON.stringify(extension), now);
      const putKey = db.prepare(`INSERT INTO plugin_trust_records(sourceId,publisher,keyId,publicKey,state,validFrom,validUntil,revokedAt,updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(sourceId,keyId) DO UPDATE SET publisher=excluded.publisher,publicKey=excluded.publicKey,state=excluded.state,validFrom=excluded.validFrom,validUntil=excluded.validUntil,revokedAt=excluded.revokedAt,updatedAt=excluded.updatedAt`);
      for (const key of parsed.publishers) putKey.run(sourceId, key.publisher, key.keyId, key.publicKey, key.state,
        key.validFrom || null, key.validUntil || null, key.state === "revoked" ? now : null, now);
    })();
    this.metadataGuard.assertCurrent(verifiedMetadata);
    this.advisories.apply(sourceId, parsed.advisories || [], [trust.signer]);
    return parsed;
  }

  async download(sourceId: string, extensionId: string, requestedVersion?: string): Promise<{ bytes: Buffer; extension: EcosystemExtension; version: EcosystemVersion }> {
    const index = await this.index(sourceId);
    const extension = index.extensions.find((item) => item.id === extensionId);
    if (!extension) throw Object.assign(new Error("Registry 中不存在该插件"), { code: "REGISTRY_PLUGIN_NOT_FOUND" });
    const versions = [...extension.versions].sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
    const version = versions.find((item) => item.version === requestedVersion) || (!requestedVersion ? versions[0] : undefined);
    if (!version) throw Object.assign(new Error("插件版本不存在"), { code: "PLUGIN_INCOMPATIBLE" });
    const platform = process.env.ELECTRON_USER_DATA ? "desktop-full" : "server";
    const runtimePlatforms = version.runtimePlatform || version.platforms;
    if (!nowenVersionSatisfies(version.nowen) || runtimePlatforms?.length && !runtimePlatforms.includes(platform)) throw Object.assign(new Error("插件与当前 Nowen/Runtime 平台不兼容"), { code: "PLUGIN_INCOMPATIBLE" });
    const key = index.publishers.find((item) => item.publisher === extension.publisher && item.keyId === version.publisherKeyId);
    const time = Date.now();
    if (!key || key.state !== "active" || key.validFrom && Date.parse(key.validFrom) > time || key.validUntil && Date.parse(key.validUntil) < time) throw Object.assign(new Error("Publisher 签名密钥不可用或已撤销"), { code: "PUBLISHER_KEY_REVOKED" });
    const bytes = await safeRegistryFetch(version.artifactUrl, PACKAGE_LIMITS.compressedBytes);
    if (sha256(bytes) !== version.sha256.toLowerCase()) throw Object.assign(new Error("插件 SHA256 不匹配"), { code: "REGISTRY_CHECKSUM_MISMATCH" });
    if (!verifyArtifactSignature(bytes, version.signature, key.publicKey)) throw Object.assign(new Error("插件 Publisher 签名无效"), { code: "PLUGIN_SIGNATURE_INVALID" });
    return { bytes, extension, version };
  }
}
