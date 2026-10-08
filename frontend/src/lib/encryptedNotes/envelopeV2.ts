import { ARGON2_PROFILE, EncryptedContentError, fromBase64, MAX_CONTENT_BYTES, validateEnvelope, validateIdentity, type EncryptedContentIdentity, type SealedBytes } from "./envelope";

export const ENCRYPTED_NOTE_V2_FORMAT = "encrypted-note-v2";
export const ENCRYPTED_BLOCK_V2_LANGUAGE = "nowen-encrypted-v2";
export type ContentIdentityV2 = EncryptedContentIdentity & {
  parentObjectId: string | null;
  documentSchemaVersion: 1;
  keyEpoch: number;
  encryptionEpoch: number;
};
export type ContentEnvelopeV2 = ContentIdentityV2 & {
  version: 2; algorithm: "AES-256-GCM";
  kdf: typeof ARGON2_PROFILE & { salt: string };
  wrappedKey: SealedBytes; payload: SealedBytes;
};

export function strictRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(value, key))) throw new EncryptedContentError("invalid");
  return value as Record<string, unknown>;
}
export function positiveEpoch(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new EncryptedContentError("invalid");
}
export function uuid(value: unknown): asserts value is string {
  if (typeof value !== "string") throw new EncryptedContentError("invalid");
  validateIdentity({ objectId: value, kind: "note", originalFormat: "markdown" });
}
export function validateIdentityV2(identity: ContentIdentityV2): void {
  validateIdentity(identity);
  if (identity.documentSchemaVersion !== 1) throw new EncryptedContentError("invalid");
  positiveEpoch(identity.keyEpoch); positiveEpoch(identity.encryptionEpoch);
  if (identity.kind === "note") { if (identity.parentObjectId !== null) throw new EncryptedContentError("invalid"); }
  else { uuid(identity.parentObjectId); if (identity.parentObjectId === identity.objectId) throw new EncryptedContentError("invalid"); }
}
export function identityV2(value: ContentIdentityV2): ContentIdentityV2 {
  validateIdentityV2(value);
  return { objectId: value.objectId, kind: value.kind, originalFormat: value.originalFormat, parentObjectId: value.parentObjectId,
    documentSchemaVersion: 1, keyEpoch: value.keyEpoch, encryptionEpoch: value.encryptionEpoch };
}
export function validateEnvelopeV2(value: unknown): ContentEnvelopeV2 {
  const record = strictRecord(value, ["version", "algorithm", "objectId", "kind", "originalFormat", "parentObjectId", "documentSchemaVersion", "keyEpoch", "encryptionEpoch", "kdf", "wrappedKey", "payload"]);
  if (record.version !== 2) throw new EncryptedContentError("invalid");
  // Reuse the exact bounded v1 KDF/sealed-byte validation without changing its wire format or AAD.
  const base = validateEnvelope({ version: 1, algorithm: record.algorithm, objectId: record.objectId, kind: record.kind,
    originalFormat: record.originalFormat, kdf: record.kdf, wrappedKey: record.wrappedKey, payload: record.payload });
  return { ...base, ...identityV2(record as ContentIdentityV2), version: 2 };
}
export function aadV2(identity: ContentIdentityV2, purpose: "root-key" | "document" | "history" | "file-key" | "file-chunk", context: readonly (string | number)[] = []): Uint8Array {
  validateIdentityV2(identity);
  return new TextEncoder().encode(JSON.stringify(["nowen-encrypted-content", 2, "AES-256-GCM", purpose,
    identity.objectId, identity.kind, identity.originalFormat, identity.parentObjectId, identity.documentSchemaVersion,
    identity.keyEpoch, identity.encryptionEpoch, ...context]));
}
export function matchIdentityV2(value: ContentIdentityV2, expected: ContentIdentityV2): void {
  if (JSON.stringify(identityV2(value)) !== JSON.stringify(identityV2(expected))) throw new EncryptedContentError("unlock-failed");
}
export function sealedBytes(value: unknown, max = MAX_CONTENT_BYTES + 16): SealedBytes {
  const record = strictRecord(value, ["iv", "ciphertext"]);
  fromBase64(record.iv, 12); fromBase64(record.ciphertext, 16, max);
  return { iv: record.iv as string, ciphertext: record.ciphertext as string };
}
