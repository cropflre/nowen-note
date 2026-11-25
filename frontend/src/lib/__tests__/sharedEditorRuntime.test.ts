import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ steps: [] as string[], install: vi.fn() }));
vi.mock("../coreRuntimeInstallers", () => ({ installCoreRuntime: mocks.install }));

describe("shared editor initialization", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.steps.length = 0;
    mocks.install.mockReset().mockImplementation(() => mocks.steps.push("guards"));
    vi.doMock("../../i18n", () => { mocks.steps.push("i18n"); return {}; });
    vi.doMock("../imageNodeTransformBootstrap", () => { mocks.steps.push("schema"); return {}; });
  });

  it("installs guards and image schema once before resolving editor readiness", async () => {
    const { initializeSharedEditorRuntime } = await import("../sharedEditorRuntime");
    const first = initializeSharedEditorRuntime();
    expect(initializeSharedEditorRuntime()).toBe(first);
    await first;
    expect(mocks.steps).toEqual(["i18n", "guards", "schema"]);
    expect(mocks.install).toHaveBeenCalledOnce();
  });

  it("DCC-004: rejects failed guard loading before a shared editor can mount", async () => {
    mocks.install.mockImplementation(() => { throw new Error("guard loading failed"); });
    const { initializeSharedEditorRuntime } = await import("../sharedEditorRuntime");
    await expect(initializeSharedEditorRuntime()).rejects.toThrow("guard loading failed");
    expect(mocks.steps).toEqual(["i18n"]);
  });
});
