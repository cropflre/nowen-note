import { describe, expect, it } from "vitest";
import {
  SIDEBAR_TREE_COUNT_RESERVE_WIDTH,
  SIDEBAR_TREE_LABEL_RESERVE_WIDTH,
  SIDEBAR_TREE_ROW_BASE_WIDTH,
  SIDEBAR_TREE_ROW_CHROME_WIDTH,
  sidebarTreeContentMinWidth,
  sidebarTreeRowMinWidth,
} from "@/lib/sidebarLayout";

describe("sidebarLayout", () => {
  it("keeps deeply nested notebook rows wider than their indentation", () => {
    expect(sidebarTreeRowMinWidth(12)).toBeGreaterThan(SIDEBAR_TREE_ROW_BASE_WIDTH);
    expect(sidebarTreeRowMinWidth(12)).toBeGreaterThan(12 * 28);
  });

  it("widens the scrollable tree content by max depth", () => {
    expect(sidebarTreeContentMinWidth(12)).toBe(sidebarTreeRowMinWidth(12));
    expect(SIDEBAR_TREE_LABEL_RESERVE_WIDTH).toBe(120);
    expect(sidebarTreeContentMinWidth(12)).toBeLessThanOrEqual(400);
  });

  it("reserves room for notebook note counts without manual sidebar widening", () => {
    expect(SIDEBAR_TREE_ROW_BASE_WIDTH).toBe(
      SIDEBAR_TREE_LABEL_RESERVE_WIDTH +
        SIDEBAR_TREE_ROW_CHROME_WIDTH +
        SIDEBAR_TREE_COUNT_RESERVE_WIDTH,
    );
    expect(SIDEBAR_TREE_COUNT_RESERVE_WIDTH).toBeGreaterThanOrEqual(32);
  });
});
