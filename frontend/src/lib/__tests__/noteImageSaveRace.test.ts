import { describe, expect, it, vi } from "vitest";
import { LatestOnlyVersionedSaveQueue } from "@/lib/latestOnlyVersionedSaveQueue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const IMAGE_SRC = "/api/attachments/123e4567-e89b-42d3-a456-426614174216";

function tiptapBody(text: string, withImage: boolean): string {
  return JSON.stringify({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text }] },
      ...(withImage ? [{ type: "image", attrs: { src: IMAGE_SRC } }] : []),
    ],
  });
}

describe("note image persistence save races", () => {
  it("Case 4: an older in-flight autosave cannot overwrite the latest image + text snapshot", async () => {
    const first = deferred<{ version: number }>();
    const second = deferred<{ version: number }>();
    const secondStarted = deferred<void>();
    const writes: Array<{ content: string; version: number }> = [];

    const send = vi.fn(async (
      _noteId: string,
      payload: { content: string },
      version: number,
    ) => {
      writes.push({ content: payload.content, version });
      if (writes.length === 2) secondStarted.resolve();
      return writes.length === 1 ? first.promise : second.promise;
    });

    const queue = new LatestOnlyVersionedSaveQueue(
      send,
      (previous, next) => ({ ...previous, ...next }),
    );

    const oldSave = queue.enqueue({
      key: "note-1",
      baseVersion: 10,
      payload: { content: tiptapBody("before upload", false) },
    });
    const imageSave = queue.enqueue({
      key: "note-1",
      baseVersion: 10,
      payload: { content: tiptapBody("after upload", true) },
    });
    const latestSave = queue.enqueue({
      key: "note-1",
      baseVersion: 10,
      payload: { content: tiptapBody("after upload + fast edit", true) },
    });

    expect(writes).toHaveLength(1);
    expect(writes[0].content).not.toContain(IMAGE_SRC);

    first.resolve({ version: 11 });
    await secondStarted.promise;

    expect(writes).toHaveLength(2);
    expect(writes[1].version).toBe(11);
    expect(writes[1].content).toContain(IMAGE_SRC);
    expect(writes[1].content).toContain("after upload + fast edit");

    second.resolve({ version: 12 });
    const results = await Promise.all([oldSave, imageSave, latestSave]);
    expect(results.every((result) => result.result.version === 12)).toBe(true);
    expect(results.every((result) => result.payload.content.includes(IMAGE_SRC))).toBe(true);
    expect(results.every((result) => result.payload.content.includes("after upload + fast edit"))).toBe(true);
  });
});
