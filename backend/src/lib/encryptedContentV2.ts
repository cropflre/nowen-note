import { encryptedBytes, EncryptedNotePayloadError, encryptedRecord } from "./encryptedNotes.js";

export const ENCRYPTED_NOTE_V2_FORMAT = "encrypted-note-v2";
export const ENCRYPTED_HISTORY_V2_FORMAT = "encrypted-history-v2";
export type EncryptedIdentityV2 = { objectId: string; kind: "note" | "block"; originalFormat: "markdown" | "tiptap-json";
  parentObjectId: string | null; documentSchemaVersion: 1; keyEpoch: number; encryptionEpoch: number };
const uuid = (value: unknown) => { if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new EncryptedNotePayloadError(); };
const epoch = (value: unknown) => { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new EncryptedNotePayloadError(); };
function parse(content: unknown): unknown {
  if (typeof content !== "string" || content.length > 5594476) throw new EncryptedNotePayloadError();
  try { return JSON.parse(content); } catch { throw new EncryptedNotePayloadError(); }
}
function sealed(value: unknown, min: number, max = min): void {
  const record = encryptedRecord(value, ["iv", "ciphertext"]); encryptedBytes(record.iv, 12); encryptedBytes(record.ciphertext, min, max);
}
/** Structural only. Authentication and source read-back remain client responsibilities. */
export function parseEncryptedContentV2(content: unknown, kind: "note" | "block" = "note"): EncryptedIdentityV2 {
  const envelope = encryptedRecord(parse(content), ["version", "algorithm", "objectId", "kind", "originalFormat", "parentObjectId", "documentSchemaVersion", "keyEpoch", "encryptionEpoch", "kdf", "wrappedKey", "payload"]);
  uuid(envelope.objectId); epoch(envelope.keyEpoch); epoch(envelope.encryptionEpoch);
  if (envelope.version !== 2 || envelope.algorithm !== "AES-256-GCM" || envelope.kind !== kind || envelope.documentSchemaVersion !== 1
    || !["markdown", "tiptap-json"].includes(envelope.originalFormat)) throw new EncryptedNotePayloadError();
  if (kind === "note") { if (envelope.parentObjectId !== null) throw new EncryptedNotePayloadError(); }
  else { uuid(envelope.parentObjectId); if (envelope.parentObjectId === envelope.objectId) throw new EncryptedNotePayloadError(); }
  const kdf = encryptedRecord(envelope.kdf, ["algorithm", "version", "memoryKiB", "iterations", "parallelism", "salt"]);
  if (kdf.algorithm !== "argon2id" || kdf.version !== 19 || kdf.memoryKiB !== 65536 || kdf.iterations !== 3 || kdf.parallelism !== 4) throw new EncryptedNotePayloadError();
  encryptedBytes(kdf.salt, 16); sealed(envelope.wrappedKey, 48); sealed(envelope.payload, 16, 4 * 1024 * 1024 + 16);
  if (envelope.wrappedKey.iv === envelope.payload.iv) throw new EncryptedNotePayloadError();
  return { objectId: envelope.objectId, kind, originalFormat: envelope.originalFormat, parentObjectId: envelope.parentObjectId,
    documentSchemaVersion: 1, keyEpoch: envelope.keyEpoch, encryptionEpoch: envelope.encryptionEpoch };
}
export function parseEncryptedHistoryV2(content: unknown, expected: EncryptedIdentityV2, historyId: string, sourceVersion: number, originalFormat: string): void {
  const history = encryptedRecord(parse(content), ["version", "objectId", "keyEpoch", "encryptionEpoch", "historyId", "sourceVersion", "originalFormat", "payload"]);
  uuid(history.historyId); uuid(history.objectId); epoch(history.sourceVersion); epoch(history.keyEpoch); epoch(history.encryptionEpoch);
  if (history.version !== 1 || history.objectId !== expected.objectId || history.keyEpoch !== expected.keyEpoch || history.encryptionEpoch !== expected.encryptionEpoch
    || history.historyId !== historyId || history.sourceVersion !== sourceVersion || history.originalFormat !== originalFormat
    || !["markdown", "tiptap-json"].includes(originalFormat)) throw new EncryptedNotePayloadError();
  sealed(history.payload, 16, 4 * 1024 * 1024 + 16);
}
