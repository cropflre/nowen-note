import { describe, expect, it, vi } from "vitest";

import { createFragmentSnapshotCache } from "@/lib/proseMirrorPlainTextRuntime";

describe("ProseMirror plain-text runtime cache", () => {
  it("derives one immutable fragment only once", () => {
    const derive = vi.fn((value: { text: string }) => value.text.toUpperCase());
    const read = createFragmentSnapshotCache(derive);
    const fragment = { text: "alpha" };

    expect(read(fragment)).toBe("ALPHA");
    expect(read(fragment)).toBe("ALPHA");
    expect(derive).toHaveBeenCalledTimes(1);
  });

  it("does not merge structurally equal but distinct document versions", () => {
    const derive = vi.fn((value: { text: string }) => value.text);
    const read = createFragmentSnapshotCache(derive);

    expect(read({ text: "same" })).toBe("same");
    expect(read({ text: "same" })).toBe("same");
    expect(derive).toHaveBeenCalledTimes(2);
  });

  it("also caches undefined results by identity", () => {
    const derive = vi.fn(() => undefined);
    const read = createFragmentSnapshotCache<object, undefined>(derive);
    const fragment = {};

    expect(read(fragment)).toBeUndefined();
    expect(read(fragment)).toBeUndefined();
    expect(derive).toHaveBeenCalledTimes(1);
  });
});
