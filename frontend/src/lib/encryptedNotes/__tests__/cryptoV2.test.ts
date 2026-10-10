// @vitest-environment node
import { beforeAll, expect, it } from "vitest";
import fixture from "./fixtures/envelope-v2.json";
import { fromBase64 } from "../envelope";
import { validateEnvelopeV2 } from "../envelopeV2";
import { changeContentV2Passphrase, createContentV2, decryptHistoryV2, encryptHistoryV2, unlockContentV2, updateContentV2, validateDocumentV2 } from "../cryptoV2";
import { decryptAttachment, encryptAttachment, ENCRYPTED_FILE_CHUNK_BYTES, fileChunkNonce, validateAttachmentManifest } from "../attachmentCodec";
import { hasStrongNewPassphrase, validateNewPassphrase } from "../passphrasePolicy";

const envelope = validateEnvelopeV2(fixture.envelope);
let key: CryptoKey;
beforeAll(async () => { key = (await unlockContentV2(envelope, fixture.passphrase, envelope)).key; });
const collect = async (source: AsyncGenerator<Uint8Array>) => { const result: Uint8Array[] = []; for await (const bytes of source) result.push(bytes.slice()); return Buffer.concat(result); };

it("reads independent OpenSSL document/history/file vectors with a non-exportable session key", async () => {
  expect(key.extractable).toBe(false); await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
  expect((await unlockContentV2(envelope, fixture.passphrase, envelope)).document).toEqual(fixture.document);
  expect(await decryptHistoryV2(key, envelope, fixture.history)).toEqual(fixture.historyDocument);
  const bytes = await collect(decryptAttachment({ rootKey: key, identity: envelope, manifest: fixture.document.attachments[0], readChunk: async () => fromBase64(fixture.fileCiphertext, 23) }));
  expect(bytes.toString("base64")).toBe(fixture.filePlaintext);
});

it("binds document authentication to every identity/schema/epoch field and rejects unknown fields", async () => {
  const patches = [{ objectId: crypto.randomUUID() }, { originalFormat: "tiptap-json" }, { keyEpoch: 2 }, { encryptionEpoch: 3 },
    { kind: "block", parentObjectId: crypto.randomUUID() }];
  for (const patch of patches) {
    const changed = { ...envelope, ...patch };
    await expect(unlockContentV2(changed, fixture.passphrase, changed as typeof envelope)).rejects.toMatchObject({ code: "unlock-failed" });
  }
  for (const patch of [{ version: 3 }, { documentSchemaVersion: 2 }, { encryptionEpoch: 0 }, { keyEpoch: Number.MAX_SAFE_INTEGER + 1 }, { parentObjectId: crypto.randomUUID() }, { leakedPlaintext: "secret" }]) {
    expect(() => validateEnvelopeV2({ ...envelope, ...patch })).toThrow();
  }
  await expect(unlockContentV2(envelope, "wrong password", envelope)).rejects.toMatchObject({ code: "unlock-failed" });
});

it("updates without a password, authenticates the pre-image and preserves attachments", async () => {
  const document = validateDocumentV2({ ...fixture.document, content: "New body" });
  const next = await updateContentV2(envelope, key, envelope, document);
  expect(next.payload.iv).not.toBe(envelope.payload.iv); expect(next.wrappedKey).toEqual(envelope.wrappedKey);
  expect((await unlockContentV2(next, fixture.passphrase, envelope)).document).toEqual(document);
  const broken = structuredClone(envelope); broken.payload.ciphertext = "A" + broken.payload.ciphertext.slice(1);
  await expect(updateContentV2(broken, key, envelope, document)).rejects.toMatchObject({ code: "unlock-failed" });
  await expect(updateContentV2(envelope, key, { ...envelope, objectId: crypto.randomUUID() }, document)).rejects.toMatchObject({ code: "unlock-failed" });
});

it("rewraps the same root and files under a new strong password while preserving old history semantics", async () => {
  const next = await changeContentV2Passphrase(envelope, fixture.passphrase, envelope, "654321");
  expect(next.payload).toEqual(envelope.payload); expect(next.keyEpoch).toBe(envelope.keyEpoch);
  const changed = await unlockContentV2(next, "654321", envelope);
  expect(await decryptHistoryV2(changed.key, envelope, fixture.history)).toEqual(fixture.historyDocument);
  await expect(unlockContentV2(next, fixture.passphrase, envelope)).rejects.toMatchObject({ code: "unlock-failed" });
  expect((await unlockContentV2(envelope, fixture.passphrase, envelope)).document).toEqual(fixture.document);
});

it("binds encrypted history to history identity, source version, original format and its parent root", async () => {
  const context = { version: 1 as const, historyId: crypto.randomUUID(), sourceVersion: 7, originalFormat: "tiptap-json" as const };
  const history = await encryptHistoryV2(key, envelope, context, { documentSchemaVersion: 1, content: '{"type":"doc","content":[]}', attachments: [] });
  expect((await decryptHistoryV2(key, envelope, history)).document.content).toContain('"doc"');
  for (const patch of [{ historyId: crypto.randomUUID() }, { sourceVersion: 8 }, { originalFormat: "markdown" }]) await expect(decryptHistoryV2(key, envelope, { ...history, ...patch })).rejects.toMatchObject({ code: "unlock-failed" });
  await expect(decryptHistoryV2(key, { ...envelope, objectId: crypto.randomUUID() }, history)).rejects.toMatchObject({ code: "unlock-failed" });
  await expect(decryptHistoryV2(key, envelope, { ...history, extra: true })).rejects.toThrow();
});

it("encrypts zero-byte and multi-chunk files with bounded sequential I/O and independently keyed uploads", async () => {
  for (const size of [0, ENCRYPTED_FILE_CHUNK_BYTES * 2 + 29]) {
    const source = new Blob([new Uint8Array(size).fill(42)]); const chunks: Uint8Array[] = []; let active = 0;
    const manifest = await encryptAttachment({ source, name: "private.png", mime: "image/png", rootKey: key, identity: envelope,
      writeChunk: async (index, bytes) => { expect(++active).toBe(1); expect(bytes.length).toBeLessThanOrEqual(ENCRYPTED_FILE_CHUNK_BYTES + 16); chunks[index] = bytes; await Promise.resolve(); active--; } });
    const plaintext = await collect(decryptAttachment({ manifest, rootKey: key, identity: envelope, readChunk: async (index) => chunks[index] }));
    expect(plaintext).toEqual(Buffer.alloc(size, 42));
    const retry = await encryptAttachment({ source, name: "private.png", mime: "image/png", rootKey: key, identity: envelope, writeChunk: async () => {} });
    expect(retry.uploadId).not.toBe(manifest.uploadId); expect(retry.wrappedKey).not.toEqual(manifest.wrappedKey);
  }
});

it("rejects swapped/tampered/truncated chunks, substituted file identities and incomplete manifests", async () => {
  const chunks: Uint8Array[] = [];
  const manifest = await encryptAttachment({ source: new Blob([new Uint8Array(ENCRYPTED_FILE_CHUNK_BYTES * 2)]), name: "s", mime: "x", rootKey: key, identity: envelope, writeChunk: async (index, bytes) => { chunks[index] = bytes; } });
  for (const readChunk of [async () => chunks[1], async (index: number) => chunks[index].slice(1), async (index: number) => { const bytes = chunks[index].slice(); bytes[0] ^= 1; return bytes; }]) {
    await expect(collect(decryptAttachment({ manifest, rootKey: key, identity: envelope, readChunk }))).rejects.toThrow();
  }
  for (const patch of [{ chunks: manifest.chunks.slice(1) }, { chunks: [...manifest.chunks].reverse() }, { size: manifest.size - 1 }, { extra: "plaintext" }]) expect(() => validateAttachmentManifest({ ...manifest, ...patch })).toThrow();
  for (const patch of [{ attachmentId: crypto.randomUUID() }, { uploadId: crypto.randomUUID() }, { noncePrefix: "AAAAAAAAAAA=" }]) await expect(collect(decryptAttachment({ manifest: { ...manifest, ...patch }, rootKey: key, identity: envelope, readChunk: async (index) => chunks[index] }))).rejects.toThrow();
  await expect(collect(decryptAttachment({ manifest, rootKey: key, identity: { ...envelope, encryptionEpoch: 3 }, readChunk: async (index) => chunks[index] }))).rejects.toThrow();
});

it("bounds chunk counters and aborts without publishing an incomplete manifest", async () => {
  expect(Buffer.from(fileChunkNonce("gIGCg4SFhoc=", 0xffffffff)).toString("hex")).toBe("8081828384858687ffffffff");
  for (const index of [-1, 0x100000000, 0.5]) expect(() => fileChunkNonce("gIGCg4SFhoc=", index)).toThrow();
  const controller = new AbortController(); let count = 0;
  await expect(encryptAttachment({ source: new Blob([new Uint8Array(ENCRYPTED_FILE_CHUNK_BYTES + 1)]), name: "s", mime: "x", rootKey: key, identity: envelope, signal: controller.signal, writeChunk: async () => { count++; controller.abort(); } })).rejects.toMatchObject({ code: "aborted" });
  expect(count).toBe(1);
});

it("requires 6 Unicode characters only for new passwords and creates fresh identities with independent roots", async () => {
  expect(hasStrongNewPassphrase("🚀".repeat(5))).toBe(false); expect(hasStrongNewPassphrase("🚀".repeat(6))).toBe(true);
  expect(() => validateNewPassphrase("short")).toThrow();
  const document = { documentSchemaVersion: 1 as const, content: "new", attachments: [] };
  await expect(createContentV2({ document, passphrase: "short", identity: envelope })).rejects.toThrow();
  const identity = { ...envelope, objectId: crypto.randomUUID() };
  await expect(createContentV2({ document: validateDocumentV2(fixture.document), passphrase: "123456", identity })).rejects.toMatchObject({ code: "invalid" });
  const created = await createContentV2({ document, passphrase: "123456", identity });
  expect((await unlockContentV2(created, "123456", identity)).document).toEqual(document);
  const createdKey = (await unlockContentV2(created, "123456", identity)).key;
  await expect(updateContentV2(created, createdKey, identity, validateDocumentV2(fixture.document))).rejects.toMatchObject({ code: "unlock-failed" });
});
