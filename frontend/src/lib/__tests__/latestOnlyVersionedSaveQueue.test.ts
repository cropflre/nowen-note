import { describe, expect, it, vi } from "vitest";
import { LatestOnlyVersionedSaveQueue } from "../latestOnlyVersionedSaveQueue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("LatestOnlyVersionedSaveQueue", () => {
  it("serializes one note, coalesces pending snapshots and chains ACK versions", async () => {
    const first = deferred<{ version: number }>();
    const second = deferred<{ version: number }>();
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const calls: Array<{ payload: { content?: string; title?: string }; version: number }> = [];
    let concurrent = 0;
    let maxConcurrent = 0;

    const send = vi.fn(async (
      _noteId: string,
      payload: { content?: string; title?: string },
      version: number,
    ) => {
      calls.push({ payload, version });
      if (calls.length === 1) firstStarted.resolve();
      if (calls.length === 2) secondStarted.resolve();
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      try {
        return await (calls.length === 1 ? first.promise : second.promise);
      } finally {
        concurrent -= 1;
      }
    });

    const queue = new LatestOnlyVersionedSaveQueue(
      send,
      (previous, next) => ({ ...previous, ...next }),
    );
    const p1 = queue.enqueue({ key: "n1", baseVersion: 10, payload: { content: "A", title: "old" } });
    await firstStarted.promise;
    const p2 = queue.enqueue({ key: "n1", baseVersion: 10, payload: { content: "B" } });
    const p3 = queue.enqueue({ key: "n1", baseVersion: 10, payload: { title: "new" } });

    expect(calls).toEqual([{ payload: { content: "A", title: "old" }, version: 10 }]);
    first.resolve({ version: 11 });
    await secondStarted.promise;

    expect(calls).toEqual([
      { payload: { content: "A", title: "old" }, version: 10 },
      { payload: { content: "B", title: "new" }, version: 11 },
    ]);
    expect(maxConcurrent).toBe(1);

    second.resolve({ version: 12 });
    const results = await Promise.all([p1, p2, p3]);
    expect(results.map((item) => item.payload)).toEqual([
      { content: "B", title: "new" },
      { content: "B", title: "new" },
      { content: "B", title: "new" },
    ]);
    expect(results.map((item) => item.result.version)).toEqual([12, 12, 12]);
    expect(queue.getConfirmedVersion("n1")).toBe(12);
  });

  it("allows different notes to save independently", async () => {
    const gates = new Map<string, ReturnType<typeof deferred<{ version: number }>>>();
    const bothStarted = deferred<void>();
    let concurrent = 0;
    let maxConcurrent = 0;
    const queue = new LatestOnlyVersionedSaveQueue<string, { version: number }>(
      async (noteId) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        const gate = deferred<{ version: number }>();
        gates.set(noteId, gate);
        if (gates.size === 2) bothStarted.resolve();
        try {
          return await gate.promise;
        } finally {
          concurrent -= 1;
        }
      },
    );

    const p1 = queue.enqueue({ key: "n1", baseVersion: 1, payload: "one" });
    const p2 = queue.enqueue({ key: "n2", baseVersion: 7, payload: "two" });
    await bothStarted.promise;

    expect(maxConcurrent).toBe(2);
    gates.get("n1")!.resolve({ version: 2 });
    gates.get("n2")!.resolve({ version: 8 });
    await Promise.all([p1, p2]);
  });

  it("rejects the in-flight and pending batches without advancing the confirmed version", async () => {
    const first = deferred<{ version: number }>();
    const firstStarted = deferred<void>();
    let calls = 0;
    const queue = new LatestOnlyVersionedSaveQueue<string, { version: number }>(
      async () => {
        calls += 1;
        firstStarted.resolve();
        return first.promise;
      },
    );

    const p1 = queue.enqueue({ key: "n1", baseVersion: 5, payload: "first" });
    await firstStarted.promise;
    const p2 = queue.enqueue({ key: "n1", baseVersion: 5, payload: "latest" });
    const resultsPromise = Promise.allSettled([p1, p2]);
    first.reject(Object.assign(new Error("conflict"), { code: "VERSION_CONFLICT" }));

    const results = await resultsPromise;
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(calls).toBe(1);
    expect(queue.getConfirmedVersion("n1")).toBe(5);
  });

  it("rejects unconfirmed writes instead of reporting them as saved", async () => {
    const queue = new LatestOnlyVersionedSaveQueue<string, { version: number }>(
      async (_noteId, _payload, version) => ({ version }),
    );

    await expect(queue.enqueue({ key: "n1", baseVersion: 4, payload: "draft" }))
      .rejects.toMatchObject({ code: "SAVE_NOT_CONFIRMED", saveBaseVersion: 4 });
  });

  it("accepts a newer base after a real conflict is resolved", async () => {
    let fail = true;
    const calls: number[] = [];
    const queue = new LatestOnlyVersionedSaveQueue<string, { version: number }>(
      async (_noteId, _payload, version) => {
        calls.push(version);
        if (fail) throw Object.assign(new Error("conflict"), { code: "VERSION_CONFLICT" });
        return { version: version + 1 };
      },
    );

    await expect(queue.enqueue({ key: "n1", baseVersion: 2, payload: "old" }))
      .rejects.toMatchObject({ code: "VERSION_CONFLICT", saveBaseVersion: 2 });

    fail = false;
    await expect(queue.enqueue({ key: "n1", baseVersion: 9, payload: "resolved" }))
      .resolves.toMatchObject({ baseVersion: 9, result: { version: 10 } });
    expect(calls).toEqual([2, 9]);
  });
});
