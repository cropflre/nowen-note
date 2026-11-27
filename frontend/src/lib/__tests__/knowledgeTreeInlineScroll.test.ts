import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  alignKnowledgeTreeAnchorToTop,
  scheduleKnowledgeTreeTopAlignment,
} from "../knowledgeTreeInlineScroll";

describe("knowledgeTreeInlineScroll", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("scrolls a bottom parent node to the first visible line with top breathing room", () => {
    const container = document.createElement("div");
    const parentRow = document.createElement("div");
    container.scrollTop = 120;

    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
      top: 100,
      bottom: 400,
      left: 0,
      right: 300,
      width: 300,
      height: 300,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    });
    vi.spyOn(parentRow, "getBoundingClientRect").mockReturnValue({
      top: 360,
      bottom: 396,
      left: 0,
      right: 300,
      width: 300,
      height: 36,
      x: 0,
      y: 360,
      toJSON: () => ({}),
    });

    alignKnowledgeTreeAnchorToTop(container, parentRow, 4);
    // 120 + (360 - 100) - 4 = 376
    expect(container.scrollTop).toBe(376);
  });

  it("re-aligns on delayed keyboard animation ticks and visualViewport resize, then cleans up", () => {
    vi.useFakeTimers();
    const listeners = new Set<() => void>();
    vi.stubGlobal("visualViewport", {
      addEventListener: (_event: string, cb: () => void) => listeners.add(cb),
      removeEventListener: (_event: string, cb: () => void) => listeners.delete(cb),
    });

    const align = vi.fn();
    const stop = scheduleKnowledgeTreeTopAlignment(align);

    vi.advanceTimersByTime(500);
    const countAfterTimers = align.mock.calls.length;
    expect(countAfterTimers).toBeGreaterThanOrEqual(3);

    listeners.forEach((cb) => cb());
    vi.advanceTimersByTime(30);
    expect(align.mock.calls.length).toBeGreaterThan(countAfterTimers);

    stop();
    expect(listeners.size).toBe(0);
  });

  it("places the inline create draft immediately below its parent before existing children", () => {
    const treeSource = readFileSync(
      path.resolve(__dirname, "../../components/KnowledgeTreePanel.tsx"),
      "utf8",
    );
    const childBlockIndex = treeSource.indexOf("{draft?.parentId === node.id && renderDraft(depth + 1)}");
    const childrenMapIndex = treeSource.indexOf("{childNodes.map((child) => renderNode(child, depth + 1))}");
    expect(childBlockIndex).toBeGreaterThan(-1);
    expect(childrenMapIndex).toBeGreaterThan(childBlockIndex);

    const rootDraftIndex = treeSource.indexOf("{hasRootDraft && renderDraft(0)}");
    const ownedRootsIndex = treeSource.indexOf("{ownedRoots.map((node) => renderNode(node, 0))}");
    expect(rootDraftIndex).toBeGreaterThan(-1);
    expect(ownedRootsIndex).toBeGreaterThan(rootDraftIndex);
  });
});
