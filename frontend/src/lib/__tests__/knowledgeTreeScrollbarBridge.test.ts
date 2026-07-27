/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  calculateKnowledgeTreeScrollbarMetrics,
  installKnowledgeTreeScrollbarBridge,
  refreshKnowledgeTreeScrollbars,
} from "@/lib/knowledgeTreeScrollbarBridge";

let cleanupScrollbarBridge: (() => void) | null = null;

async function waitForScrollbarReconcile(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

afterEach(() => {
  cleanupScrollbarBridge?.();
  cleanupScrollbarBridge = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

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

  it("reattaches the custom track when a React render removes it", async () => {
    document.body.innerHTML = `
      <aside data-sidebar-variant="desktop">
        <section>
          <div data-swipe-blocker="knowledge-tree-scroll"></div>
        </section>
      </aside>
    `;

    cleanupScrollbarBridge = installKnowledgeTreeScrollbarBridge();
    await waitForScrollbarReconcile();

    const firstTrack = document.querySelector(".nowen-knowledge-tree-custom-scroll-track");
    expect(firstTrack).not.toBeNull();

    firstTrack?.remove();
    await waitForScrollbarReconcile();

    const replacementTrack = document.querySelector(".nowen-knowledge-tree-custom-scroll-track");
    expect(replacementTrack).not.toBeNull();
    expect(replacementTrack).not.toBe(firstTrack);
  });

  it("ignores unrelated document mutations", async () => {
    cleanupScrollbarBridge = installKnowledgeTreeScrollbarBridge();
    await waitForScrollbarReconcile();
    const querySelectorAll = vi.spyOn(document, "querySelectorAll");

    document.body.appendChild(document.createElement("div"));
    await waitForScrollbarReconcile();

    expect(querySelectorAll).not.toHaveBeenCalled();
  });

  it("attaches after the desktop sidebar explicitly refreshes its surface", async () => {
    cleanupScrollbarBridge = installKnowledgeTreeScrollbarBridge();
    await waitForScrollbarReconcile();

    document.body.innerHTML = `
      <aside data-sidebar-variant="desktop">
        <section>
          <div data-swipe-blocker="knowledge-tree-scroll"></div>
        </section>
      </aside>
    `;
    refreshKnowledgeTreeScrollbars();
    await waitForScrollbarReconcile();

    expect(document.querySelector(".nowen-knowledge-tree-custom-scroll-track")).not.toBeNull();
  });

  it("keeps a disabled track visible when the desktop tree currently fits", async () => {
    document.body.innerHTML = `
      <aside data-sidebar-variant="desktop">
        <section>
          <div data-swipe-blocker="knowledge-tree-scroll"></div>
        </section>
      </aside>
    `;
    const scrollElement = document.querySelector<HTMLElement>(
      '[data-swipe-blocker="knowledge-tree-scroll"]',
    );
    expect(scrollElement).not.toBeNull();
    Object.defineProperties(scrollElement, {
      clientHeight: { configurable: true, value: 480 },
      scrollHeight: { configurable: true, value: 480 },
      offsetTop: { configurable: true, value: 120 },
    });

    cleanupScrollbarBridge = installKnowledgeTreeScrollbarBridge();
    await waitForScrollbarReconcile();

    const track = document.querySelector<HTMLElement>(
      ".nowen-knowledge-tree-custom-scroll-track",
    );
    expect(track?.hidden).toBe(false);
    expect(track?.getAttribute("aria-disabled")).toBe("true");
  });
});
