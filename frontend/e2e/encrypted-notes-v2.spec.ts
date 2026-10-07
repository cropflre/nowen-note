import { expect, test } from "./encrypted-notes-test";
import type {} from "../benchmarks/encrypted-notes";

test.beforeEach(async ({ page }) => {
  await page.goto("http://127.0.0.1:5176/benchmarks/encrypted-notes.html");
  await page.waitForFunction(() => Boolean(window.cryptoBenchmark));
});
test("v2 real session Worker reads independent document/history/file vectors and rejects untrusted manifest changes", async ({ page }) => {
  const failures: string[] = []; page.on("pageerror", (error) => failures.push(error.message));
  const result = await page.evaluate(async () => {
    const { makeV2Session, vectorV2 } = window.cryptoBenchmark; const session = makeV2Session();
    try {
      const document = await session.open(vectorV2.envelope, vectorV2.passphrase, vectorV2.envelope);
      const history = await session.decryptHistory(vectorV2.history as Parameters<typeof session.decryptHistory>[0]);
      const file = document.attachments[0]; const plaintext: number[] = [];
      const cipher = Uint8Array.from(atob(vectorV2.fileCiphertext), (char) => char.charCodeAt(0));
      await session.decryptFile(file, { read: async () => cipher, consume: async (_index, bytes) => { plaintext.push(...bytes); } });
      let untrusted = ""; let reads = 0;
      try { await session.decryptFile({ ...file, size: file.size - 1 }, { read: async () => { reads++; return cipher; }, consume: async () => {} }); }
      catch (error) { untrusted = (error as { code: string }).code; }
      const updated = await session.update(vectorV2.envelope, { ...document, content: "v2 worker private edit" });
      return { content: document.content, history: history.changeSummary, file: btoa(String.fromCharCode(...plaintext)), untrusted, reads,
        ivChanged: updated.payload.iv !== vectorV2.envelope.payload.iv, wrappingPreserved: JSON.stringify(updated.wrappedKey) === JSON.stringify(vectorV2.envelope.wrappedKey),
        noCredentialsInHandle: !JSON.stringify(session).includes(vectorV2.passphrase) };
    } finally { session.close(); }
  });
  expect(result).toMatchObject({ history: "私密的版本说明", file: "AP+AASoACg==", untrusted: "invalid", reads: 0, ivChanged: true, wrappingPreserved: true, noCredentialsInHandle: true });
  expect(failures).toEqual([]);
});
test("v2 Worker streams multiple chunks and zero-byte files with backpressure and persistent ciphertext only", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { makeV2Session, vectorV2 } = window.cryptoBenchmark; const session = makeV2Session();
    try {
      const identity = { ...vectorV2.envelope, objectId: crypto.randomUUID(), encryptionEpoch: 1 };
      const document = { documentSchemaVersion: 1 as const, content: "V2_PRIVATE_DOCUMENT_SENTINEL", attachments: [] };
      const envelope = await session.create(document, "test-only v2 strong password", identity);
      const chunks: Uint8Array[] = []; let writes = 0; let maxChunk = 0; let consumed = 0; let contentMatches = true; let descriptorBytes = 0;
      const manifest = await session.encryptFile(new Blob([new Uint8Array(2 * 1024 * 1024 + 7).fill(42)]), "V2_PRIVATE_FILENAME_SENTINEL.png", "image/png", {
        begin: async (descriptor) => { descriptorBytes = descriptor.ciphertextBytes; if (JSON.stringify(descriptor).includes("SENTINEL")) throw new Error("Metadata leaked"); },
        write: async (index, bytes) => { chunks[index] = bytes; writes++; maxChunk = Math.max(maxChunk, bytes.length); await Promise.resolve(); },
      });
      await session.decryptFile(manifest, { read: async (index) => chunks[index], consume: async (_index, bytes) => { consumed += bytes.length; contentMatches &&= bytes.every((value) => value === 42); } });
      const updated = await session.update(envelope, { ...document, attachments: [manifest] });
      const emptyChunks: Uint8Array[] = [];
      const empty = await session.encryptFile(new Blob([]), "empty", "application/octet-stream", { begin: async () => {}, write: async (index, bytes) => { emptyChunks[index] = bytes; } });
      let emptyConsumed = -1;
      await session.decryptFile(empty, { read: async (index) => emptyChunks[index], consume: async (_index, bytes) => { emptyConsumed = bytes.length; } });
      const encoded = JSON.stringify(updated);
      return { writes, maxChunk, consumed, contentMatches, descriptorBytes, emptyCipherBytes: emptyChunks[0].length, emptyConsumed,
        noPlaintextPersisted: !encoded.includes("SENTINEL") && !encoded.includes("strong password"), storage: [localStorage.length, sessionStorage.length, (await indexedDB.databases()).length] };
    } finally { session.close(); }
  });
  expect(result).toEqual({ writes: 3, maxChunk: 1048592, consumed: 2097159, contentMatches: true, descriptorBytes: 2097207, emptyCipherBytes: 16, emptyConsumed: 0, noPlaintextPersisted: true, storage: [0, 0, 0] });
});
test("abort during v2 attachment persistence cancels I/O and destroys the real key Worker", async ({ page }) => {
  let closed = 0; page.on("worker", (worker) => worker.on("close", () => closed++));
  const result = await page.evaluate(async () => {
    const { makeV2Session, vectorV2 } = window.cryptoBenchmark; const session = makeV2Session(); const controller = new AbortController(); let ioCancelled = false;
    try {
      await session.open(vectorV2.envelope, vectorV2.passphrase, vectorV2.envelope);
      try {
        await session.encryptFile(new Blob(["private"]), "s", "x", { begin: async () => {}, write: async (_index, _bytes, signal) => {
          signal.addEventListener("abort", () => { ioCancelled = true; }); controller.abort(); await new Promise(() => {});
        } }, controller.signal);
        return { code: "unexpected success", ioCancelled };
      } catch (error) { return { code: (error as { code: string }).code, ioCancelled }; }
    } finally { session.close(); }
  });
  expect(result).toEqual({ code: "aborted", ioCancelled: true }); await expect.poll(() => closed).toBe(1);
});
