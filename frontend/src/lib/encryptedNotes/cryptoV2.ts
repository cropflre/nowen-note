import { deriveKey, encodeContent, importKey, open, randomBytes, seal } from "./crypto";
import { ARGON2_PROFILE, EncryptedContentError, MAX_CONTENT_BYTES, toBase64, validatePassphrase } from "./envelope";
import { aadV2, identityV2, matchIdentityV2, strictRecord, validateEnvelopeV2, type ContentEnvelopeV2, type ContentIdentityV2 } from "./envelopeV2";
import { validateAttachmentManifest, validateHistoryV2, type EncryptedAttachmentManifest, type EncryptedHistoryV2 } from "./attachmentCodec";
import { validateNewPassphrase } from "./passphrasePolicy";

export type EncryptedDocumentV2 = { documentSchemaVersion: 1; content: string; attachments: EncryptedAttachmentManifest[] };
export function validateDocumentV2(value: unknown): EncryptedDocumentV2 {
  const document = strictRecord(value, ["documentSchemaVersion", "content", "attachments"]);
  if (document.documentSchemaVersion !== 1 || typeof document.content !== "string" || !Array.isArray(document.attachments) || document.attachments.length > 1000) throw new EncryptedContentError("invalid");
  const attachments = document.attachments.map(validateAttachmentManifest);
  if (new Set(attachments.map((file) => file.attachmentId)).size !== attachments.length || new Set(attachments.map((file) => file.uploadId)).size !== attachments.length) throw new EncryptedContentError("invalid");
  const result = { documentSchemaVersion: 1 as const, content: document.content, attachments };
  encodeContent(JSON.stringify(result)).fill(0);
  return result;
}
function checked(value: unknown, expected: ContentIdentityV2): ContentEnvelopeV2 {
  const envelope = validateEnvelopeV2(value); matchIdentityV2(envelope, expected); return envelope;
}
async function authenticate(envelope: ContentEnvelopeV2, key: CryptoKey): Promise<EncryptedDocumentV2> {
  let bytes: Uint8Array | undefined;
  try {
    bytes = await open(key, envelope.payload, aadV2(envelope, "document"));
    return validateDocumentV2(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)));
  } catch (error) {
    if (error instanceof EncryptedContentError && error.code === "invalid") throw error;
    throw new EncryptedContentError("unlock-failed");
  } finally { bytes?.fill(0); }
}
async function unwrap(envelope: ContentEnvelopeV2, passphrase: string): Promise<Uint8Array> {
  validatePassphrase(passphrase).fill(0);
  const key = await deriveKey(passphrase, envelope.kdf.salt);
  try { return await open(key, envelope.wrappedKey, aadV2(envelope, "root-key")); }
  catch { throw new EncryptedContentError("unlock-failed"); }
}
/** Dedicated Worker entry points; never return these keys through postMessage. */
export async function createContentV2(input: { document: EncryptedDocumentV2; passphrase: string; identity: ContentIdentityV2 }): Promise<ContentEnvelopeV2> {
  validateNewPassphrase(input.passphrase);
  const identity = identityV2(input.identity); const bytes = encodeContent(JSON.stringify(validateDocumentV2(input.document))); const raw = randomBytes(32);
  try {
    const salt = toBase64(randomBytes(16));
    const wrappedKey = await seal(await deriveKey(input.passphrase, salt), raw, aadV2(identity, "root-key"));
    const payload = await seal(await importKey(raw), bytes, aadV2(identity, "document"), wrappedKey.iv);
    return { ...identity, version: 2, algorithm: "AES-256-GCM", kdf: { ...ARGON2_PROFILE, salt }, wrappedKey, payload };
  } finally { raw.fill(0); bytes.fill(0); }
}
export async function unlockContentV2(value: unknown, passphrase: string, expected: ContentIdentityV2): Promise<{ document: EncryptedDocumentV2; key: CryptoKey }> {
  const envelope = checked(value, expected); const raw = await unwrap(envelope, passphrase);
  try { const key = await importKey(raw); return { document: await authenticate(envelope, key), key }; }
  finally { raw.fill(0); }
}
export async function updateContentV2(value: unknown, key: CryptoKey, expected: ContentIdentityV2, document: EncryptedDocumentV2): Promise<ContentEnvelopeV2> {
  const envelope = checked(value, expected); const bytes = encodeContent(JSON.stringify(validateDocumentV2(document)));
  try {
    await authenticate(envelope, key);
    let payload = await seal(key, bytes, aadV2(envelope, "document"), envelope.payload.iv);
    while (payload.iv === envelope.wrappedKey.iv) payload = await seal(key, bytes, aadV2(envelope, "document"), envelope.payload.iv);
    return { ...envelope, payload };
  } finally { bytes.fill(0); }
}
export async function changeContentV2Passphrase(value: unknown, oldPassphrase: string, expected: ContentIdentityV2, newPassphrase: string): Promise<ContentEnvelopeV2> {
  const envelope = checked(value, expected); validateNewPassphrase(newPassphrase); const raw = await unwrap(envelope, oldPassphrase);
  try {
    await authenticate(envelope, await importKey(raw));
    const salt = toBase64(randomBytes(16)); const wrappedKey = await seal(await deriveKey(newPassphrase, salt), raw, aadV2(envelope, "root-key"), envelope.payload.iv);
    return { ...envelope, kdf: { ...ARGON2_PROFILE, salt }, wrappedKey };
  } finally { raw.fill(0); }
}
const historyContext = (history: Omit<EncryptedHistoryV2, "payload">) => [history.version, history.historyId, history.sourceVersion, history.originalFormat] as const;
export type EncryptedHistoryPlaintextV2 = { document: EncryptedDocumentV2; changeSummary: string | null };
function validateHistoryPlaintext(value: unknown): EncryptedHistoryPlaintextV2 {
  const record = strictRecord(value, ["document", "changeSummary"]);
  if (record.changeSummary !== null && typeof record.changeSummary !== "string") throw new EncryptedContentError("invalid");
  const result = { document: validateDocumentV2(record.document), changeSummary: record.changeSummary as string | null };
  encodeContent(JSON.stringify(result)).fill(0); return result;
}
export async function encryptHistoryV2(key: CryptoKey, identity: ContentIdentityV2, context: Pick<EncryptedHistoryV2, "version" | "historyId" | "sourceVersion" | "originalFormat">, document: EncryptedDocumentV2, changeSummary: string | null = null): Promise<EncryptedHistoryV2> {
  const history = validateHistoryV2({ ...context, objectId: identity.objectId, keyEpoch: identity.keyEpoch, encryptionEpoch: identity.encryptionEpoch,
    payload: { iv: toBase64(new Uint8Array(12)), ciphertext: toBase64(new Uint8Array(16)) } });
  const bytes = encodeContent(JSON.stringify(validateHistoryPlaintext({ document, changeSummary })));
  try { return { ...history, payload: await seal(key, bytes, aadV2(identity, "history", historyContext(history))) }; }
  finally { bytes.fill(0); }
}
export async function decryptHistoryV2(key: CryptoKey, identity: ContentIdentityV2, value: unknown): Promise<EncryptedHistoryPlaintextV2> {
  const history = validateHistoryV2(value); let bytes: Uint8Array | undefined;
  if (history.objectId !== identity.objectId || history.keyEpoch !== identity.keyEpoch || history.encryptionEpoch !== identity.encryptionEpoch) throw new EncryptedContentError("unlock-failed");
  try {
    bytes = await open(key, history.payload, aadV2(identity, "history", historyContext(history)));
    if (bytes.length > MAX_CONTENT_BYTES) throw new EncryptedContentError("invalid");
    return validateHistoryPlaintext(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)));
  } catch { throw new EncryptedContentError("unlock-failed"); }
  finally { bytes?.fill(0); }
}
