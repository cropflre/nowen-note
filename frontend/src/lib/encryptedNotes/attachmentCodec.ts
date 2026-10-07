import { importKey, open, randomBytes, seal } from "./crypto";
import { EncryptedContentError, fromBase64, toBase64, type SealedBytes } from "./envelope";
import { aadV2, identityV2, positiveEpoch, sealedBytes, strictRecord, uuid, type ContentIdentityV2 } from "./envelopeV2";

export const ENCRYPTED_FILE_CHUNK_BYTES = 1024 * 1024;
export const MAX_ENCRYPTED_FILE_BYTES = 100 * ENCRYPTED_FILE_CHUNK_BYTES;
export type EncryptedAttachmentManifest = {
  version: 1; attachmentId: string; uploadId: string; noncePrefix: string;
  name: string; mime: string; size: number; wrappedKey: SealedBytes;
  chunks: Array<{ index: number; ciphertextBytes: number; sha256: string }>;
};
export function validateAttachmentManifest(value: unknown): EncryptedAttachmentManifest {
  const record = strictRecord(value, ["version", "attachmentId", "uploadId", "noncePrefix", "name", "mime", "size", "wrappedKey", "chunks"]);
  uuid(record.attachmentId); uuid(record.uploadId); fromBase64(record.noncePrefix, 8);
  if (record.version !== 1 || typeof record.name !== "string" || record.name.length > 1024 || typeof record.mime !== "string" || record.mime.length > 256
    || !Number.isSafeInteger(record.size) || (record.size as number) < 0 || (record.size as number) > MAX_ENCRYPTED_FILE_BYTES
    || !Array.isArray(record.chunks) || record.chunks.length !== Math.max(1, Math.ceil((record.size as number) / ENCRYPTED_FILE_CHUNK_BYTES))) throw new EncryptedContentError("invalid");
  const size = record.size as number;
  const wrappedKey = sealedBytes(record.wrappedKey, 48); fromBase64(wrappedKey.ciphertext, 48);
  const chunks = record.chunks.map((value, index) => {
    const chunk = strictRecord(value, ["index", "ciphertextBytes", "sha256"]);
    const bytes = Math.min(ENCRYPTED_FILE_CHUNK_BYTES, size - index * ENCRYPTED_FILE_CHUNK_BYTES) + 16;
    if (chunk.index !== index || chunk.ciphertextBytes !== bytes || typeof chunk.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(chunk.sha256)) throw new EncryptedContentError("invalid");
    return { index, ciphertextBytes: bytes, sha256: chunk.sha256 };
  });
  return { version: 1, attachmentId: record.attachmentId, uploadId: record.uploadId, noncePrefix: record.noncePrefix as string,
    name: record.name, mime: record.mime, size, wrappedKey, chunks };
}
export function fileChunkNonce(prefix: string, index: number): Uint8Array {
  if (!Number.isSafeInteger(index) || index < 0 || index > 0xffffffff) throw new EncryptedContentError("invalid");
  const nonce = new Uint8Array(12); nonce.set(fromBase64(prefix, 8)); new DataView(nonce.buffer).setUint32(8, index, false);
  return nonce;
}
const hash = async (bytes: Uint8Array): Promise<string> => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (value) => value.toString(16).padStart(2, "0")).join("");
const cancelled = (signal?: AbortSignal) => { if (signal?.aborted) throw new EncryptedContentError("aborted"); };
const fileContext = (manifest: Pick<EncryptedAttachmentManifest, "attachmentId" | "uploadId">) => [1, manifest.attachmentId, manifest.uploadId] as const;

/** Worker-only. One new file key/upload identity per call; a retry reuses emitted ciphertext. */
export async function encryptAttachment(input: {
  source: Blob; name: string; mime: string; rootKey: CryptoKey; identity: ContentIdentityV2;
  writeChunk: (index: number, ciphertext: Uint8Array) => Promise<void>; signal?: AbortSignal;
}): Promise<EncryptedAttachmentManifest> {
  const identity = identityV2(input.identity);
  if (!Number.isSafeInteger(input.source.size) || input.source.size < 0 || input.source.size > MAX_ENCRYPTED_FILE_BYTES
    || typeof input.name !== "string" || input.name.length > 1024 || typeof input.mime !== "string" || input.mime.length > 256) throw new EncryptedContentError("invalid");
  cancelled(input.signal);
  const raw = randomBytes(32);
  try {
    const key = await importKey(raw);
    const manifest: EncryptedAttachmentManifest = { version: 1, attachmentId: crypto.randomUUID(), uploadId: crypto.randomUUID(),
      noncePrefix: toBase64(randomBytes(8)), name: input.name, mime: input.mime, size: input.source.size,
      wrappedKey: { iv: "", ciphertext: "" }, chunks: [] };
    manifest.wrappedKey = await seal(input.rootKey, raw, aadV2(identity, "file-key", fileContext(manifest)));
    raw.fill(0);
    const count = Math.max(1, Math.ceil(manifest.size / ENCRYPTED_FILE_CHUNK_BYTES));
    for (let index = 0; index < count; index++) {
      cancelled(input.signal);
      const bytes = new Uint8Array(await input.source.slice(index * ENCRYPTED_FILE_CHUNK_BYTES, (index + 1) * ENCRYPTED_FILE_CHUNK_BYTES).arrayBuffer());
      try {
        const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: fileChunkNonce(manifest.noncePrefix, index),
          additionalData: aadV2(identity, "file-chunk", [...fileContext(manifest), index]), tagLength: 128 }, key, bytes));
        const chunk = { index, ciphertextBytes: ciphertext.length, sha256: await hash(ciphertext) };
        cancelled(input.signal); await input.writeChunk(index, ciphertext); cancelled(input.signal);
        manifest.chunks.push(chunk);
      } finally { bytes.fill(0); }
    }
    return validateAttachmentManifest(manifest);
  } finally { raw.fill(0); }
}

/** Manifest must come from authenticated plaintext. Copy yielded bytes before advancing the stream. */
export async function* decryptAttachment(input: {
  manifest: unknown; rootKey: CryptoKey; identity: ContentIdentityV2;
  readChunk: (index: number) => Promise<Uint8Array>; signal?: AbortSignal;
}): AsyncGenerator<Uint8Array> {
  const identity = identityV2(input.identity); const manifest = validateAttachmentManifest(input.manifest);
  cancelled(input.signal);
  let raw: Uint8Array | undefined;
  try {
    raw = await open(input.rootKey, manifest.wrappedKey, aadV2(identity, "file-key", fileContext(manifest)));
    const key = await importKey(raw); raw.fill(0);
    for (const chunk of manifest.chunks) {
      cancelled(input.signal);
      const bytes = await input.readChunk(chunk.index); cancelled(input.signal);
      if (!(bytes instanceof Uint8Array) || bytes.length !== chunk.ciphertextBytes || await hash(bytes) !== chunk.sha256) throw new EncryptedContentError("unlock-failed");
      const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fileChunkNonce(manifest.noncePrefix, chunk.index),
        additionalData: aadV2(identity, "file-chunk", [...fileContext(manifest), chunk.index]), tagLength: 128 }, key, bytes));
      try { cancelled(input.signal); yield plaintext; }
      finally { plaintext.fill(0); }
    }
  } catch (error) {
    if (error instanceof EncryptedContentError) throw error;
    throw new EncryptedContentError("unlock-failed");
  } finally { raw?.fill(0); }
}

export type EncryptedHistoryV2 = {
  version: 1; objectId: string; keyEpoch: number; encryptionEpoch: number;
  historyId: string; sourceVersion: number; originalFormat: ContentIdentityV2["originalFormat"]; payload: SealedBytes;
};
export function validateHistoryV2(value: unknown): EncryptedHistoryV2 {
  const history = strictRecord(value, ["version", "objectId", "keyEpoch", "encryptionEpoch", "historyId", "sourceVersion", "originalFormat", "payload"]);
  uuid(history.objectId); uuid(history.historyId); positiveEpoch(history.sourceVersion); positiveEpoch(history.keyEpoch); positiveEpoch(history.encryptionEpoch);
  if (history.version !== 1 || !["markdown", "tiptap-json"].includes(history.originalFormat as string)) throw new EncryptedContentError("invalid");
  return { version: 1, objectId: history.objectId, keyEpoch: history.keyEpoch, encryptionEpoch: history.encryptionEpoch, historyId: history.historyId, sourceVersion: history.sourceVersion,
    originalFormat: history.originalFormat as ContentIdentityV2["originalFormat"], payload: sealedBytes(history.payload) };
}
