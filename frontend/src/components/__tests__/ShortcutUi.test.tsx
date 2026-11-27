// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MotionGlobalConfig } from "framer-motion";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ShortcutSettingsPanel from "@/components/settings/ShortcutSettingsPanel";
import ShortcutHelpCenter, { OPEN_SHORTCUT_HELP_EVENT } from "@/components/ShortcutHelpCenter";
import { hasShortcutOverride, resetAllShortcutOverrides } from "@/lib/shortcutOverrides";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
MotionGlobalConfig.skipAnimations = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 Chrome/120.0" });
  localStorage.clear();
  resetAllShortcutOverrides();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("ShortcutSettingsPanel playful 3D keycap UI", () => {
  it("renders split 3D keycaps, category tabs, and filters commands", async () => {
    await act(async () => root!.render(<ShortcutSettingsPanel />));

    expect(host!.querySelectorAll(".nowen-keycap").length).toBeGreaterThan(10);
    const tabs = Array.from(host!.querySelectorAll('[role="tab"]'));
    expect(tabs.some((tab) => tab.textContent?.includes("全部"))).toBe(true);
    expect(tabs.some((tab) => tab.textContent?.includes("富文本编辑"))).toBe(true);

    const globalTab = tabs.find((tab) => tab.textContent?.includes("全局")) as HTMLButtonElement;
    await act(async () => globalTab.click());
    expect(host!.textContent).toContain("命令面板");
    expect(host!.textContent).not.toContain("居中对齐");
  });

  it("records a custom shortcut, shows customized badge, and resets via confirmation modal", async () => {
    await act(async () => root!.render(<ShortcutSettingsPanel />));

    const search = host!.querySelector('input[placeholder*="搜命令"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(search, "加粗");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const recordButton = Array.from(host!.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "录制",
    ) as HTMLButtonElement;
    expect(recordButton).toBeTruthy();

    await act(async () => recordButton.click());
    expect(host!.textContent).toContain("正在聆听按键");

    // Hold Ctrl first — live modifier keycap should depress without finalizing
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true, bubbles: true, cancelable: true }));
    });
    expect(host!.querySelector(".nowen-keycap--pressed")).toBeTruthy();

    // Press Ctrl+Shift+U to bind
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "U", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(host!.textContent).toContain("已自定义 1 项");
    expect(host!.textContent).toContain("Ctrl+Shift+U");

    // Open Reset All modal and confirm
    const resetAllBtn = Array.from(host!.querySelectorAll("button")).find(
      (btn) => btn.textContent?.includes("全部默认"),
    ) as HTMLButtonElement;
    await act(async () => resetAllBtn.click());
    expect(host!.textContent).toContain("恢复全部默认键位");

    const confirmBtn = Array.from(host!.querySelectorAll("button")).find(
      (btn) => btn.textContent?.includes("确认恢复默认"),
    ) as HTMLButtonElement;
    await act(async () => confirmBtn.click());
    expect(hasShortcutOverride("bold", "windows")).toBe(false);
    expect(host!.textContent).not.toContain("已自定义 1 项");
  });
});

describe("ShortcutHelpCenter playful modal UI", () => {
  it("opens via event, renders accessible dialog with 3D keycaps, and echoes live keypresses", async () => {
    await act(async () => root!.render(<ShortcutHelpCenter />));

    await act(async () => {
      window.dispatchEvent(new CustomEvent(OPEN_SHORTCUT_HELP_EVENT));
    });

    const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog).toBeTruthy();
    expect(dialog.querySelector("#shortcut-help-title")?.textContent?.trim()).toBe("键盘快捷键");
    expect(dialog.textContent).toContain("居中对齐");
    expect(dialog.querySelectorAll(".nowen-keycap").length).toBeGreaterThan(10);

    // Hold Ctrl + B to trigger live keypress echo
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true }));
    });
    expect(dialog.textContent).toContain("正在按下");

    // Escape closes modal
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });
});
