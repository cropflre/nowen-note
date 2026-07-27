import { describe, expect, it } from "vitest";

import { calculateKnowledgeTreeScrollbarMetrics } from "@/lib/knowledgeTreeScrollbarBridge";

describe("knowledge tree custom scrollbar geometry", () => {
  it("stays hidden when the tree does not overflow", () => {
    expect(calculateKnowledgeTreeScrollbarMetrics({
      scrollTop: 0,
      scrollHeight: 500,
      clientHeight: 500,
    })).toEqual({
      visible: false,
      thumbHeight: 500,
      thumbTop: 0,
      maxScrollTop: 0,
      maxThumbTop: 0,
    });
  });

  it("uses a discoverable minimum thumb for long trees", () => {
    const metrics = calculateKnowledgeTreeScrollbarMetrics({
      scrollTop: 400,
      scrollHeight: 2400,
      clientHeight: 400,
    });

    expect(metrics.visible).toBe(true);
    expect(metrics.thumbHeight).toBeGreaterThanOrEqual(36);
    expect(metrics.thumbTop).toBeGreaterThan(0);
    expect(metrics.thumbTop).toBeLessThan(metrics.maxThumbTop);
  });

  it("aligns the thumb with the bottom at maximum scroll", () => {
    const metrics = calculateKnowledgeTreeScrollbarMetrics({
      scrollTop: 1600,
      scrollHeight: 2000,
      clientHeight: 400,
    });

    expect(metrics.visible).toBe(true);
    expect(metrics.maxScrollTop).toBe(1600);
    expect(metrics.thumbTop).toBe(metrics.maxThumbTop);
  });

  it("clamps out-of-range scroll positions", () => {
    const beforeStart = calculateKnowledgeTreeScrollbarMetrics({
      scrollTop: -100,
      scrollHeight: 1000,
      clientHeight: 250,
    });
    const afterEnd = calculateKnowledgeTreeScrollbarMetrics({
      scrollTop: 9999,
      scrollHeight: 1000,
      clientHeight: 250,
    });

    expect(beforeStart.thumbTop).toBe(0);
    expect(afterEnd.thumbTop).toBe(afterEnd.maxThumbTop);
  });
});
