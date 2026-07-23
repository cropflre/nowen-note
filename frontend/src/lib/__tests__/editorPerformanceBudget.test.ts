import { describe, expect, it } from "vitest";
import { evaluateEditorPerformanceBudget } from "@/lib/editorPerformanceBudget";

describe("editor performance acceptance budget", () => {
  it("accepts a responsive desktop report", () => {
    const result = evaluateEditorPerformanceBudget({
      inputLatencyMs: [8, 10, 12, 14, 18, 20],
      longTaskMs: [45, 80],
      heapBeforeBytes: 200_000_000,
      heapAfterBytes: 225_000_000,
      activeWorkersAfterClose: 0,
      activeMediaRequestsAfterClose: 0,
    }, "desktop");
    expect(result.passed).toBe(true);
  });

  it("reports latency, long-task and lifecycle regressions", () => {
    const result = evaluateEditorPerformanceBudget({
      inputLatencyMs: [40, 60, 120],
      longTaskMs: [240],
      activeWorkersAfterClose: 1,
      activeMediaRequestsAfterClose: 2,
    }, "android-low-power");
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      expect.stringContaining("p50"),
      expect.stringContaining("p95"),
      expect.stringContaining("longest task"),
      expect.stringContaining("workers"),
      expect.stringContaining("media requests"),
    ]));
  });
});
