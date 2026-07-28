import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const bridgeSource = readFileSync(path.resolve(__dirname, "../SidebarSearchExperienceBridge.tsx"), "utf8");
const helperSource = readFileSync(path.resolve(__dirname, "../../lib/mobileKnowledgeTreeViewMode.ts"), "utf8");

describe("mobile knowledge tree mode switch contract", () => {
  it("offers the recent/all navigator and the previous recursive tree", () => {
    expect(bridgeSource).toContain("最近 / 全部");
    expect(bridgeSource).toContain("树形目录");
    expect(bridgeSource).toContain('<KnowledgeTreePanel variant="mobile" />');
    expect(bridgeSource).toContain('mode === "tree" && createPortal');
    expect(bridgeSource).toContain('surface.navigatorSurface.style.display = mode === "tree" ? "none" : ""');
  });

  it("renders an accessible two-option switch in the mobile content header", () => {
    expect(bridgeSource).toContain('role="group"');
    expect(bridgeSource).toContain('aria-label="目录浏览方式"');
    expect(bridgeSource).toContain('aria-pressed={mode === "navigator"}');
    expect(bridgeSource).toContain('aria-pressed={mode === "tree"}');
    expect(bridgeSource).toContain("MOBILE_MODE_SWITCH_SLOT_ATTRIBUTE");
  });

  it("persists the choice and keeps the new navigator as the default", () => {
    expect(helperSource).toContain('export type MobileKnowledgeTreeViewMode = "navigator" | "tree"');
    expect(helperSource).toContain('return value && VALID_MODES.has(value) ? value : "navigator"');
    expect(helperSource).toContain("MOBILE_KNOWLEDGE_TREE_VIEW_MODE_STORAGE_KEY");
    expect(helperSource).toContain("MOBILE_KNOWLEDGE_TREE_VIEW_MODE_CHANGED_EVENT");
  });
});
