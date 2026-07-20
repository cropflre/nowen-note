import { describe, expect, it, vi } from "vitest";
import {
  calculateSearchMatchScrollTop,
  findSearchScrollContainer,
  getSearchNavigationIndex,
  isSearchNavigationUpdate,
  scrollSearchMatchIntoView,
} from "../searchMatchScroll";

describe("search match scrolling", () => {
  it("centers the exact match line instead of the containing code block", () => {
    expect(calculateSearchMatchScrollTop({
      scrollTop: 200,
      scrollHeight: 2400,
      clientHeight: 600,
      containerTop: 100,
      containerBottom: 700,
      matchTop: 1000,
      matchBottom: 1020,
    })).toBe(810);
  });

  it("clamps the destination at the beginning and end of the document", () => {
    expect(calculateSearchMatchScrollTop({
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 400,
      containerTop: 100,
      containerBottom: 500,
      matchTop: 20,
      matchBottom: 40,
    })).toBe(0);

    expect(calculateSearchMatchScrollTop({
      scrollTop: 500,
      scrollHeight: 1000,
      clientHeight: 400,
      containerTop: 100,
      containerBottom: 500,
      matchTop: 900,
      matchBottom: 920,
    })).toBe(600);
  });

  it("finds the actual vertical overflow container", () => {
    const container = document.createElement("div");
    container.style.overflowY = "auto";
    Object.defineProperty(container, "scrollHeight", { value: 1200 });
    Object.defineProperty(container, "clientHeight", { value: 400 });
    const editor = document.createElement("div");
    container.appendChild(editor);
    document.body.appendChild(container);

    expect(findSearchScrollContainer(editor)).toBe(container);
    container.remove();
  });

  it("scrolls with precise ProseMirror coordinates and no queued smooth animation", () => {
    const container = document.createElement("div");
    Object.defineProperty(container, "scrollHeight", { value: 2000 });
    Object.defineProperty(container, "clientHeight", { value: 400 });
    Object.defineProperty(container, "scrollTop", { value: 200, writable: true });
    container.getBoundingClientRect = () => ({
      top: 100,
      bottom: 500,
      left: 0,
      right: 800,
      width: 800,
      height: 400,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    });
    const scrollTo = vi.fn();
    container.scrollTo = scrollTo;

    const editorDom = document.createElement("div");
    const view = {
      dom: editorDom,
      coordsAtPos: vi.fn(() => ({ top: 900, bottom: 920, left: 10, right: 20 })),
    };

    expect(scrollSearchMatchIntoView({
      view,
      match: { from: 12, to: 18 },
      container,
    })).toBe(810);
    expect(view.coordsAtPos).toHaveBeenNthCalledWith(1, 12, 1);
    expect(view.coordsAtPos).toHaveBeenNthCalledWith(2, 18, -1);
    expect(scrollTo).toHaveBeenCalledWith({ top: 810, behavior: "auto" });
  });

  it("wraps next and previous navigation from the plugin's current index", () => {
    expect(getSearchNavigationIndex(4, 5, 1)).toBe(0);
    expect(getSearchNavigationIndex(0, 5, -1)).toBe(4);
    expect(getSearchNavigationIndex(-1, 5, 1)).toBe(0);
    expect(getSearchNavigationIndex(0, 0, 1)).toBe(-1);
  });

  it("recognizes navigation-only metadata so long notes are not rescanned", () => {
    expect(isSearchNavigationUpdate({ activeIndex: 3 })).toBe(true);
    expect(isSearchNavigationUpdate({ activeIndex: 3, query: "needle" })).toBe(false);
    expect(isSearchNavigationUpdate({ query: "needle" })).toBe(false);
  });
});
