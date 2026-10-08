// @vitest-environment node
import { createDecipheriv, webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { argon2id } from "hash-wasm";
import fixture from "./fixtures/envelope-v1.json";
import {
  createEncryptedContent, decryptEncryptedContent, updateEncryptedContent, changeEncryptedContentPassphrase,
} from "../crypto";
import {
  contentAad, validateEnvelope, validatePassphrase, fromBase64, MAX_CONTENT_BYTES,
  type EncryptedContentEnvelope, type EncryptedContentIdentity,
} from "../envelope";

const original = fixture.envelope as EncryptedContentEnvelope;
const identity: EncryptedContentIdentity = { objectId: original.objectId, kind: original.kind, originalFormat: original.originalFormat };
afterEach(() => { vi.unstubAllGlobals(); });

describe("encrypted content interoperability and lifecycle", () => {
  it("matches native Argon2id and fixed AAD vectors, then decrypts the independent OpenSSL envelope", async () => {
    const derived = await argon2id({ password: fixture.passphrase, salt: fromBase64(original.kdf.salt, 16),
      memorySize: 65536, iterations: 3, parallelism: 4, hashLength: 32, outputType: "hex" });
    expect(derived).toBe(fixture.derivedKeyHex);
    expect(new TextDecoder().decode(contentAad(identity, "key"))).toBe(fixture.aadKeyUtf8);
    expect(new TextDecoder().decode(contentAad(identity, "content"))).toBe(fixture.aadContentUtf8);
    expect(await decryptEncryptedContent(original, fixture.passphrase, identity)).toBe(fixture.plaintext);
  });

  it.each(["note", "block"] as const)("creates fresh, non-plaintext %s envelopes and roundtrips UTF-8 content", async (kind) => {
    const source = "\ufeff私密内容 📝";
    const passphrase = "123456";
    const first = await createEncryptedContent({ plaintext: source, passphrase, kind, originalFormat: "tiptap-json" });
    const second = await createEncryptedContent({ plaintext: source, passphrase, kind, originalFormat: "tiptap-json" });
    expect(validateEnvelope(first)).toEqual(first);
    expect(first.objectId).not.toBe(second.objectId);
    expect(first.kdf.salt).not.toBe(second.kdf.salt);
    expect(first.payload.iv).not.toBe(second.payload.iv);
    expect(first.payload.iv).not.toBe(first.wrappedKey.iv);
    expect(JSON.stringify(first)).not.toContain(source);
    expect(JSON.stringify(first)).not.toContain(passphrase);
    expect(await decryptEncryptedContent(first, passphrase, first)).toBe(source);
  });

  it("updates without changing the wrapped key and authenticates the old payload before saving", async () => {
    const before = JSON.stringify(original);
    const updated = await updateEncryptedContent(original, fixture.passphrase, identity, "新内容");
    expect(updated.wrappedKey).toEqual(original.wrappedKey);
    expect(updated.payload.iv).not.toBe(original.payload.iv);
    expect(await decryptEncryptedContent(updated, fixture.passphrase, identity)).toBe("新内容");
    expect(JSON.stringify(original)).toBe(before);
    const broken = structuredClone(original);
    broken.payload.ciphertext = flip(broken.payload.ciphertext);
    await expect(updateEncryptedContent(broken, fixture.passphrase, identity, "overwrite")).rejects.toMatchObject({ code: "unlock-failed" });
  });

  it("changes passphrase by rewrapping only, leaving old backups usable with their original passphrase", async () => {
    const changed = await changeEncryptedContentPassphrase(original, fixture.passphrase, identity, "123456");
    expect(changed.payload).toEqual(original.payload);
    expect(changed.kdf.salt).not.toBe(original.kdf.salt);
    expect(changed.wrappedKey).not.toEqual(original.wrappedKey);
    expect(await decryptEncryptedContent(changed, "123456", identity)).toBe(fixture.plaintext);
    await expect(decryptEncryptedContent(changed, fixture.passphrase, identity)).rejects.toMatchObject({ code: "unlock-failed" });
    expect(await decryptEncryptedContent(original, fixture.passphrase, identity)).toBe(fixture.plaintext);
    await expect(changeEncryptedContentPassphrase(original, "wrong", identity, "123456")).rejects.toMatchObject({ code: "unlock-failed" });
  });

  it("can be read by an independent native AES-GCM implementation", async () => {
    const envelope = await createEncryptedContent({ plaintext: fixture.plaintext, passphrase: fixture.passphrase, kind: "note", originalFormat: "markdown" });
    const kek = await argon2id({ password: fixture.passphrase, salt: fromBase64(envelope.kdf.salt, 16),
      memorySize: 65536, iterations: 3, parallelism: 4, hashLength: 32, outputType: "binary" });
    const nativeOpen = (key: Uint8Array, sealed: typeof envelope.payload, purpose: "key" | "content") => {
      const ciphertext = Buffer.from(sealed.ciphertext, "base64");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
      decipher.setAuthTag(ciphertext.subarray(-16));
      decipher.setAAD(Buffer.from(JSON.stringify(["nowen-encrypted-content", 1, "AES-256-GCM", purpose, envelope.objectId, envelope.kind, envelope.originalFormat])));
      return Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
    };
    expect(nativeOpen(nativeOpen(kek, envelope.wrappedKey, "key"), envelope.payload, "content").toString()).toBe(fixture.plaintext);
  });

  it("fails closed if Web Crypto is unavailable", async () => {
    vi.stubGlobal("crypto", undefined);
    await expect(createEncryptedContent({ plaintext: "secret", passphrase: "test", kind: "note", originalFormat: "markdown" })).rejects.toMatchObject({ code: "unavailable" });
    await expect(decryptEncryptedContent(original, fixture.passphrase, identity)).rejects.toMatchObject({ code: "unavailable" });
    // No Node crypto fallback was used by the module.
    expect(typeof webcrypto.subtle).toBe("object");
  });
});

function flip(base64: string): string {
  const bytes = Buffer.from(base64, "base64"); bytes[0] ^= 1; return bytes.toString("base64");
}
describe("hostile envelopes and bounded inputs", () => {
  it.each(["wrappedKey.iv", "wrappedKey.ciphertext", "payload.iv", "payload.ciphertext", "kdf.salt"])("rejects tampering with %s and preserves the input", async (field) => {
    const changed = structuredClone(original);
    const [section, key] = field.split(".");
    const target = (changed as unknown as Record<string, Record<string, string>>)[section]; target[key] = flip(target[key]);
    const before = JSON.stringify(changed);
    await expect(decryptEncryptedContent(changed, fixture.passphrase, identity)).rejects.toMatchObject({ code: "unlock-failed" });
    expect(JSON.stringify(changed)).toBe(before);
  });

  it.each([
    { objectId: "00112233-4455-4677-8899-aabbccddee00" }, { kind: "block" }, { originalFormat: "tiptap-json" },
  ])("authenticates the identity even if the caller accepts modified metadata %j", async (patch) => {
    const changed = { ...original, ...patch } as EncryptedContentEnvelope;
    await expect(decryptEncryptedContent(changed, fixture.passphrase, changed)).rejects.toMatchObject({ code: "unlock-failed" });
    await expect(decryptEncryptedContent(changed, fixture.passphrase, identity)).rejects.toMatchObject({ code: "unlock-failed" });
  });

  it.each([
    { version: 2 }, { algorithm: "AES-CBC" }, { plaintext: "leaked" },
    { kdf: { ...original.kdf, memoryKiB: 0 } }, { kdf: { ...original.kdf, memoryKiB: 2 ** 32 } },
    { kdf: { ...original.kdf, iterations: Infinity } }, { kdf: { ...original.kdf, parallelism: 1 } },
    { kdf: { ...original.kdf, version: 16 } }, { kdf: { ...original.kdf, salt: "AAAAAAAAAAAAAAAAAAAAAB==" } },
    { wrappedKey: { ...original.wrappedKey, iv: "AA==" } },
    { payload: { ...original.payload, iv: original.wrappedKey.iv } },
    { payload: { ...original.payload, ciphertext: "not base64!" } },
  ])("rejects unsupported or malformed inputs before costly crypto %j", async (patch) => {
    expect(() => validateEnvelope({ ...original, ...patch })).toThrow();
    await expect(decryptEncryptedContent({ ...original, ...patch }, fixture.passphrase, identity)).rejects.toMatchObject({ code: "invalid" });
  });

  it("rejects oversized payloads, malformed strings and oversized passwords before deriving keys", async () => {
    expect(() => validateEnvelope({ ...original, payload: { ...original.payload, ciphertext: "A".repeat(Math.ceil((MAX_CONTENT_BYTES + 17) / 3) * 4) } })).toThrow();
    for (const passphrase of ["", "a".repeat(1025), "密".repeat(342), "\ud800"]) expect(() => validatePassphrase(passphrase)).toThrow();
    for (const plaintext of ["a".repeat(MAX_CONTENT_BYTES + 1), "\ud800"]) {
      await expect(createEncryptedContent({ plaintext, passphrase: "test", kind: "note", originalFormat: "markdown" })).rejects.toMatchObject({ code: "invalid" });
    }
    expect(new TextDecoder().decode(validatePassphrase(" e\u0301 "))).toBe(" e\u0301 ");
    await expect(decryptEncryptedContent(original, "test-only: 密码 cafe\u0301 🚀", identity)).rejects.toMatchObject({ code: "unlock-failed" });
  });
});
