import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NOTE_LOADING_DELAY_MS,
  NOTE_LOADING_MIN_VISIBLE_MS,
  NOTE_LOADING_TIMEOUT_MS,
  NoteLoadCoordinator,
  type NoteLoadSink,
} from "@/lib/noteLoadCoordinator";

function createSink() {
  const events: string[] = [];
  const sink: NoteLoadSink = {
    begin: ({ requestId }) => events.push(`begin:${requestId}`),
    show: (requestId) => events.push(`show:${requestId}`),
    markSlow: (requestId) => events.push(`slow:${requestId}`),
    finish: (requestId) => events.push(`finish:${requestId}`),
    fail: (requestId, error) => events.push(`fail:${requestId}:${error}`),
  };
  return { events, sink };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("NoteLoadCoordinator", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps fast requests invisible", async () => {
    vi.useFakeTimers();
    const coordinator = new NoteLoadCoordinator();
    const { events, sink } = createSink();
    const onSuccess = vi.fn();

    const resultPromise = coordinator.run({
      noteId: "fast",
      summary: { title: "Fast", notebookId: "nb" },
      sink,
      request: async () => "ok",
      onSuccess,
    });
    await flushMicrotasks();
    const result = await resultPromise;

    expect(result.status).toBe("success");
    expect(events).toEqual(["begin:1", "finish:1"]);
    expect(onSuccess).toHaveBeenCalledWith("ok");
  });

  it("shows a delayed skeleton and keeps it visible long enough", async () => {
    vi.useFakeTimers();
    const coordinator = new NoteLoadCoordinator();
    const { events, sink } = createSink();
    const request = deferred<string>();

    const resultPromise = coordinator.run({
      noteId: "slow",
      summary: { title: "Slow", notebookId: "nb" },
      sink,
      request: () => request.promise,
      onSuccess: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(NOTE_LOADING_DELAY_MS);
    expect(events).toContain("show:1");
    request.resolve("ok");
    await flushMicrotasks();
    expect(events).not.toContain("finish:1");

    await vi.advanceTimersByTimeAsync(NOTE_LOADING_MIN_VISIBLE_MS);
    await resultPromise;
    expect(events.at(-1)).toBe("finish:1");
  });

  it("allows only the latest request to apply", async () => {
    vi.useFakeTimers();
    const coordinator = new NoteLoadCoordinator();
    const first = createSink();
    const second = createSink();
    const firstRequest = deferred<string>();

    const firstSuccess = vi.fn();
    const firstPromise = coordinator.run({
      noteId: "first",
      summary: { title: "First", notebookId: "nb" },
      sink: first.sink,
      request: () => firstRequest.promise,
      onSuccess: firstSuccess,
    });
    const secondPromise = coordinator.run({
      noteId: "second",
      summary: { title: "Second", notebookId: "nb" },
      sink: second.sink,
      request: async () => "second",
      onSuccess: vi.fn(),
    });

    firstRequest.resolve("first");
    await flushMicrotasks();
    expect((await firstPromise).status).toBe("cancelled");
    expect((await secondPromise).status).toBe("success");
    expect(firstSuccess).not.toHaveBeenCalled();
  });

  it("keeps failures visible and retries the same request", async () => {
    vi.useFakeTimers();
    const coordinator = new NoteLoadCoordinator();
    const { events, sink } = createSink();
    const request = vi.fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce("ok");
    const onSuccess = vi.fn();

    const first = await coordinator.run({
      noteId: "retry",
      summary: { title: "Retry", notebookId: "nb" },
      sink,
      request,
      onSuccess,
    });
    expect(first.status).toBe("error");
    expect(events.some((event) => event.includes("network down"))).toBe(true);

    const retryPromise = coordinator.retry();
    await flushMicrotasks();
    const retried = await retryPromise;
    expect(retried?.status).toBe("success");
    expect(request).toHaveBeenCalledTimes(2);
    expect(onSuccess).toHaveBeenCalledWith("ok");
  });

  it("turns a hanging request into a retryable timeout error", async () => {
    vi.useFakeTimers();
    const coordinator = new NoteLoadCoordinator();
    const { events, sink } = createSink();

    const resultPromise = coordinator.run({
      noteId: "timeout",
      summary: { title: "Timeout", notebookId: "nb" },
      sink,
      request: () => new Promise(() => undefined),
      onSuccess: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(NOTE_LOADING_TIMEOUT_MS);
    const result = await resultPromise;

    expect(result.status).toBe("error");
    expect(events.some((event) => event.includes("加载超时"))).toBe(true);
  });
});
