import { afterEach, describe, expect, it, vi } from "vitest";

import { analyzeMarkdown } from "@/lib/markdownAnalysis";
import { createMarkdownAnalysisController } from "@/lib/markdownAnalysisClient";

class FakeWorker {
  onmessage: ((event: MessageEvent<any>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  messages: Array<{ requestId: number; markdown: string }> = [];
  terminated = false;

  postMessage(message: { requestId: number; markdown: string }) {
    this.messages.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  respond(requestId: number, markdown: string) {
    this.onmessage?.({
      data: { requestId, result: analyzeMarkdown(markdown) },
    } as MessageEvent);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Markdown analysis controller", () => {
  it("publishes only the latest response when worker results arrive out of order", () => {
    const worker = new FakeWorker();
    const published: number[] = [];
    const controller = createMarkdownAnalysisController({
      workerFactory: () => worker,
      onResult: ({ requestId }) => published.push(requestId),
    });

    const first = controller.analyze("# first");
    const second = controller.analyze("# second");
    worker.respond(first, "# first");
    worker.respond(second, "# second");

    expect(published).toEqual([second]);
    controller.destroy();
    expect(worker.terminated).toBe(true);
  });

  it("falls back to delayed local analysis when Worker is unavailable", async () => {
    vi.useFakeTimers();
    const results: string[] = [];
    const controller = createMarkdownAnalysisController({
      workerFactory: () => null,
      fallbackDelayMs: 10,
      onResult: ({ result }) => results.push(result.plainText),
    });

    controller.analyze("# Offline fallback");
    expect(results).toEqual([]);
    await vi.advanceTimersByTimeAsync(10);
    expect(results).toEqual(["Offline fallback"]);
    controller.destroy();
  });

  it("cancels pending fallback work when destroyed", async () => {
    vi.useFakeTimers();
    const onResult = vi.fn();
    const controller = createMarkdownAnalysisController({
      workerFactory: () => null,
      fallbackDelayMs: 10,
      onResult,
    });

    controller.analyze("pending");
    controller.destroy();
    await vi.runAllTimersAsync();
    expect(onResult).not.toHaveBeenCalled();
  });
});
