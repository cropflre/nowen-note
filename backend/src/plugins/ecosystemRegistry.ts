import crypto from "node:crypto";
import { getDb } from "../db/schema.js";
import { nowenVersionSatisfies } from "./manifest.js";
import { PACKAGE_LIMITS } from "./packageValidator.js";
import { safeRegistryFetch } from "./communityRegistry.js";
import { verifyArtifactSignature, verifySignedDocument } from "./signatures.js";
import type { PluginTrustLevel } from "./types.js";

export interface EcosystemSource { id: string; name: string; indexUrl: string; official: boolean; enabled: boolean; registryKeyId: string; registryPublicKey: string }
export interface EcosystemVersion { version: string; apiVersion: 2; runtime: "sandbox-js" | "node-action"; artifactUrl: string; sha256: string; publisherKeyId: string; signature: string; nowen: string; permissions: string[]; permissionConfig?: { externalFetchHosts?: string[] }; platforms?: string[]; runtimePlatform?: string[]; uiPlatform?: string[]; channel?: string; publishedAt?: string }
export interface EcosystemExtension { id: string; publisher: string; name: string; description?: string; trustLevel?: PluginTrustLevel; versions: EcosystemVersion[] }
export interface EcosystemIndex { protocolVersion: 2; generatedAt: string; publishers: Array<{ publisher: string; keyId: string; publicKey: string; state: "active" | "revoked"; validFrom?: string; validUntil?: string }>; extensions: EcosystemExtension[]; advisories?: Array<{ id: string; extensionId: string; versions: string[]; state: "vulnerable" | "revoked" | "malicious"; severity: string; title: string; action?: "warn" | "disable" }>; signature: string }

function sha256(bytes: Buffer): string { return crypto.createHash("sha256").update(bytes).digest("hex"); }

export class EcosystemRegistry {
  listSources(): EcosystemSource[] {
    return (getDb().prepare("SELECT * FROM plugin_sources ORDER BY official DESC,name").all() as any[]).map((row) => ({ ...row, official: Boolean(row.official), enabled: Boolean(row.enabled) }));
  }

  upsertSource(source: Omit<EcosystemSource, "enabled"> & { enabled?: boolean }): EcosystemSource[] {
    if (!/^https:\/\//.test(source.indexUrl) || !source.registryPublicKey.includes("PUBLIC KEY")) throw new Error("V2 Registry 必须配置 HTTPS 与 Ed25519 公钥");
    const at = new Date().toISOString();
    getDb().prepare(`INSERT INTO plugin_sources(id,name,indexUrl,official,enabled,registryKeyId,registryPublicKey,createdAt,updatedAt)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,indexUrl=excluded.indexUrl,official=excluded.official,enabled=excluded.enabled,registryKeyId=excluded.registryKeyId,registryPublicKey=excluded.registryPublicKey,updatedAt=excluded.updatedAt`)
      .run(source.id, source.name, source.indexUrl, source.official ? 1 : 0, source.enabled === false ? 0 : 1, source.registryKeyId, source.registryPublicKey, at, at);
    return this.listSources();
  }

  async index(sourceId: string): Promise<EcosystemIndex> {
    const source = this.listSources().find((item) => item.id === sourceId && item.enabled);
    if (!source) throw Object.assign(new Error("V2 Registry Source 不存在或已禁用"), { code: "REGISTRY_SOURCE_NOT_FOUND" });
    const parsed = JSON.parse((await safeRegistryFetch(source.indexUrl, 4 * 1024 * 1024)).toString("utf8")) as EcosystemIndex;
    if (parsed.protocolVersion !== 2 || !Array.isArray(parsed.publishers) || !Array.isArray(parsed.extensions) || !parsed.signature || !verifySignedDocument(parsed as any, parsed.signature, source.registryPublicKey)) {
      throw Object.assign(new Error("V2 Registry 元数据签名无效"), { code: "REGISTRY_SIGNATURE_INVALID" });
    }
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
      getDb().prepare(`INSERT INTO marketplace_cache(sourceId,extensionId,metadataJson,fetchedAt) VALUES (?,?,?,?)
        ON CONFLICT(sourceId,extensionId) DO UPDATE SET metadataJson=excluded.metadataJson,fetchedAt=excluded.fetchedAt`).run(sourceId, extension.id, JSON.stringify(extension), new Date().toISOString());
    }
    const now = Date.now();
    const db = getDb();
    const putKey = db.prepare(`INSERT INTO plugin_trust_records(sourceId,publisher,keyId,publicKey,state,validFrom,validUntil,revokedAt,updatedAt)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(sourceId,keyId) DO UPDATE SET publisher=excluded.publisher,publicKey=excluded.publicKey,state=excluded.state,validFrom=excluded.validFrom,validUntil=excluded.validUntil,revokedAt=excluded.revokedAt,updatedAt=excluded.updatedAt`);
    for (const key of parsed.publishers) putKey.run(sourceId, key.publisher, key.keyId, key.publicKey, key.state, key.validFrom || null, key.validUntil || null, key.state === "revoked" ? new Date().toISOString() : null, new Date().toISOString());
    for (const advisory of parsed.advisories || []) for (const version of advisory.versions) db.prepare(`INSERT INTO plugin_security_state(pluginId,version,state,severity,advisoryId,title,action,checkedAt)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(pluginId,version) DO UPDATE SET state=excluded.state,severity=excluded.severity,advisoryId=excluded.advisoryId,title=excluded.title,action=excluded.action,checkedAt=excluded.checkedAt`)
      .run(advisory.extensionId, version, advisory.state, advisory.severity, advisory.id, advisory.title, advisory.action || "warn", new Date(now).toISOString());
    db.prepare(`UPDATE plugin_registry SET status='disabled',advisoryState=(SELECT state FROM plugin_security_state WHERE pluginId=plugin_registry.id AND version=plugin_registry.version),lastError='安全公告已自动禁用该版本',updatedAt=?
      WHERE EXISTS (SELECT 1 FROM plugin_security_state WHERE pluginId=plugin_registry.id AND version=plugin_registry.version AND state IN ('revoked','malicious') AND action='disable')`).run(new Date().toISOString());
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
