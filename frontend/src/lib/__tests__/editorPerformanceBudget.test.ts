import { describe, expect, it } from "vitest";
import {
  evaluateEditorPerformanceBudget,
  type EditorPerformanceSample,
} from "@/lib/editorPerformanceBudget";

function passingSample(): EditorPerformanceSample {
  return {
    inputLatencyMs: [8, 10, 12, 14, 18, 20],
    longTaskMs: [45, 80],
    peakDomNodes: 1_200,
    peakNodeViews: 40,
    heapBeforeBytes: 200_000_000,
    heapOpenedBytes: 210_000_000,
    heapScrolledBytes: 220_000_000,
    heapAfterBytes: 225_000_000,
    activeWorkersAfterClose: 0,
    activeNodeViewsAfterClose: 0,
    activeMediaRequestsAfterClose: 0,
  };
}

describe("editor performance acceptance budget", () => {
  it("accepts a responsive desktop report", () => {
    const result = evaluateEditorPerformanceBudget(passingSample(), "desktop");
    expect(result.passed).toBe(true);
  });

  it("reports latency, long-task and lifecycle regressions", () => {
    const result = evaluateEditorPerformanceBudget({
      inputLatencyMs: [40, 60, 120],
      longTaskMs: [240],
      peakDomNodes: 1_200,
      peakNodeViews: 40,
      heapBeforeBytes: 100_000_000,
      heapOpenedBytes: 110_000_000,
      heapScrolledBytes: 120_000_000,
      heapAfterBytes: 125_000_000,
      activeWorkersAfterClose: 1,
      activeNodeViewsAfterClose: 3,
      activeMediaRequestsAfterClose: 2,
    }, "android-low-power");
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.stringContaining("p50"),
      expect.stringContaining("p95"),
      expect.stringContaining("longest task"),
      expect.stringContaining("workers"),
      expect.stringContaining("NodeViews"),
      expect.stringContaining("media requests"),
    ]));
  });

  it("uses the largest heap growth across opened, scrolled and after stages", () => {
    const sample = passingSample();
    sample.heapBeforeBytes = 100_000_000;
    sample.heapOpenedBytes = 180_000_000;
    sample.heapScrolledBytes = 120_000_000;
    sample.heapAfterBytes = 105_000_000;
    const result = evaluateEditorPerformanceBudget(sample, "desktop");
    expect(result.passed).toBe(false);
    expect(result.metrics.heapGrowthBytes).toBe(80_000_000);
    expect(result.failures).toContain("heap growth exceeds max(64 MiB, 20% of baseline) allowance");
  });

  it.each([
    "inputLatencyMs",
    "longTaskMs",
    "peakDomNodes",
    "peakNodeViews",
    "heapBeforeBytes",
    "heapOpenedBytes",
    "heapScrolledBytes",
    "heapAfterBytes",
    "activeWorkersAfterClose",
    "activeNodeViewsAfterClose",
    "activeMediaRequestsAfterClose",
  ] as const)("fails closed when %s is missing", (field) => {
    const sample = { ...passingSample() } as Record<string, unknown>;
    delete sample[field];
    const result = evaluateEditorPerformanceBudget(sample as unknown as EditorPerformanceSample, "desktop");
    expect(result.passed).toBe(false);
    expect(result.failures).toContain(`${field} is missing or invalid`);
  });
});
