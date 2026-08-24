import { getDb } from "../db/schema.js";
import { documentDigest, verifySignedDocument } from "./signatures.js";

export interface GuardedRegistryDocument extends Record<string, unknown> {
  sequence: number;
  generatedAt: string;
  expiresAt: string;
  signerKeyId: string;
  signature: string;
}

export interface VerifiedRegistryMetadata {
  sourceId: string;
  sequence: number;
  digest: string;
  generatedAt: string;
  expiresAt: string;
  signerKeyId: string;
  documentJson: string;
}

const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

export class RegistryMetadataGuard {
  validate(
    sourceId: string,
    document: GuardedRegistryDocument,
    signerPublicKey: string,
    now = Date.now(),
  ): VerifiedRegistryMetadata {
    if (!Number.isSafeInteger(document.sequence) || document.sequence < 0
      || typeof document.generatedAt !== "string" || !Number.isFinite(Date.parse(document.generatedAt))
      || typeof document.expiresAt !== "string" || !Number.isFinite(Date.parse(document.expiresAt))
      || typeof document.signerKeyId !== "string" || !document.signerKeyId
      || typeof document.signature !== "string" || !document.signature) {
      throw codedError("Registry 元数据缺少 sequence/generatedAt/expiresAt/signerKeyId/signature", "REGISTRY_METADATA_INVALID");
    }
    const generatedAt = Date.parse(document.generatedAt);
    const expiresAt = Date.parse(document.expiresAt);
    if (generatedAt > now + MAX_FUTURE_SKEW_MS) {
      throw codedError("Registry 元数据生成时间异常超前", "REGISTRY_METADATA_FROM_FUTURE");
    }
    if (expiresAt <= now || expiresAt <= generatedAt) {
      throw codedError("Registry 元数据已过期或有效期无效", "REGISTRY_METADATA_EXPIRED");
    }
    if (!verifySignedDocument(document, document.signature, signerPublicKey)) {
      throw codedError("V2 Registry 元数据签名无效", "REGISTRY_SIGNATURE_INVALID");
    }

    const digest = documentDigest(document);
    this.assertSequenceAndDigest(sourceId, document.sequence, digest);
    return {
      sourceId,
      sequence: document.sequence,
      digest,
      generatedAt: document.generatedAt,
      expiresAt: document.expiresAt,
      signerKeyId: document.signerKeyId,
      documentJson: JSON.stringify(document),
    };
  }

  persist(metadata: VerifiedRegistryMetadata, verifiedAt = new Date().toISOString()): void {
    this.assertCurrent(metadata);
    getDb().prepare(`INSERT INTO plugin_registry_metadata_state(
      sourceId,highestSeenSequence,documentDigest,generatedAt,expiresAt,verifiedAt,signerKeyId,documentJson
    ) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(sourceId) DO UPDATE SET
      highestSeenSequence=excluded.highestSeenSequence,documentDigest=excluded.documentDigest,
      generatedAt=excluded.generatedAt,expiresAt=excluded.expiresAt,verifiedAt=excluded.verifiedAt,
      signerKeyId=excluded.signerKeyId,documentJson=excluded.documentJson
    WHERE excluded.highestSeenSequence >= plugin_registry_metadata_state.highestSeenSequence`)
      .run(metadata.sourceId, metadata.sequence, metadata.digest, metadata.generatedAt, metadata.expiresAt,
        verifiedAt, metadata.signerKeyId, metadata.documentJson);
  }

  assertCurrent(metadata: Pick<VerifiedRegistryMetadata, "sourceId" | "sequence" | "digest">): void {
    this.assertSequenceAndDigest(metadata.sourceId, metadata.sequence, metadata.digest);
  }

  private assertSequenceAndDigest(sourceId: string, sequence: number, digest: string): void {
    const previous = getDb().prepare(`SELECT highestSeenSequence,documentDigest FROM plugin_registry_metadata_state WHERE sourceId=?`)
      .get(sourceId) as { highestSeenSequence: number; documentDigest: string } | undefined;
    if (previous && sequence < previous.highestSeenSequence) {
      throw codedError("Registry 元数据 sequence 回退", "REGISTRY_METADATA_ROLLBACK");
    }
    if (previous && sequence === previous.highestSeenSequence && digest !== previous.documentDigest) {
      throw codedError("Registry 元数据同 sequence 内容发生变化", "REGISTRY_METADATA_EQUIVOCATION");
    }
  }
}
