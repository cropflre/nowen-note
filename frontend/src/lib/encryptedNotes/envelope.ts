export type EncryptedContentIdentity = {
  objectId: string;
  kind: "note" | "block";
  originalFormat: "markdown" | "tiptap-json";
};

// Candidate profile only. Mobile measurements are required before editor rollout.
export const ARGON2_PROFILE = Object.freeze({
  algorithm: "argon2id" as const, version: 19 as const,
  memoryKiB: 65536 as const, iterations: 3 as const, parallelism: 4 as const,
});
export const MAX_CONTENT_BYTES = 4 * 1024 * 1024;
export const MAX_PASSPHRASE_BYTES = 1024;
export type SealedBytes = { iv: string; ciphertext: string };
export type EncryptedContentEnvelope = EncryptedContentIdentity & {
  version: 1;
  algorithm: "AES-256-GCM";
  kdf: typeof ARGON2_PROFILE & { salt: string };
  wrappedKey: SealedBytes;
  payload: SealedBytes;
};
export type EncryptedContentErrorCode = "invalid" | "unlock-failed" | "unavailable" | "aborted" | "busy";
export class EncryptedContentError extends Error {
  constructor(readonly code: EncryptedContentErrorCode) {
    // Never include a password, source fragment or native crypto error.
    super(`Encrypted content: ${code}`);
    this.name = "EncryptedContentError";
  }
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

export function fromBase64(value: unknown, minBytes: number, maxBytes = minBytes): Uint8Array {
  if (typeof value !== "string" || value.length > Math.ceil(maxBytes / 3) * 4
    || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new EncryptedContentError("invalid");
  }
  const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  if (bytes.length < minBytes || bytes.length > maxBytes || toBase64(bytes) !== value) {
    throw new EncryptedContentError("invalid");
  }
  return bytes;
}

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new EncryptedContentError("invalid");
  }
  return value as Record<string, unknown>;
}

export function validateIdentity(value: EncryptedContentIdentity): void {
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.objectId)
    || !["note", "block"].includes(value.kind)
    || !["markdown", "tiptap-json"].includes(value.originalFormat)) {
    throw new EncryptedContentError("invalid");
  }
}

/** Strict, bounded, copied input: later caller mutations cannot change an in-flight operation. */
export function validateEnvelope(value: unknown): EncryptedContentEnvelope {
  const envelope = record(value, ["version", "algorithm", "objectId", "kind", "originalFormat", "kdf", "wrappedKey", "payload"]);
  validateIdentity(envelope as EncryptedContentIdentity);
  if (envelope.version !== 1 || envelope.algorithm !== "AES-256-GCM") throw new EncryptedContentError("invalid");
  const kdf = record(envelope.kdf, ["algorithm", "version", "memoryKiB", "iterations", "parallelism", "salt"]);
  for (const key of Object.keys(ARGON2_PROFILE) as Array<keyof typeof ARGON2_PROFILE>) {
    if (kdf[key] !== ARGON2_PROFILE[key]) throw new EncryptedContentError("invalid");
  }
  fromBase64(kdf.salt, 16);
  const wrapped = record(envelope.wrappedKey, ["iv", "ciphertext"]);
  const payload = record(envelope.payload, ["iv", "ciphertext"]);
  fromBase64(wrapped.iv, 12);
  fromBase64(payload.iv, 12);
  // Web Crypto appends the 16-byte GCM tag to ciphertext.
  fromBase64(wrapped.ciphertext, 48);
  fromBase64(payload.ciphertext, 16, MAX_CONTENT_BYTES + 16);
  if (wrapped.iv === payload.iv) throw new EncryptedContentError("invalid");
  return {
    version: 1, algorithm: "AES-256-GCM",
    objectId: envelope.objectId as string, kind: envelope.kind as EncryptedContentIdentity["kind"],
    originalFormat: envelope.originalFormat as EncryptedContentIdentity["originalFormat"],
    kdf: { ...ARGON2_PROFILE, salt: kdf.salt as string },
    wrappedKey: { iv: wrapped.iv as string, ciphertext: wrapped.ciphertext as string },
    payload: { iv: payload.iv as string, ciphertext: payload.ciphertext as string },
  };
}

export function contentAad(identity: EncryptedContentIdentity, purpose: "key" | "content"): Uint8Array {
  // Fixed positional UTF-8 JSON; independent of property insertion order and DB/workspace IDs.
  return new TextEncoder().encode(JSON.stringify([
    "nowen-encrypted-content", 1, "AES-256-GCM", purpose,
    identity.objectId, identity.kind, identity.originalFormat,
  ]));
}

export function validatePassphrase(passphrase: string): Uint8Array {
  if (typeof passphrase !== "string" || passphrase.length > MAX_PASSPHRASE_BYTES) throw new EncryptedContentError("invalid");
  const bytes = new TextEncoder().encode(passphrase);
  if (!bytes.length || bytes.length > MAX_PASSPHRASE_BYTES
    || new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) !== passphrase) throw new EncryptedContentError("invalid");
  return bytes;
}
