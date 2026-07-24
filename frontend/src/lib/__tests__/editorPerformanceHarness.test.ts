import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEditorPerformancePlatformAdapter,
  installEditorPerformanceGlobal,
  runEditorPerformanceScenario,
  type EditorPerformanceHarnessDriver,
  type EditorPerformanceMemoryAdapter,
} from "@/lib/editorPerformanceHarness";
import type { EditorPerformanceLifecycleSnapshot } from "@/lib/editorPerformanceProtocol";

class SupportedPerformanceObserver {
  static supportedEntryTypes = ["longtask"];
  constructor(private readonly callback: PerformanceObserverCallback) {}
  observe() {
    this.callback({
      getEntries: () => [{ duration: 42 }],
    } as PerformanceObserverEntryList, this as unknown as PerformanceObserver);
  }
  disconnect() {}
}

function createMemoryAdapter(values = [100, 110, 115, 105]): EditorPerformanceMemoryAdapter {
  const remaining = [...values];
  return {
    async getMemoryMetrics() {
      return { heapBytes: remaining.shift() } as { heapBytes: number };
    },
  };
}

function createDriver(options: {
  now: { value: number };
  lifecycle?: EditorPerformanceLifecycleSnapshot[];
}) {
  const calls: string[] = [];
  let domNodes = 80;
  let nodeViews = 4;
  const lifecycle = [...(options.lifecycle || [{ workers: 0, nodeViews: 0, mediaRequests: 0 }])];
  const driver: EditorPerformanceHarnessDriver = {
    async openScenario(scenario) {
      calls.push(`open:${scenario}`);
      options.now.value += 10;
      domNodes = 100;
      nodeViews = 6;
    },
    async waitUntilInteractive() {
      calls.push("interactive");
      options.now.value += 15;
    },
    async performInput(index) {
      calls.push(`input:${index}`);
      options.now.value += 4;
      domNodes = Math.max(domNodes, 120 + index);
      nodeViews = Math.max(nodeViews, 8 + index);
    },
    async scrollToEnd() {
      calls.push("scroll");
      options.now.value += 7;
      domNodes = 180;
      nodeViews = 12;
    },
    async switchNote(index) {
      calls.push(`switch:${index}`);
      options.now.value += 3;
      domNodes = 200 + index;
      nodeViews = 14;
    },
    async closeScenario() {
      calls.push("close");
      options.now.value += 2;
      domNodes = 20;
      nodeViews = 0;
    },
    async readDomNodeCount() {
      return domNodes;
    },
    async readNodeViewCount() {
      return nodeViews;
    },
    async readLifecycleSnapshot() {
      const snapshot = lifecycle.shift();
      if (!snapshot) throw new Error("测试生命周期快照不足");
      return snapshot;
    },
  };
  return { driver, calls };
}

describe("editor performance executable harness", () => {
  beforeEach(() => {
    vi.stubGlobal("PerformanceObserver", SupportedPerformanceObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete window.__NOWEN_EDITOR_PERF__;
  });

  it("orchestrates a regular scenario without defaulting required metrics", async () => {
    const now = { value: 0 };
    const { driver, calls } = createDriver({ now });
    const run = await runEditorPerformanceScenario({
      platform: "web",
      scenario: "tiptap-20000",
      driver,
      memoryAdapter: createMemoryAdapter(),
      inputSampleCount: 3,
      clock: () => now.value,
    });

    expect(calls).toEqual([
      "open:tiptap-20000",
      "interactive",
      "input:0",
      "input:1",
      "input:2",
      "scroll",
      "close",
    ]);
    expect(run).toMatchObject({
      platform: "web",
      scenario: "tiptap-20000",
      firstInteractiveMs: 25,
      inputLatencyMs: [4, 4, 4],
      longTaskMs: [42],
      longTaskObservationSupported: true,
      peakDomNodes: 180,
      peakNodeViews: 12,
      heapBeforeBytes: 100,
      heapOpenedBytes: 110,
      heapScrolledBytes: 115,
      heapAfterBytes: 105,
      activeWorkersAfterClose: 0,
      activeNodeViewsAfterClose: 0,
      activeMediaRequestsAfterClose: 0,
    });
  });

  it("executes exactly 20 timed switches with 20 lifecycle snapshots", async () => {
    const now = { value: 0 };
    const lifecycle = Array.from({ length: 22 }, () => ({ workers: 0, nodeViews: 0, mediaRequests: 0 }));
    const { driver, calls } = createDriver({ now, lifecycle });
    const run = await runEditorPerformanceScenario({
      platform: "electron",
      scenario: "switch-20-and-close",
      driver,
      memoryAdapter: createMemoryAdapter(),
      inputSampleCount: 1,
      clock: () => now.value,
    });

    expect(calls.filter((call) => call.startsWith("switch:"))).toEqual(
      Array.from({ length: 20 }, (_, index) => `switch:${index}`),
    );
    expect(run.noteSwitchMs).toEqual(Array(20).fill(3));
    expect(run.lifecycleSnapshots).toHaveLength(20);
    expect(run.lifecycleBaseline).toEqual({ workers: 0, nodeViews: 0, mediaRequests: 0 });
  });

  it("closes once after an opened scenario fails and preserves the collection error", async () => {
    const now = { value: 0 };
    const { driver, calls } = createDriver({ now });
    driver.performInput = async () => {
      calls.push("input:failed");
      throw new Error("input collection failed");
    };
    driver.closeScenario = async () => {
      calls.push("close");
      throw new Error("cleanup close failed");
    };

    await expect(runEditorPerformanceScenario({
      platform: "web",
      scenario: "tiptap-20000",
      driver,
      memoryAdapter: createMemoryAdapter(),
      inputSampleCount: 1,
      clock: () => now.value,
    })).rejects.toThrow("input collection failed");
    expect(calls.filter((call) => call === "close")).toHaveLength(1);
  });

  it("fails closed for missing driver capabilities and metrics", async () => {
    const now = { value: 0 };
    const { driver, calls } = createDriver({ now });
    delete (driver as Partial<EditorPerformanceHarnessDriver>).scrollToEnd;
    await expect(runEditorPerformanceScenario({
      platform: "web",
      scenario: "tiptap-20000",
      driver,
      memoryAdapter: createMemoryAdapter(),
      inputSampleCount: 1,
      clock: () => now.value,
    })).rejects.toThrow("driver.scrollToEnd is required");
    expect(calls).toEqual([]);

    const valid = createDriver({ now }).driver;
    await expect(runEditorPerformanceScenario({
      platform: "web",
      scenario: "tiptap-20000",
      driver: valid,
      memoryAdapter: { async getMemoryMetrics() { return {} as { heapBytes: number }; } },
      inputSampleCount: 1,
      clock: () => now.value,
    })).rejects.toThrow("heapBytes is missing or invalid");
  });

  it("fails closed when Long Task observation is unavailable", async () => {
    vi.stubGlobal("PerformanceObserver", undefined);
    const now = { value: 0 };
    const { driver } = createDriver({ now });
    await expect(runEditorPerformanceScenario({
      platform: "web",
      scenario: "tiptap-20000",
      driver,
      memoryAdapter: createMemoryAdapter(),
      inputSampleCount: 1,
      clock: () => now.value,
    })).rejects.toThrow("Long Task observation is unavailable");
  });

  it("resolves Web, Electron and Android memory adapters and rejects missing bridges", async () => {
    const webTarget = { performance: { memory: { usedJSHeapSize: 123 } } };
    await expect(createEditorPerformancePlatformAdapter("web", webTarget).getMemoryMetrics())
      .resolves.toEqual({ heapBytes: 123 });

    const electronTarget = {
      nowenDesktop: { async getEditorPerformanceMetrics() { return { heapBytes: 456 }; } },
    };
    await expect(createEditorPerformancePlatformAdapter("electron", electronTarget).getMemoryMetrics())
      .resolves.toEqual({ heapBytes: 456 });

    const androidTarget = {
      Capacitor: { Plugins: { EditorPerformance: { async getMemoryMetrics() { return { heapBytes: 789 }; } } } },
    };
    await expect(createEditorPerformancePlatformAdapter("android", androidTarget).getMemoryMetrics())
      .resolves.toEqual({ heapBytes: 789 });

    await expect(createEditorPerformancePlatformAdapter("web", { performance: {} }).getMemoryMetrics())
      .rejects.toThrow("performance.memory.usedJSHeapSize is unavailable");
    await expect(createEditorPerformancePlatformAdapter("electron", {}).getMemoryMetrics())
      .rejects.toThrow("nowenDesktop.getEditorPerformanceMetrics is unavailable");
    await expect(createEditorPerformancePlatformAdapter("android", {}).getMemoryMetrics())
      .rejects.toThrow("Capacitor.Plugins.EditorPerformance.getMemoryMetrics is unavailable");
  });

  it("installs an explicit global entry without running a scenario automatically", async () => {
    delete window.__NOWEN_EDITOR_PERF__;
    const now = { value: 0 };
    const { driver, calls } = createDriver({ now });
    installEditorPerformanceGlobal(window);
    expect(window.__NOWEN_EDITOR_PERF__).toBeTypeOf("function");
    expect(calls).toEqual([]);

    const run = await window.__NOWEN_EDITOR_PERF__!({
      platform: "web",
      scenario: "tiptap-20000",
      driver,
      memoryAdapter: createMemoryAdapter(),
      inputSampleCount: 1,
      clock: () => now.value,
    });
    expect(run.scenario).toBe("tiptap-20000");
    expect(calls).not.toEqual([]);
  });
});
