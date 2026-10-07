import { argon2id } from "hash-wasm";
import {
  ARGON2_PROFILE, MAX_CONTENT_BYTES, EncryptedContentError, contentAad,
  fromBase64, toBase64, validateEnvelope, validateIdentity, validatePassphrase,
  type EncryptedContentEnvelope, type EncryptedContentIdentity, type SealedBytes,
} from "./envelope";

function requireCrypto(): Crypto {
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues || !globalThis.crypto?.randomUUID) {
    throw new EncryptedContentError("unavailable");
  }
  return globalThis.crypto;
}
const randomBytes = (size: number) => requireCrypto().getRandomValues(new Uint8Array(size));

async function importKey(bytes: Uint8Array): Promise<CryptoKey> {
  return requireCrypto().subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function deriveKey(passphrase: string, salt: string): Promise<CryptoKey> {
  const password = validatePassphrase(passphrase);
  let derived: Uint8Array | undefined;
  try {
    derived = await argon2id({
      password, salt: fromBase64(salt, 16), memorySize: ARGON2_PROFILE.memoryKiB,
      iterations: ARGON2_PROFILE.iterations, parallelism: ARGON2_PROFILE.parallelism,
      hashLength: 32, outputType: "binary",
    });
    return await importKey(derived);
  } catch {
    // A blocked/unsupported WASM runtime is a capability failure, not a wrong password.
    throw new EncryptedContentError("unavailable");
  } finally { password.fill(0); derived?.fill(0); }
}
async function seal(key: CryptoKey, bytes: Uint8Array, aad: Uint8Array, previousIv?: string): Promise<SealedBytes> {
  let iv = randomBytes(12);
  while (toBase64(iv) === previousIv) iv = randomBytes(12);
  const ciphertext = await requireCrypto().subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, key, bytes);
  return { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) };
}
async function open(key: CryptoKey, sealed: SealedBytes, aad: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await requireCrypto().subtle.decrypt({
    name: "AES-GCM", iv: fromBase64(sealed.iv, 12), additionalData: aad, tagLength: 128,
  }, key, fromBase64(sealed.ciphertext, 16, MAX_CONTENT_BYTES + 16)));
}
function encodeContent(plaintext: string): Uint8Array {
  if (typeof plaintext !== "string" || plaintext.length > MAX_CONTENT_BYTES) throw new EncryptedContentError("invalid");
  const bytes = new TextEncoder().encode(plaintext);
  if (bytes.length > MAX_CONTENT_BYTES
    || new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) !== plaintext) throw new EncryptedContentError("invalid");
  return bytes;
}
function checkedEnvelope(value: unknown, expected: EncryptedContentIdentity): EncryptedContentEnvelope {
  requireCrypto();
  validateIdentity(expected);
  const envelope = validateEnvelope(value);
  if (envelope.objectId !== expected.objectId || envelope.kind !== expected.kind || envelope.originalFormat !== expected.originalFormat) {
    throw new EncryptedContentError("unlock-failed");
  }
  return envelope;
}
async function unlockedKey(envelope: EncryptedContentEnvelope, passphrase: string): Promise<Uint8Array> {
  validatePassphrase(passphrase).fill(0);
  try {
    const wrappingKey = await deriveKey(passphrase, envelope.kdf.salt);
    return await open(wrappingKey, envelope.wrappedKey, contentAad(envelope, "key"));
  } catch (error) {
    if (error instanceof EncryptedContentError) throw error;
    throw new EncryptedContentError("unlock-failed");
  }
}
async function authenticatedContent(envelope: EncryptedContentEnvelope, key: CryptoKey): Promise<Uint8Array> {
  try { return await open(key, envelope.payload, contentAad(envelope, "content")); }
  catch { throw new EncryptedContentError("unlock-failed"); }
}

export async function createEncryptedContent(input: {
  plaintext: string; passphrase: string; kind: EncryptedContentIdentity["kind"]; originalFormat: EncryptedContentIdentity["originalFormat"];
}): Promise<EncryptedContentEnvelope> {
  requireCrypto();
  validatePassphrase(input.passphrase).fill(0);
  const identity = { objectId: crypto.randomUUID(), kind: input.kind, originalFormat: input.originalFormat };
  validateIdentity(identity);
  const content = encodeContent(input.plaintext);
  const dek = randomBytes(32);
  try {
    const salt = toBase64(randomBytes(16));
    const wrappingKey = await deriveKey(input.passphrase, salt);
    const wrappedKey = await seal(wrappingKey, dek, contentAad(identity, "key"));
    const payload = await seal(await importKey(dek), content, contentAad(identity, "content"), wrappedKey.iv);
    return { ...identity, version: 1, algorithm: "AES-256-GCM", kdf: { ...ARGON2_PROFILE, salt }, wrappedKey, payload };
  } finally { dek.fill(0); content.fill(0); }
}

export async function decryptEncryptedContent(value: unknown, passphrase: string, expected: EncryptedContentIdentity): Promise<string> {
  return (await unlockEncryptedContentKey(value, passphrase, expected)).plaintext;
}

/** Worker-only session primitive: the key is non-exportable and never sent to the UI. */
export async function unlockEncryptedContentKey(value: unknown, passphrase: string, expected: EncryptedContentIdentity): Promise<{ plaintext: string; key: CryptoKey }> {
  const envelope = checkedEnvelope(value, expected);
  const dek = await unlockedKey(envelope, passphrase);
  let plaintext: Uint8Array | undefined;
  try {
    const key = await importKey(dek);
    plaintext = await authenticatedContent(envelope, key);
    try { return { plaintext: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(plaintext), key }; }
    catch { throw new EncryptedContentError("unlock-failed"); }
  } finally { dek.fill(0); plaintext?.fill(0); }
}

export async function updateEncryptedContent(value: unknown, passphrase: string, expected: EncryptedContentIdentity, plaintext: string): Promise<EncryptedContentEnvelope> {
  const envelope = checkedEnvelope(value, expected);
  const dek = await unlockedKey(envelope, passphrase);
  try {
    return await updateEncryptedContentWithKey(envelope, await importKey(dek), expected, plaintext);
  } finally { dek.fill(0); }
}

export async function updateEncryptedContentWithKey(value: unknown, key: CryptoKey, expected: EncryptedContentIdentity, plaintext: string): Promise<EncryptedContentEnvelope> {
  const envelope = checkedEnvelope(value, expected);
  const content = encodeContent(plaintext);
  try {
    (await authenticatedContent(envelope, key)).fill(0);
    let payload = await seal(key, content, contentAad(envelope, "content"), envelope.payload.iv);
    while (payload.iv === envelope.wrappedKey.iv) payload = await seal(key, content, contentAad(envelope, "content"), envelope.payload.iv);
    return { ...envelope, payload };
  } finally { content.fill(0); }
}

export async function changeEncryptedContentPassphrase(value: unknown, oldPassphrase: string, expected: EncryptedContentIdentity, newPassphrase: string): Promise<EncryptedContentEnvelope> {
  const envelope = checkedEnvelope(value, expected);
  validatePassphrase(newPassphrase).fill(0);
  const dek = await unlockedKey(envelope, oldPassphrase);
  try {
    (await authenticatedContent(envelope, await importKey(dek))).fill(0);
    const salt = toBase64(randomBytes(16));
    const wrappedKey = await seal(await deriveKey(newPassphrase, salt), dek, contentAad(envelope, "key"), envelope.payload.iv);
    return { ...envelope, kdf: { ...ARGON2_PROFILE, salt }, wrappedKey };
  } finally { dek.fill(0); }
}
