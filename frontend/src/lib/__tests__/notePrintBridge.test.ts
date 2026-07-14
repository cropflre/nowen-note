import { beforeEach, describe, expect, it, vi } from "vitest";

const { nativePrint, capacitorState } = vi.hoisted(() => ({
  nativePrint: vi.fn(),
  capacitorState: { native: false, platform: "web" },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => capacitorState.native,
    getPlatform: () => capacitorState.platform,
  },
  registerPlugin: () => ({ printNote: nativePrint }),
}));

import { requestNotePrint } from "@/lib/notePrintBridge";

describe("requestNotePrint", () => {
  beforeEach(() => {
    capacitorState.native = false;
    capacitorState.platform = "web";
    nativePrint.mockReset();
    document.body.innerHTML = "";
  });

  it("uses the Android system print bridge in the native app", async () => {
    capacitorState.native = true;
    capacitorState.platform = "android";
    nativePrint.mockResolvedValue({ success: true });

    await expect(requestNotePrint("<html><body>正文</body></html>", "测试笔记"))
      .resolves.toEqual({ ok: true, mode: "native" });

    expect(nativePrint).toHaveBeenCalledWith({
      html: "<html><body>正文</body></html>",
      jobName: "测试笔记",
    });
  });

  it("prints an isolated document in the browser", async () => {
    const print = vi.fn();
    const focus = vi.fn();
    const appendChild = document.body.appendChild.bind(document.body);
    vi.spyOn(document.body, "appendChild").mockImplementation((node: Node) => {
      const result = appendChild(node);
      if (node instanceof HTMLIFrameElement && node.contentWindow) {
        Object.defineProperty(node.contentWindow, "print", { value: print, configurable: true });
        Object.defineProperty(node.contentWindow, "focus", { value: focus, configurable: true });
      }
      return result;
    });

    await expect(requestNotePrint("<html><body>正文</body></html>", "测试笔记"))
      .resolves.toEqual({ ok: true, mode: "web" });

    expect(focus).toHaveBeenCalledOnce();
    expect(print).toHaveBeenCalledOnce();
    expect(document.querySelector("iframe[data-note-print]")).not.toBeNull();
  });
});
