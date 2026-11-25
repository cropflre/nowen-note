// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopHotUpdateStatus } from "@/lib/desktopBridge";
import { DesktopHotUpdateBanner } from "../DesktopHotUpdate";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const downloaded: DesktopHotUpdateStatus = {
  enabled: true,
  disabledReason: null,
  shellVersion: "1.6.0",
  runtimeVersion: "e1-0123456789abcdef",
  effectiveVersion: "1.6.0",
  bundleId: null,
  trial: false,
  pending: { bundleId: "1.6.1-aaaaaaaa", version: "1.6.1" },
  restartRequired: true,
  phase: "ready",
  message: "新版本 v1.6.1 已下载，重启应用后生效",
  lastCheckAt: null,
  autoDownload: true,
  lastRollback: null,
};

let host: HTMLDivElement;
let root: Root;
const apply = vi.fn(async () => true);

beforeEach(() => {
  vi.useFakeTimers();
  apply.mockClear();
  (window as unknown as { nowenDesktop: unknown }).nowenDesktop = {
    hotUpdate: { status: async () => downloaded, check: async () => downloaded, apply, ready: async () => downloaded, setAutoDownload: async () => downloaded },
    on: () => () => undefined,
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  delete (window as unknown as { nowenDesktop?: unknown }).nowenDesktop;
  vi.useRealTimers();
});

describe("桌面热更新：立即重启", () => {
  it("DCC-013: restarting into a desktop hot update first saves editors and waits like the full installer", async () => {
    const editor = document.createElement("div");
    editor.className = "ProseMirror";
    editor.setAttribute("contenteditable", "true");
    const saves: KeyboardEvent[] = [];
    editor.addEventListener("keydown", (event) => saves.push(event));
    document.body.append(editor);
    const flushed = vi.fn();
    window.addEventListener("nowen:before-desktop-update", flushed);

    await act(async () => root.render(<DesktopHotUpdateBanner />));
    const button = [...host.querySelectorAll("button")].find((item) => item.textContent === "立即重启");
    expect(button).toBeTruthy();
    await act(async () => button!.click());

    expect(saves.some((event) => event.key === "s" && (event.metaKey || event.ctrlKey))).toBe(true);
    expect((flushed.mock.calls[0][0] as CustomEvent).detail).toEqual({ reason: "desktop-hot-update" });
    expect(button!.textContent).toBe("正在保存…");
    expect(button!.disabled).toBe(true);
    await act(async () => vi.advanceTimersByTime(1799));
    expect(apply).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1));
    expect(apply).toHaveBeenCalledTimes(1);
    window.removeEventListener("nowen:before-desktop-update", flushed);
  });
});
