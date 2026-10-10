// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEncryptedContentOperation } from "../workerClient";
import type { CryptoRequest, CryptoResponse } from "../protocol";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: { data: CryptoResponse }) => void) | null = null;
  onerror: ((event: { preventDefault: () => void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
}
const request: CryptoRequest & { operation: "decrypt" } = {
  operation: "decrypt", input: { envelope: {}, passphrase: "private test password", expected: { objectId: "00112233-4455-4677-8899-aabbccddeeff", kind: "note", originalFormat: "markdown" } },
};
beforeEach(() => { FakeWorker.instances = []; vi.stubGlobal("Worker", FakeWorker); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("encrypted content worker boundaries", () => {
  it("terminates after a result and uses a fresh worker for the next operation", async () => {
    const first = runEncryptedContentOperation(request);
    const worker = FakeWorker.instances[0];
    worker.onmessage!({ data: { ok: true, result: "decoded" } });
    await expect(first).resolves.toBe("decoded");
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.onmessage).toBeNull();
    const second = runEncryptedContentOperation(request);
    expect(FakeWorker.instances).toHaveLength(2);
    FakeWorker.instances[1].onmessage!({ data: { ok: false, code: "unlock-failed" } });
    await expect(second).rejects.toMatchObject({ code: "unlock-failed" });
  });

  it("prevents concurrent memory-heavy KDF jobs and aborts by terminating the worker", async () => {
    const controller = new AbortController();
    const pending = runEncryptedContentOperation(request, controller.signal);
    await expect(runEncryptedContentOperation(request)).rejects.toMatchObject({ code: "busy" });
    const rejection = expect(pending).rejects.toMatchObject({ code: "aborted" });
    controller.abort();
    await rejection;
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
  });

  it.each(["unavailable", "construction", "post", "error", "messageerror", "timeout"])("fails closed on %s without a main-thread fallback or source disclosure", async (scenario) => {
    vi.useFakeTimers();
    if (scenario === "unavailable") vi.stubGlobal("Worker", undefined);
    if (scenario === "construction") vi.stubGlobal("Worker", class { constructor() { throw new Error(request.input.passphrase); } });
    // Override the instance post method by subclassing before construction.
    if (scenario === "post") vi.stubGlobal("Worker", class extends FakeWorker {
      constructor() { super(); this.postMessage.mockImplementation(() => { throw new Error(request.input.passphrase); }); }
    });
    const pending = runEncryptedContentOperation(request);
    const rejection = expect(pending).rejects.toMatchObject({ code: "unavailable", message: "Encrypted content: unavailable" });
    const worker = FakeWorker.instances[0];
    if (scenario === "error") worker.onerror!({ preventDefault: vi.fn() });
    if (scenario === "messageerror") worker.onmessageerror!();
    if (scenario === "timeout") vi.advanceTimersByTime(30_000);
    await rejection;
    if (worker) expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("does not start a job that was already cancelled", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(runEncryptedContentOperation(request, controller.signal)).rejects.toMatchObject({ code: "aborted" });
    expect(FakeWorker.instances).toHaveLength(0);
  });
});
