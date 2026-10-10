import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ status: vi.fn(), collect: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/pluginApi", () => ({ wechatCaptureApi: { status: mocks.status }, PLUGIN_CONTRIBUTIONS_CHANGED_EVENT: "plugin-changed" }));
vi.mock("@/lib/wechatCapture", async (load) => ({ ...await load<typeof import("@/lib/wechatCapture")>(), collectWechatArticles: mocks.collect, readWechatClipboard: mocks.read }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import WechatClipboardBridge from "../WechatClipboardBridge";
describe("WeChat clipboard consent", () => {
  let root: Root, host: HTMLDivElement;
  const url = "https://mp.weixin.qq.com/s/article";
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.resetAllMocks(); mocks.status.mockResolvedValue({ pluginReady: true, clipboardPrompt: true, items: [] });
    mocks.read.mockResolvedValue([url]); mocks.collect.mockResolvedValue({ accepted: 1, duplicates: 0 });
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
  const render = async () => { await act(async () => root.render(<WechatClipboardBridge />)); };
  it("only queues articles after confirmation, catches failures and permits retry", async () => {
    await render(); expect(host.querySelector('[role="dialog"]')).not.toBeNull(); expect(mocks.collect).not.toHaveBeenCalled();
    mocks.collect.mockRejectedValueOnce(new Error("采集失败"));
    await act(async () => [...host.querySelectorAll("button")][1].click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("采集失败");
    await act(async () => [...host.querySelectorAll("button")][1].click());
    expect(mocks.collect).toHaveBeenCalledWith(url); expect(host.querySelector('[role="dialog"]')).toBeNull();
  });
  it("dismisses without importing and does not nag about the same link", async () => {
    await render(); await act(async () => host.querySelector("button")!.click());
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(host.querySelector('[role="dialog"]')).toBeNull(); expect(mocks.collect).not.toHaveBeenCalled();
  });
  it("does not read clipboard when plugin is disabled or user opts out", async () => {
    mocks.status.mockResolvedValue({ pluginReady: false, clipboardPrompt: true, items: [] }); await render();
    expect(mocks.read).not.toHaveBeenCalled();
    mocks.status.mockResolvedValue({ pluginReady: true, clipboardPrompt: false, items: [] });
    await act(async () => window.dispatchEvent(new Event("focus"))); expect(mocks.read).not.toHaveBeenCalled();
  });
  it("hides an open prompt after plugin disable", async () => {
    await render(); mocks.status.mockResolvedValue({ pluginReady: false, clipboardPrompt: false, items: [] });
    await act(async () => window.dispatchEvent(new Event("plugin-changed"))); expect(host.querySelector('[role="dialog"]')).toBeNull();
  });
  it("does not suggest articles already queued", async () => {
    mocks.status.mockResolvedValue({ pluginReady: true, clipboardPrompt: true, items: [{ url, status: "queued" }] });
    await render(); expect(host.querySelector('[role="dialog"]')).toBeNull();
  });
  it("detects paste without requesting browser clipboard permission", async () => {
    mocks.read.mockResolvedValue([]); await render();
    const paste = new Event("paste", { bubbles: true }); Object.defineProperty(paste, "clipboardData", { value: { getData: () => `正文 ${url}?key=secret` } });
    await act(async () => document.dispatchEvent(paste)); expect(host.textContent).toContain(url); expect(host.textContent).not.toContain("secret"); expect(mocks.collect).not.toHaveBeenCalled();
  });
});
