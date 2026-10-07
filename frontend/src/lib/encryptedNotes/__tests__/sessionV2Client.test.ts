// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fixture from "./fixtures/envelope-v2.json";
import { EncryptedContentV2Session } from "../sessionV2Client";
import { validateEnvelopeV2 } from "../envelopeV2";
import { validateDocumentV2 } from "../cryptoV2";
import { validateAttachmentManifest } from "../attachmentCodec";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { preventDefault: () => void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn(); terminate = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
  answer(value: unknown) { this.onmessage!({ data: value }); }
}
const envelope = validateEnvelopeV2(fixture.envelope);
const manifest = validateAttachmentManifest(fixture.document.attachments[0]);
let session: EncryptedContentV2Session;
let worker: FakeWorker;
const flush = async () => { for (let index = 0; index < 6; index++) await Promise.resolve(); };
beforeEach(() => { FakeWorker.instances = []; vi.stubGlobal("Worker", FakeWorker); session = new EncryptedContentV2Session(); worker = FakeWorker.instances[0]; });
afterEach(() => { session.close(); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function open() { const pending = session.open(envelope, fixture.passphrase, envelope); worker.answer({ id: 1, ok: true, result: fixture.document }); await pending; }

it("sends creation/open credentials once and updates/history operations carry no password or key", async () => {
  await open();
  const update = session.update(envelope, validateDocumentV2(fixture.document)); worker.answer({ id: 2, ok: true, result: envelope }); await update;
  const history = session.encryptHistory({ version: 1, historyId: crypto.randomUUID(), sourceVersion: 1, originalFormat: "markdown" }, validateDocumentV2(fixture.document), "private summary");
  worker.answer({ id: 3, ok: true, result: fixture.history }); await history;
  expect(worker.postMessage.mock.calls.slice(1).some(([value]) => JSON.stringify(value).includes(fixture.passphrase))).toBe(false);
  expect(JSON.stringify(session)).not.toContain(fixture.passphrase); expect(JSON.stringify(session)).not.toContain("wrappedKey");
});
it("waits for durable chunk callback before sending each acknowledgement", async () => {
  await open(); let acknowledge!: () => void;
  const begin = vi.fn(async () => {}); const write = vi.fn(() => new Promise<void>((resolve) => { acknowledge = resolve; }));
  const pending = session.encryptFile(new Blob(["secret"]), "private.png", "image/png", { begin, write });
  worker.answer({ id: 2, ioId: 1, io: { operation: "begin", descriptor: { attachmentId: manifest.attachmentId, uploadId: manifest.uploadId, chunkCount: 1, ciphertextBytes: 22 } } }); await flush();
  expect(begin).toHaveBeenCalledTimes(1);
  const bytes = new Uint8Array([1, 2, 3]); worker.answer({ id: 2, ioId: 2, io: { operation: "write", index: 0, bytes } }); await flush();
  expect(write).toHaveBeenCalledWith(0, bytes, expect.any(AbortSignal)); expect(worker.postMessage).toHaveBeenCalledTimes(3);
  acknowledge(); await flush(); expect(worker.postMessage.mock.calls.at(-1)![0]).toMatchObject({ id: 2, ioId: 2, ok: true });
  worker.answer({ id: 2, ok: true, result: manifest }); await expect(pending).resolves.toEqual(manifest);
});
it("does not acknowledge a failed durable callback or allow the worker to skip upload sequence", async () => {
  await open(); const write = vi.fn(async () => { throw new Error("Disk full"); });
  const pending = session.encryptFile(new Blob(["s"]), "s", "x", { begin: async () => {}, write });
  worker.answer({ id: 2, ioId: 1, io: { operation: "write", index: 0, bytes: new Uint8Array(17) } }); await flush();
  expect(write).not.toHaveBeenCalled(); expect(worker.postMessage.mock.calls.at(-1)![0]).toEqual({ id: 2, ioId: 1, ok: false });
  worker.answer({ id: 2, ok: false, code: "unavailable" }); await expect(pending).rejects.toMatchObject({ code: "unavailable" });
});
it("download consumption is sequential and erases transient plaintext on acknowledgement", async () => {
  await open(); const bytes = new Uint8Array([42, 43]); const saved: Uint8Array[] = [];
  const pending = session.decryptFile(manifest, { read: async () => new Uint8Array(18), consume: async (_index, bytes) => { saved.push(bytes.slice()); } });
  worker.answer({ id: 2, ioId: 1, io: { operation: "read", index: 0 } }); await flush();
  worker.answer({ id: 2, ioId: 2, io: { operation: "consume", index: 0, bytes } }); await flush();
  expect(bytes).toEqual(new Uint8Array(2)); expect(saved[0]).toEqual(new Uint8Array([42, 43]));
  worker.answer({ id: 2, ok: true, result: null }); await pending;
});
it("abort cancels in-flight I/O, destroys the key worker and erases plaintext even if the consumer never returns", async () => {
  await open(); const controller = new AbortController(); const bytes = new Uint8Array([42, 43]); let ioSignal!: AbortSignal;
  const pending = session.decryptFile(manifest, { read: async () => new Uint8Array(18), consume: async (_index, _bytes, signal) => { ioSignal = signal; await new Promise(() => {}); } }, controller.signal);
  const rejection = expect(pending).rejects.toMatchObject({ code: "aborted" });
  worker.answer({ id: 2, ioId: 1, io: { operation: "read", index: 0 } }); await flush();
  worker.answer({ id: 2, ioId: 2, io: { operation: "consume", index: 0, bytes } }); await flush();
  controller.abort(); await rejection;
  expect(ioSignal.aborted).toBe(true); expect(bytes).toEqual(new Uint8Array(2)); expect(worker.terminate).toHaveBeenCalledTimes(1);
});
it("a stalled file callback times out and cannot deliver a late acknowledgement", async () => {
  vi.useFakeTimers(); await open(); let finish!: () => void;
  const pending = session.encryptFile(new Blob([]), "s", "x", { begin: () => new Promise<void>((resolve) => { finish = resolve; }), write: async () => {} });
  const rejection = expect(pending).rejects.toMatchObject({ code: "unavailable" });
  worker.answer({ id: 2, ioId: 1, io: { operation: "begin", descriptor: manifest } }); await flush();
  vi.advanceTimersByTime(30_000); await rejection; const count = worker.postMessage.mock.calls.length;
  finish(); await flush(); expect(worker.postMessage).toHaveBeenCalledTimes(count);
});
it("rejects a second I/O request before the first was acknowledged", async () => {
  await open(); const pending = session.encryptFile(new Blob([]), "s", "x", { begin: async () => { await new Promise(() => {}); }, write: async () => {} });
  const rejection = expect(pending).rejects.toMatchObject({ code: "unavailable" });
  worker.answer({ id: 2, ioId: 1, io: { operation: "begin", descriptor: manifest } });
  worker.answer({ id: 2, ioId: 2, io: { operation: "write", index: 0, bytes: new Uint8Array(16) } });
  await rejection; expect(worker.terminate).toHaveBeenCalledTimes(1);
});
