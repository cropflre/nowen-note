import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEditorPerformanceCollector,
  EDITOR_PERFORMANCE_PLATFORMS,
  EDITOR_PERFORMANCE_SCENARIOS,
  evaluateEditorPerformanceMatrix,
  type EditorPerformanceRun,
} from "@/lib/editorPerformanceProtocol";

function passingRun(platform: EditorPerformanceRun["platform"], scenario: EditorPerformanceRun["scenario"]): EditorPerformanceRun {
  const baseline = { workers: 0, nodeViews: 0, mediaRequests: 0 };
  return {
    platform,
    scenario,
    inputLatencyMs: [4, 8, 12],
    longTaskMs: [20],
    longTaskObservationSupported: true,
    peakDomNodes: 1_000,
    peakNodeViews: 30,
    firstInteractiveMs: 50,
    noteSwitchMs: scenario === "switch-20-and-close" ? Array(20).fill(10) : [],
    heapBeforeBytes: 100_000_000,
    heapOpenedBytes: 104_000_000,
    heapScrolledBytes: 108_000_000,
    heapAfterBytes: 110_000_000,
    activeWorkersAfterClose: 0,
    activeNodeViewsAfterClose: 0,
    activeMediaRequestsAfterClose: 0,
    lifecycleBaseline: scenario === "switch-20-and-close" ? baseline : undefined,
    lifecycleSnapshots: scenario === "switch-20-and-close"
      ? Array.from({ length: 20 }, () => ({ ...baseline }))
      : [],
    markdownRenderMatches: scenario === "markdown-2.4mb" ? true : undefined,
    editorMode: "windowed",
    sectionCount: 8,
    peakMountedSections: 3,
  };
}

describe("editor performance sign-off protocol", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requires and accepts the complete 3x9 matrix", () => {
    expect(EDITOR_PERFORMANCE_SCENARIOS).toEqual([
      "markdown-2.4mb",
      "tiptap-20000",
      "tiptap-50000",
      "list-batch-100",
      "media-100",
      "media-500",
      "code-100",
      "code-500",
      "switch-20-and-close",
    ]);
    const runs = EDITOR_PERFORMANCE_PLATFORMS.flatMap((platform) => (
      EDITOR_PERFORMANCE_SCENARIOS.map((scenario) => passingRun(platform, scenario))
    ));
    expect(runs).toHaveLength(27);
    expect(evaluateEditorPerformanceMatrix(runs)).toEqual({ passed: true, missing: [], failed: [] });
    expect(evaluateEditorPerformanceMatrix(runs.slice(1)).missing).toHaveLength(1);
  });

  it("fails closed when protocol-only required fields are missing", () => {
    for (const field of [
      "longTaskObservationSupported",
      "firstInteractiveMs",
      "noteSwitchMs",
      "lifecycleBaseline",
      "lifecycleSnapshots",
      "editorMode",
      "sectionCount",
      "peakMountedSections",
    ] as const) {
      const run = passingRun("web", "switch-20-and-close") as unknown as Record<string, unknown>;
      delete run[field];
      const result = evaluateEditorPerformanceMatrix([run as unknown as EditorPerformanceRun]);
      expect(result.failed[0]?.failures.join("\n")).toContain(field);
    }
  });

  it("fails closed when Long Task observation is unsupported", () => {
    const run = passingRun("web", "tiptap-20000");
    run.longTaskObservationSupported = false;
    const result = evaluateEditorPerformanceMatrix([run]);
    expect(result.failed[0]?.failures).toContain("longTaskObservationSupported must be true");
  });

  it("rejects duplicate platform and scenario keys", () => {
    const runs = EDITOR_PERFORMANCE_PLATFORMS.flatMap((platform) => (
      EDITOR_PERFORMANCE_SCENARIOS.map((scenario) => passingRun(platform, scenario))
    ));
    runs.push(passingRun("web", "markdown-2.4mb"));
    const result = evaluateEditorPerformanceMatrix(runs);
    expect(result.passed).toBe(false);
    expect(result.failed).toContainEqual({
      platform: "web",
      scenario: "markdown-2.4mb",
      failures: ["duplicate platform:scenario run"],
    });
  });

  it.each([
    ["workers", "worker"],
    ["nodeViews", "NodeView"],
    ["mediaRequests", "media request"],
  ] as const)("rejects switch snapshots when %s grows monotonically and never returns", (field, label) => {
    const run = passingRun("electron", "switch-20-and-close");
    run.lifecycleSnapshots = Array.from({ length: 20 }, (_, index) => ({
      workers: 0,
      nodeViews: 0,
      mediaRequests: 0,
      [field]: index + 1,
    }));
    const result = evaluateEditorPerformanceMatrix([run]);
    expect(result.failed[0]?.failures.join("\n")).toContain(label);
  });

  it("rejects a switch resource that fluctuates but does not return to baseline", () => {
    const run = passingRun("android", "switch-20-and-close");
    run.lifecycleSnapshots = Array.from({ length: 20 }, (_, index) => ({
      workers: index % 2 === 0 || index === 19 ? 1 : 0,
      nodeViews: 0,
      mediaRequests: 0,
    }));
    const result = evaluateEditorPerformanceMatrix([run]);
    expect(result.failed[0]?.failures.join("\n")).toContain("worker count did not return to baseline");
  });

  it("collects latency, heap and lifecycle values with a shared clock", () => {
    let now = 10;
    const collector = createEditorPerformanceCollector("electron", "tiptap-20000", () => now);
    const finishInput = collector.inputStarted();
    now = 18;
    finishInput();
    collector.recordHeap("before", 100);
    collector.recordHeap("opened", 110);
    collector.recordHeap("scrolled", 115);
    collector.recordHeap("after", 120);
    collector.recordDomNodes(80);
    collector.recordDomNodes(120);
    collector.recordNodeViews(7);
    collector.recordNodeViews(5);
    collector.recordEditorWindow("windowed", 8, 3);
    collector.recordEditorWindow("windowed", 8, 4);
    collector.recordFirstInteractive(25);
    collector.recordLifecycle(0, 0, 0);
    expect(collector.finish()).toMatchObject({
      inputLatencyMs: [8],
      peakDomNodes: 120,
      peakNodeViews: 7,
      heapBeforeBytes: 100,
      heapOpenedBytes: 110,
      heapScrolledBytes: 115,
      heapAfterBytes: 120,
      activeWorkersAfterClose: 0,
      activeNodeViewsAfterClose: 0,
      activeMediaRequestsAfterClose: 0,
      editorMode: "windowed",
      sectionCount: 8,
      peakMountedSections: 4,
    });
    collector.dispose();
  });

  it("collects exactly 20 switch durations and lifecycle snapshots", () => {
    let now = 0;
    const collector = createEditorPerformanceCollector("web", "switch-20-and-close", () => now);
    collector.recordLifecycleBaseline(0, 0, 0);
    for (let index = 0; index < 20; index += 1) {
      const finishSwitch = collector.noteSwitchStarted();
      now += 5;
      finishSwitch();
      collector.recordSwitchLifecycle(0, 0, 0);
    }
    const run = collector.finish();
    expect(run.noteSwitchMs).toHaveLength(20);
    expect(run.lifecycleSnapshots).toHaveLength(20);
    collector.dispose();
  });

  it("records whether Long Task observation is actually supported", () => {
    vi.stubGlobal("PerformanceObserver", undefined);
    const unsupported = createEditorPerformanceCollector("web", "tiptap-20000");
    expect(unsupported.finish().longTaskObservationSupported).toBe(false);
    unsupported.dispose();

    vi.stubGlobal("PerformanceObserver", class {
      observe() { throw new Error("longtask unsupported"); }
      disconnect() {}
    });
    const rejected = createEditorPerformanceCollector("electron", "tiptap-20000");
    expect(rejected.finish().longTaskObservationSupported).toBe(false);
    rejected.dispose();

    vi.stubGlobal("PerformanceObserver", class {
      observe() {}
      disconnect() {}
    });
    const supported = createEditorPerformanceCollector("android", "tiptap-20000");
    expect(supported.finish().longTaskObservationSupported).toBe(true);
    supported.dispose();
  });
});
