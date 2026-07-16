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

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("LatestOnlyVersionedSaveQueue", () => {
  it("serializes one note, coalesces pending snapshots and chains ACK versions", async () => {
    const first = deferred<{ version: number }>();
    const second = deferred<{ version: number }>();
    const calls: Array<{ payload: { content?: string; title?: string }; version: number }> = [];
    let concurrent = 0;
    let maxConcurrent = 0;

    const send = vi.fn(async (
      _noteId: string,
      payload: { content?: string; title?: string },
      version: number,
    ) => {
      calls.push({ payload, version });
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
    await flushMicrotasks();
    const p2 = queue.enqueue({ key: "n1", baseVersion: 10, payload: { content: "B" } });
    const p3 = queue.enqueue({ key: "n1", baseVersion: 10, payload: { title: "new" } });

    expect(calls).toEqual([{ payload: { content: "A", title: "old" }, version: 10 }]);
    first.resolve({ version: 11 });
    await flushMicrotasks();

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
    let concurrent = 0;
    let maxConcurrent = 0;
    const queue = new LatestOnlyVersionedSaveQueue<string, { version: number }>(
      async (noteId) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        const gate = deferred<{ version: number }>();
        gates.set(noteId, gate);
        try {
          return await gate.promise;
        } finally {
          concurrent -= 1;
        }
      },
    );

    const p1 = queue.enqueue({ key: "n1", baseVersion: 1, payload: "one" });
    const p2 = queue.enqueue({ key: "n2", baseVersion: 7, payload: "two" });
    await flushMicrotasks();

    expect(maxConcurrent).toBe(2);
    gates.get("n1")!.resolve({ version: 2 });
    gates.get("n2")!.resolve({ version: 8 });
    await Promise.all([p1, p2]);
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
