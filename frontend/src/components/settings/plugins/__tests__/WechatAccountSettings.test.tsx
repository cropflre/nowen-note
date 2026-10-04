import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ identify: vi.fn(), verify: vi.fn(), next: vi.fn(), collect: vi.fn(), forget: vi.fn() }));
vi.mock("@/lib/pluginApi", () => ({ wechatAccountApi: mocks }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, values?: unknown) => values ? key + JSON.stringify(values) : key, i18n: { language: "zh-CN" } }) }));
import { WechatAccountSettings } from "../WechatAccountSettings";
describe("specified official-account collection", () => {
  let root: Root, host: HTMLDivElement;
  const queued = vi.fn<[], Promise<void>>();
  const article = (id: number) => ({ url: `https://mp.weixin.qq.com/s/${id}`, title: `文章 ${id}`, publishedAt: 1760000000 });
  const target = (overrides = {}) => ({ id: "target", name: "目标公众号", homeUrl: "https://mp.weixin.qq.com/mp/profile_ext?action=home&__biz=public", verified: false, hasMore: true, expiresAt: Date.now() + 600000, articles: [], ...overrides });
  const button = (key: string) => [...host.querySelectorAll("button")].find((element) => element.textContent?.startsWith(key))!;
  const fill = async (input: HTMLInputElement, value: string) => { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); }); };
  const submit = async () => { await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); };
  const render = async () => { await act(async () => root.render(<WechatAccountSettings onQueued={queued} />)); };
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; vi.clearAllMocks(); queued.mockResolvedValue(undefined);
    mocks.identify.mockResolvedValue(target()); mocks.forget.mockResolvedValue({ success: true }); mocks.collect.mockResolvedValue({ accepted: 20, duplicates: 0 });
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
  it("starts with the target article and honest readiness, requiring no official-account secrets or QR", async () => {
    await render(); expect(host.textContent).toContain("wechatAccount.experimental"); expect(host.querySelector("img")).toBeNull(); expect(host.querySelectorAll("input")).toHaveLength(1);
    await fill(host.querySelector("input")!, article(1).url); await submit();
    expect(mocks.identify).toHaveBeenCalledWith(article(1).url); expect(host.textContent).toContain("目标公众号"); expect(host.querySelectorAll("input[type=password]")).toHaveLength(2); expect(button("wechatAccount.collectAll")).toBeUndefined();
  });
  it("does not fabricate a successful account when the public page is unavailable", async () => {
    mocks.identify.mockRejectedValue(new Error("微信未返回公众号文章")); await render(); await fill(host.querySelector("input")!, article(1).url); await submit();
    expect(host.querySelector("[role=alert]")?.textContent).toBe("微信未返回公众号文章"); expect(host.textContent).not.toContain("目标公众号");
  });
  it("clears private reading input even when verification fails", async () => {
    mocks.identify.mockResolvedValue(target()); mocks.verify.mockRejectedValue(new Error("阅读会话失效")); await render(); await fill(host.querySelector("input")!, article(1).url); await submit();
    await fill(host.querySelector("input[type=password]")!, "private-reading-url"); await submit();
    expect(mocks.verify).toHaveBeenCalledWith("target", "private-reading-url", ""); expect((host.querySelector("input[type=password]") as HTMLInputElement).value).toBe(""); expect(host.textContent).not.toContain("private-reading-url");
  });
  it("requires the remote end of history before all-article collection", async () => {
    mocks.identify.mockResolvedValue(target({ verified: true, articles: [article(1)] })); mocks.next.mockResolvedValue(target({ verified: true, hasMore: false, articles: [article(1), article(2)] }));
    await render(); await fill(host.querySelector("input")!, article(1).url); await submit(); expect(button("wechatAccount.collectAll").disabled).toBe(true);
    await act(async () => button("wechatAccount.more").click()); expect(button("wechatAccount.collectAll").disabled).toBe(false); expect(host.textContent).toContain("wechatAccount.end");
    await act(async () => button("wechatAccount.collectAll").click()); expect(mocks.collect).toHaveBeenCalledWith("target", [article(1).url, article(2).url]); expect(queued).toHaveBeenCalledOnce();
  });
  it("keeps partial queue progress and resumes only the failed batches", async () => {
    const articles = Array.from({ length: 21 }, (_, index) => article(index + 1));
    mocks.identify.mockResolvedValue(target({ verified: true, hasMore: false, articles }));
    mocks.collect.mockResolvedValueOnce({ accepted: 20, duplicates: 0 }).mockRejectedValueOnce(new Error("第二批失败")).mockResolvedValueOnce({ accepted: 1, duplicates: 0 });
    await render(); await fill(host.querySelector("input")!, article(1).url); await submit();
    await act(async () => button("wechatAccount.collectAll").click());
    expect(host.querySelector("[role=alert]")?.textContent).toBe("第二批失败"); expect(host.textContent).toContain('"completed":20'); expect(queued).toHaveBeenCalledOnce();
    await act(async () => button("wechatAccount.collectAll").click()); expect(mocks.collect.mock.calls[2]).toEqual(["target", [article(21).url]]); expect(button("wechatAccount.collectAll").disabled).toBe(true);
  });
});
