import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  readSidebarTextStyle,
  saveSidebarTextStyle,
  SIDEBAR_TEXT_STYLE_STORAGE_KEY,
  useSidebarTextStyle,
} from "../useSidebarTextStyle";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  saveSidebarTextStyle("readable");
  localStorage.removeItem(SIDEBAR_TEXT_STYLE_STORAGE_KEY);
  document.body.innerHTML = "";
});

describe("sidebar text style", () => {
  it("defaults to readable and rejects unknown stored values", () => {
    localStorage.removeItem(SIDEBAR_TEXT_STYLE_STORAGE_KEY);
    expect(readSidebarTextStyle()).toBe("readable");
    localStorage.setItem(SIDEBAR_TEXT_STYLE_STORAGE_KEY, "unknown");
    expect(readSidebarTextStyle()).toBe("readable");
  });

  it("updates mounted consumers immediately and persists the classic choice", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    let choose: ((style: "readable" | "classic") => void) | undefined;
    function Consumer() {
      const [style, setStyle] = useSidebarTextStyle();
      choose = setStyle;
      return <span>{style}</span>;
    }
    act(() => root?.render(<Consumer />));
    expect(host.textContent).toBe("readable");
    act(() => choose?.("classic"));
    expect(host.textContent).toBe("classic");
    expect(localStorage.getItem(SIDEBAR_TEXT_STYLE_STORAGE_KEY)).toBe("classic");

    localStorage.setItem(SIDEBAR_TEXT_STYLE_STORAGE_KEY, "readable");
    act(() => window.dispatchEvent(new StorageEvent("storage", {
      key: SIDEBAR_TEXT_STYLE_STORAGE_KEY,
      newValue: "readable",
    })));
    expect(host.textContent).toBe("readable");
  });
});
