import { getDb } from "../db/schema.js";
import {
  officialTrustRootsFor,
  type OfficialRegistryTrustRoot,
} from "./officialRegistryTrustRoots.js";
import { documentDigest, isEd25519PublicKey, verifySignedDocument } from "./signatures.js";

export interface RegistryTrustSource {
  id: string;
  official: boolean;
  registryKeyId: string | null;
  registryPublicKey: string | null;
}

export interface RegistryRootRotation extends Record<string, unknown> {
  keyId: string;
  parentKeyId: string;
  sequence: number;
  algorithm: "Ed25519";
  publicKey: string;
  validFrom: string;
  validUntil: string;
  signature: string;
}

export interface TrustedRegistryKey {
  keyId: string;
  sequence: number;
  publicKey: string;
  validFrom: string;
  validUntil: string;
  parentKeyId: string | null;
  signature: string | null;
  documentJson: string;
}

export interface RegistryTrustResolution {
  signer: TrustedRegistryKey;
  chain: TrustedRegistryKey[];
}

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function validTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function rootFromOfficial(root: OfficialRegistryTrustRoot): TrustedRegistryKey {
  return {
    keyId: root.keyId,
    sequence: root.sequence,
    publicKey: root.publicKey,
    validFrom: root.validFrom,
    validUntil: root.validUntil,
    parentKeyId: null,
    signature: null,
    documentJson: JSON.stringify(root),
  };
}

function assertRootFormat(root: TrustedRegistryKey): void {
  if (!isEd25519PublicKey(root.publicKey)) {
    throw codedError(`Registry 根公钥不是 Ed25519: ${root.keyId}`, "REGISTRY_TRUST_ROOT_INVALID");
  }
  const validFrom = Date.parse(root.validFrom);
  const validUntil = Date.parse(root.validUntil);
  if (!Number.isFinite(validFrom) || !Number.isFinite(validUntil) || validUntil <= validFrom) {
    throw codedError(`Registry 根有效期无效: ${root.keyId}`, "REGISTRY_TRUST_ROOT_INVALID");
  }
}

function assertActiveRoot(root: TrustedRegistryKey, now: number): void {
  assertRootFormat(root);
  if (Date.parse(root.validFrom) > now + MAX_CLOCK_SKEW_MS || Date.parse(root.validUntil) <= now) {
    throw codedError(`Registry 根不在有效期内: ${root.keyId}`, "REGISTRY_TRUST_ROOT_EXPIRED");
  }
}

function validateRotation(rotation: RegistryRootRotation, parent: TrustedRegistryKey, now: number): TrustedRegistryKey {
  if (!rotation || typeof rotation !== "object"
    || typeof rotation.keyId !== "string" || !rotation.keyId
    || typeof rotation.parentKeyId !== "string" || rotation.parentKeyId !== parent.keyId
    || !Number.isSafeInteger(rotation.sequence) || rotation.sequence <= parent.sequence
    || rotation.algorithm !== "Ed25519"
    || !isEd25519PublicKey(rotation.publicKey)
    || !validTime(rotation.validFrom) || !validTime(rotation.validUntil)
    || Date.parse(rotation.validFrom) > now + MAX_CLOCK_SKEW_MS
    || Date.parse(rotation.validUntil) <= Date.parse(rotation.validFrom)
    || Date.parse(rotation.validFrom) < Date.parse(parent.validFrom)
    || Date.parse(rotation.validFrom) > Date.parse(parent.validUntil)
    || typeof rotation.signature !== "string" || !rotation.signature
    || !verifySignedDocument(rotation, rotation.signature, parent.publicKey)) {
    throw codedError("Registry 根轮换信封无效", "REGISTRY_ROOT_ROTATION_INVALID");
  }
  return {
    keyId: rotation.keyId,
    sequence: rotation.sequence,
    publicKey: rotation.publicKey,
    validFrom: rotation.validFrom,
    validUntil: rotation.validUntil,
    parentKeyId: rotation.parentKeyId,
    signature: rotation.signature,
    documentJson: JSON.stringify(rotation),
  };
}

export class RegistryTrust {
  assertSourceConfigured(source: RegistryTrustSource): void {
    if (source.official) {
      const official = officialTrustRootsFor(source.id);
      if (official.length === 0) {
        throw codedError("Official Registry 未编译信任根，已安全禁用", "OFFICIAL_REGISTRY_TRUST_ROOT_MISSING");
      }
      for (const root of official.map(rootFromOfficial)) assertRootFormat(root);
      return;
    }
    if (!source.registryKeyId || !source.registryPublicKey || !isEd25519PublicKey(source.registryPublicKey)) {
      throw codedError("Custom Registry 必须配置管理员 pinned Ed25519 公钥", "CUSTOM_REGISTRY_PIN_REQUIRED");
    }
  }

  resolve(
    source: RegistryTrustSource,
    signerKeyId: string,
    rotations: RegistryRootRotation[] = [],
    now = Date.now(),
  ): RegistryTrustResolution {
    this.assertSourceConfigured(source);
    let anchors: TrustedRegistryKey[];
    if (source.official) {
      const official = officialTrustRootsFor(source.id);
      if (official.length === 0) {
        throw codedError("Official Registry 未编译信任根，已安全禁用", "OFFICIAL_REGISTRY_TRUST_ROOT_MISSING");
      }
      anchors = official.map(rootFromOfficial);
    } else {
      if (!source.registryKeyId || !source.registryPublicKey || !isEd25519PublicKey(source.registryPublicKey)) {
        throw codedError("Custom Registry 必须配置管理员 pinned Ed25519 公钥", "CUSTOM_REGISTRY_PIN_REQUIRED");
      }
      anchors = [{
        keyId: source.registryKeyId,
        sequence: 0,
        publicKey: source.registryPublicKey,
        validFrom: "1970-01-01T00:00:00.000Z",
        validUntil: "9999-12-31T23:59:59.999Z",
        parentKeyId: null,
        signature: null,
        documentJson: JSON.stringify({ keyId: source.registryKeyId, algorithm: "Ed25519", publicKey: source.registryPublicKey }),
      }];
    }

    for (const anchor of anchors) assertRootFormat(anchor);
    const chain = [...anchors].sort((a, b) => a.sequence - b.sequence);
    let current = chain[chain.length - 1];

    const stored = getDb().prepare(`SELECT keyId,sequence,parentKeyId,publicKey,validFrom,validUntil,signature,documentJson
      FROM plugin_registry_root_chain WHERE sourceId=? AND parentKeyId IS NOT NULL ORDER BY sequence`).all(source.id) as Array<{
      keyId: string; sequence: number; parentKeyId: string; publicKey: string; validFrom: string;
      validUntil: string; signature: string; documentJson: string;
    }>;
    for (const row of stored) {
      if (row.sequence <= current.sequence) continue;
      let rotation: RegistryRootRotation;
      try { rotation = JSON.parse(row.documentJson) as RegistryRootRotation; }
      catch { throw codedError("已保存的 Registry 根链损坏", "REGISTRY_ROOT_CHAIN_CORRUPT"); }
      const accepted = validateRotation(rotation, current, now);
      if (accepted.keyId !== row.keyId || accepted.sequence !== row.sequence || accepted.publicKey !== row.publicKey) {
        throw codedError("已保存的 Registry 根链内容不一致", "REGISTRY_ROOT_CHAIN_CORRUPT");
      }
      chain.push(accepted);
      current = accepted;
    }

    const orderedRotations = [...rotations].sort((a, b) => a.sequence - b.sequence);
    for (const rotation of orderedRotations) {
      if (rotation.sequence <= current.sequence) {
        const known = chain.find((root) => root.sequence === rotation.sequence && root.keyId === rotation.keyId);
        if (!known || documentDigest(JSON.parse(known.documentJson) as Record<string, unknown>) !== documentDigest(rotation)) {
          throw codedError("Registry 根轮换发生回退或同序列变化", "REGISTRY_ROOT_ROTATION_ROLLBACK");
        }
        continue;
      }
      const accepted = validateRotation(rotation, current, now);
      if (chain.some((root) => root.keyId === accepted.keyId)) {
        throw codedError("Registry 根轮换复用了已有 key ID", "REGISTRY_ROOT_ROTATION_INVALID");
      }
      chain.push(accepted);
      current = accepted;
    }

    assertActiveRoot(current, now);
    if (current.keyId !== signerKeyId) {
      throw codedError("Registry 文档签名者不是当前 active root", "REGISTRY_SIGNER_NOT_ACTIVE");
    }
    return { signer: current, chain };
  }

  persist(sourceId: string, resolution: RegistryTrustResolution, now = new Date().toISOString()): void {
    const put = getDb().prepare(`INSERT INTO plugin_registry_root_chain(
      sourceId,keyId,sequence,parentKeyId,publicKey,state,validFrom,validUntil,signedByKeyId,signature,documentJson,verifiedAt,createdAt,updatedAt
    ) VALUES (?,?,?,?,?,'active',?,?,?,?,?,?,?,?)
    ON CONFLICT(sourceId,keyId) DO UPDATE SET
      sequence=excluded.sequence,parentKeyId=excluded.parentKeyId,publicKey=excluded.publicKey,
      state=excluded.state,validFrom=excluded.validFrom,validUntil=excluded.validUntil,
      signedByKeyId=excluded.signedByKeyId,signature=excluded.signature,documentJson=excluded.documentJson,
      verifiedAt=excluded.verifiedAt,updatedAt=excluded.updatedAt`);
    for (const root of resolution.chain) {
      put.run(sourceId, root.keyId, root.sequence, root.parentKeyId, root.publicKey,
        root.validFrom, root.validUntil, root.parentKeyId, root.signature, root.documentJson, now, now, now);
    }
    getDb().prepare("UPDATE plugin_registry_root_chain SET state='superseded',updatedAt=? WHERE sourceId=? AND keyId<>?")
      .run(now, sourceId, resolution.signer.keyId);
  }
}
