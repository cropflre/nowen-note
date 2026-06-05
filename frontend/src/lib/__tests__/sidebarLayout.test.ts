import { describe, expect, it } from "vitest";
import {
  SIDEBAR_TREE_ROW_BASE_WIDTH,
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
  });
});
