import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ status: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), collect: vi.fn(), retry: vi.fn(), configuration: vi.fn(), configure: vi.fn() }));
vi.mock("@/lib/pluginApi", () => ({ wechatAssistantApi: mocks }));
vi.mock("../WechatAccountSettings", () => ({ WechatAccountSettings: () => null }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "zh-CN" } }) }));
import { WechatAssistantSettings } from "../WechatAssistantSettings";

describe("WeChat inbox", () => {
  let root: Root, host: HTMLDivElement;
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks(); mocks.status.mockResolvedValue({ ready: false, pluginReady: true, connected: false, notebookId: null, items: [] });
    mocks.connect.mockResolvedValue({ qrUrl: "https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=real-api-ticket", expiresAt: Date.now() + 600000 });
    mocks.collect.mockResolvedValue({ accepted: 2, duplicates: 1 }); mocks.retry.mockResolvedValue({ success: true });
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });
  const render = async (isAdmin = false) => { await act(async () => root.render(<WechatAssistantSettings isAdmin={isAdmin} />)); };
  const button = (label: string) => [...host.querySelectorAll("button")].find((item) => item.textContent === label)!;
  it("offers local capture without pretending an unconfigured WeChat service is connected", async () => {
    await render(); expect(button("wechatAssistant.connect").disabled).toBe(true);
    expect(host.textContent).toContain("wechatAssistant.setupRequired"); expect(host.querySelector("img")).toBeNull(); expect(host.textContent).not.toContain("wechatAssistant.adminSetup");
    expect(host.querySelectorAll("textarea")).toHaveLength(1); expect(host.querySelectorAll("input")).toHaveLength(0);
  });
  it("displays only a QR returned by the API and catches connection errors", async () => {
    mocks.status.mockResolvedValue({ ready: true, pluginReady: true, connected: false, items: [] }); await render();
    await act(async () => button("wechatAssistant.connect").click()); expect(host.querySelector("img")?.src).toContain("real-api-ticket");
    mocks.connect.mockRejectedValue(new Error("公众号权限不足")); await act(async () => button("wechatAssistant.connect").click());
    expect(host.querySelector("[role=alert]")?.textContent).toBe("公众号权限不足");
  });
  it("submits links without notebook IDs or tags and catches failed requests", async () => {
    await render(); const textarea = host.querySelector("textarea")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "https://example.com/one\nhttps://example.com/two"); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(mocks.collect).toHaveBeenCalledWith("https://example.com/one\nhttps://example.com/two"); expect(host.querySelector("[role=status]")).not.toBeNull();
    mocks.collect.mockRejectedValue(new Error("采集失败")); await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(host.querySelector("[role=alert]")?.textContent).toBe("采集失败");
  });
  it("polls while connected so new WeChat messages appear without a manual refresh", async () => {
    vi.useFakeTimers();
    mocks.status.mockResolvedValue({ ready: true, pluginReady: true, connected: true, items: [] });
    await render(); expect(mocks.status).toHaveBeenCalledOnce();
    mocks.status.mockResolvedValue({ ready: true, pluginReady: true, connected: true, items: [{ id: "new", url: "https://example.com/new", status: "completed", createdAt: new Date().toISOString(), note: { id: "new-note", title: "新收到的文章" }, error: null }] });
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(mocks.status).toHaveBeenCalledTimes(2); expect(host.textContent).toContain("新收到的文章");
  });
  it("shows per-article status with retry and opens the completed note", async () => {
    mocks.status.mockResolvedValue({ ready: false, pluginReady: true, connected: false, items: [
      { id: "failed", url: "https://example.com/failed", status: "failed", createdAt: new Date().toISOString(), note: null, error: "正文无法读取" },
      { id: "done", url: "https://example.com/done", status: "completed", createdAt: new Date().toISOString(), note: { id: "note-1", title: "文章标题" }, error: null },
    ] }); await render(); expect(host.textContent).toContain("正文无法读取");
    await act(async () => button("wechatAssistant.retry").click()); expect(mocks.retry).toHaveBeenCalledWith("failed");
    const open = vi.fn(); window.addEventListener("nowen:open-note", open);
    await act(async () => button("wechatAssistant.open").click()); expect(open.mock.calls[0][0].detail).toEqual({ noteId: "note-1" }); window.removeEventListener("nowen:open-note", open);
  });
});
