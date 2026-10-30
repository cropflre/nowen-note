import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import VoiceInsertMenu from "../VoiceInsertMenu";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("VoiceInsertMenu", () => {
  let host: HTMLDivElement;
  let root: Root;
  const upload = vi.fn();
  const record = vi.fn();
  const trigger = () => host.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
  const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
  const open = () => act(() => trigger().click());

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    host = document.createElement("div");
    host.style.overflow = "hidden";
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<VoiceInsertMenu onUpload={upload} onRecord={record} />));
    vi.spyOn(trigger(), "getBoundingClientRect").mockReturnValue(new DOMRect(120, 40, 32, 32));
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 176, 88));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens outside the clipping toolbar and anchors below the attachment icon", () => {
    open();
    expect(menu()).not.toBeNull();
    expect(host.contains(menu())).toBe(false);
    expect(menu()?.parentElement).toBe(document.body);
    expect(menu()?.style.left).toBe("120px");
    expect(menu()?.style.top).toBe("76px");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    open();
    expect(menu()).toBeNull();
  });

  it("keeps the menu within the right and bottom viewport edges", () => {
    vi.spyOn(trigger(), "getBoundingClientRect").mockReturnValue(new DOMRect(window.innerWidth - 40, window.innerHeight - 40, 32, 32));
    open();
    expect(Number.parseFloat(menu()!.style.left) + 176).toBeLessThanOrEqual(window.innerWidth - 8);
    expect(Number.parseFloat(menu()!.style.top) + 88).toBeLessThan(window.innerHeight - 40);
  });

  it("closes before invoking either action", () => {
    for (const [index, callback] of [upload, record].entries()) {
      open();
      act(() => menu()!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[index].click());
      expect(menu()).toBeNull();
      expect(callback).toHaveBeenCalledTimes(1);
    }
  });

  it("preserves the disabled recording action", () => {
    act(() => root.render(<VoiceInsertMenu onUpload={upload} onRecord={record} recordDisabled />));
    open();
    const button = menu()!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[1];
    expect(button.disabled).toBe(true);
    act(() => button.click());
    expect(record).not.toHaveBeenCalled();
    expect(menu()).not.toBeNull();
  });

  it("closes on Escape, outside clicks, toolbar scrolling and resizing", () => {
    const events = [
      () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
      () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })),
      () => host.dispatchEvent(new Event("scroll")),
      () => window.dispatchEvent(new Event("resize")),
    ];
    for (const dispatch of events) {
      open();
      act(dispatch);
      expect(menu()).toBeNull();
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
    }
  });

  it("keeps the menu open when clicking or scrolling inside it and removes it on unmount", () => {
    open();
    act(() => {
      menu()!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      menu()!.dispatchEvent(new Event("scroll"));
    });
    expect(menu()).not.toBeNull();
    act(() => root.render(null));
    expect(menu()).toBeNull();
  });
});
