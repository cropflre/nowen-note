import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const mocks = vi.hoisted(() => ({
  registerPlugin: vi.fn(),
  video: vi.fn(),
  photo: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({ registerPlugin: mocks.registerPlugin }));

const slot = Symbol.for("nowen.nativeAttachmentMediaPlugin");

describe("AttachmentMedia native plugin registration", () => {
  beforeEach(() => {
    delete (globalThis as unknown as Record<symbol, unknown>)[slot];
    mocks.registerPlugin.mockReset();
    mocks.registerPlugin.mockReturnValue({ prepare: mocks.video, preparePhoto: mocks.photo });
    vi.resetModules();
  });

  afterEach(() => {
    delete (globalThis as unknown as Record<symbol, unknown>)[slot];
    vi.restoreAllMocks();
  });

  it("registers once across separate imports and Vite HMR module re-evaluation", async () => {
    const first = await import("@/lib/attachmentMediaPlugin");
    expect(mocks.registerPlugin).toHaveBeenCalledTimes(1);
    expect(mocks.registerPlugin).toHaveBeenCalledWith("AttachmentMedia");
    await first.attachmentMediaPlugin.prepare({ attachmentId: "id", url: "https://example.test/a" });
    await first.attachmentMediaPlugin.preparePhoto({ attachmentId: "id", uri: "file://test" });
    vi.resetModules();
    const afterHotReload = await import("@/lib/attachmentMediaPlugin");
    expect(afterHotReload.attachmentMediaPlugin).toBe(first.attachmentMediaPlugin);
    expect(mocks.registerPlugin).toHaveBeenCalledTimes(1);
  });

  it("has no independent registration in photo and video renderers", () => {
    const photoSource = readFileSync(resolve(process.cwd(), "src/lib/nativeAttachmentStore.ts"), "utf8");
    const videoSource = readFileSync(resolve(process.cwd(), "src/hooks/useAttachmentVideoRenderSource.ts"), "utf8");
    for (const source of [photoSource, videoSource]) {
      expect(source).toContain("attachmentMediaPlugin as AttachmentMedia");
      expect(source).not.toContain("registerPlugin<");
    }
  });
});
