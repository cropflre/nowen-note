import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeTiptapDocument } from "@/lib/tiptapAnalysis";
import { createTiptapAnalysisController } from "@/lib/tiptapAnalysisClient";

class FakeWorker {
  onmessage: ((event: MessageEvent<any>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  messages: any[] = [];
  terminated = false;
  postMessage(message: any) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  respond(message: any) {
    this.onmessage?.({ data: { requestId: message.requestId, result: analyzeTiptapDocument(message.doc) } } as MessageEvent);
  }
  fail(message: string) {
    this.onerror?.({ message } as ErrorEvent);
  }
}

afterEach(() => { vi.useRealTimers(); });

describe("Tiptap analysis controller", () => {
  it("publishes only the newest worker result", () => {
    const worker = new FakeWorker();
    const published: number[] = [];
    const controller = createTiptapAnalysisController({
      workerFactory: () => worker,
      onResult: ({ requestId }) => published.push(requestId),
    });
    const first = controller.analyze({ type: "doc" });
    const second = controller.analyze({ type: "doc", content: [{ type: "paragraph" }] });
    worker.respond(worker.messages[0]);
    worker.respond(worker.messages[1]);
    expect(published).toEqual([second]);
    expect(first).not.toBe(second);
    controller.destroy();
    expect(worker.terminated).toBe(true);
  });

  it("falls back to the newest document when a worker fails to execute", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const onResult = vi.fn();
    const onError = vi.fn();
    const controller = createTiptapAnalysisController({
      workerFactory: () => worker,
      fallbackDelayMs: 32,
      onResult,
      onError,
    });
    controller.analyze({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "old" }] }] });
    const latest = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "latest" }] }] };
    const requestId = controller.analyze(latest);
    worker.fail("Cannot use import statement outside a module");
    expect(worker.terminated).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(32);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith({ requestId, result: analyzeTiptapDocument(latest) });
    controller.destroy();
  });

  it("cancels delayed fallback work on destroy", async () => {
    vi.useFakeTimers();
    const onResult = vi.fn();
    const controller = createTiptapAnalysisController({ workerFactory: () => null, onResult });
    controller.analyze({ type: "doc" });
    controller.destroy();
    await vi.runAllTimersAsync();
    expect(onResult).not.toHaveBeenCalled();
  });
});
