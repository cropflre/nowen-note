import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import KnowledgeTreeDropdownMenu from "@/components/KnowledgeTreeDropdownMenu";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe("KnowledgeTreeDropdownMenu scrolling", () => {
  let root: Root;
  let anchor: HTMLButtonElement;
  const onClose = vi.fn();
  const onSelect = vi.fn();

  beforeEach(() => {
    onClose.mockClear();
    onSelect.mockClear();
    const host = document.createElement("div");
    anchor = document.createElement("button");
    document.body.append(host, anchor);
    root = createRoot(host);
    act(() => root.render(
      <KnowledgeTreeDropdownMenu
        open
        anchor={anchor}
        ariaLabel="目录操作"
        items={Array.from({ length: 12 }, (_, index) => ({
          value: String(index),
          label: `选项 ${index}`,
        }))}
        onClose={onClose}
        onSelect={onSelect}
      />,
    ));
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("keeps the menu open while its scrollbar or contents scroll, then allows selecting the last item", () => {
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    const lastItem = menu.querySelectorAll<HTMLButtonElement>("button")[11];

    act(() => {
      menu.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      menu.dispatchEvent(new Event("scroll"));
      lastItem.dispatchEvent(new Event("scroll"));
    });
    expect(onClose).not.toHaveBeenCalled();

    act(() => lastItem.click());
    expect(onSelect).toHaveBeenCalledWith("11");
  });

  it.each(["window", "document", "outside element"])("still closes when %s scrolls", (target) => {
    const scrollTarget = target === "window" ? window : target === "document" ? document : anchor;
    act(() => scrollTarget.dispatchEvent(new Event("scroll")));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps anchor clicks inside and still closes on outside clicks and Escape", () => {
    act(() => anchor.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(onClose).not.toHaveBeenCalled();

    act(() => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
