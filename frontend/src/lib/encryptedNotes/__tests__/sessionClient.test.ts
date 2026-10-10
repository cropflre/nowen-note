// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fixture from "./fixtures/envelope-v1.json";
import { validateEnvelope } from "../envelope";
import { EncryptedContentSession } from "../sessionClient";
import { runEncryptedContentOperation } from "../workerClient";
import type { SessionResponse } from "../sessionProtocol";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: { data: SessionResponse }) => void) | null = null;
  onerror: ((event: { preventDefault: () => void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn(); terminate = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
  answer(result: SessionResponse) { this.onmessage!({ data: result }); }
}
const envelope = validateEnvelope(fixture.envelope);
let sessions: EncryptedContentSession[];
function makeSession() { const session = new EncryptedContentSession(); sessions.push(session); return session; }
beforeEach(() => { sessions = []; FakeWorker.instances = []; vi.stubGlobal("Worker", FakeWorker); });
afterEach(() => { sessions.forEach((session) => session.close()); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("keeps only a worker handle and performs repeated writes without sending the password", async () => {
  const session = makeSession(); const worker = FakeWorker.instances[0];
  const open = session.open(envelope, fixture.passphrase, envelope);
  worker.answer({ id: 1, ok: true, result: fixture.plaintext }); await expect(open).resolves.toBe(fixture.plaintext);
  for (let id = 2; id <= 3; id++) {
    const update = session.update(envelope, "Changed content");
    worker.answer({ id, ok: true, result: envelope }); await expect(update).resolves.toEqual(envelope);
  }
  expect(FakeWorker.instances).toHaveLength(1);
  expect(worker.terminate).not.toHaveBeenCalled();
  expect(JSON.stringify(worker.postMessage.mock.calls.slice(1))).not.toContain(fixture.passphrase);
  expect(JSON.stringify(session)).not.toContain(fixture.passphrase);
  session.close(); expect(worker.terminate).toHaveBeenCalledTimes(1);
  await expect(session.update(envelope, "Forbidden")).rejects.toMatchObject({ code: "aborted" });
});

it("serializes memory-heavy opens with one-shot KDF jobs and releases the slot after failure", async () => {
  const session = makeSession(); const worker = FakeWorker.instances[0];
  const pending = session.open(envelope, fixture.passphrase, envelope);
  await expect(runEncryptedContentOperation({ operation: "decrypt", input: { envelope, passphrase: fixture.passphrase, expected: envelope } })).rejects.toMatchObject({ code: "busy" });
  worker.answer({ id: 1, ok: false, code: "unlock-failed" });
  await expect(pending).rejects.toMatchObject({ code: "unlock-failed" });
  const second = makeSession(); const next = second.open(envelope, fixture.passphrase, envelope);
  FakeWorker.instances[1].answer({ id: 1, ok: true, result: fixture.plaintext }); await next;
});

it.each(["abort", "timeout", "error", "mismatched-response"])("destroys the session on %s and cannot deliver late plaintext", async (scenario) => {
  vi.useFakeTimers(); const session = makeSession(); const worker = FakeWorker.instances[0];
  const controller = new AbortController(); const open = session.open(envelope, fixture.passphrase, envelope, controller.signal);
  const rejection = expect(open).rejects.toMatchObject({ code: scenario === "abort" ? "aborted" : "unavailable" });
  if (scenario === "abort") controller.abort();
  if (scenario === "timeout") vi.advanceTimersByTime(30_000);
  if (scenario === "error") worker.onerror!({ preventDefault: vi.fn() });
  if (scenario === "mismatched-response") worker.answer({ id: 9, ok: true, result: "Wrong response" });
  await rejection; expect(worker.terminate).toHaveBeenCalledTimes(1); expect(worker.onmessage).toBeNull();
});

it("does not run a competing update and permits an explicit retry after a recoverable failure", async () => {
  const session = makeSession(); const worker = FakeWorker.instances[0];
  const open = session.open(envelope, fixture.passphrase, envelope);
  worker.answer({ id: 1, ok: true, result: fixture.plaintext }); await open;
  const update = session.update(envelope, "First");
  await expect(session.update(envelope, "Second")).rejects.toMatchObject({ code: "busy" });
  worker.answer({ id: 2, ok: false, code: "invalid" }); await expect(update).rejects.toMatchObject({ code: "invalid" });
  const retry = session.update(envelope, "Retry"); worker.answer({ id: 3, ok: true, result: envelope }); await retry;
});
