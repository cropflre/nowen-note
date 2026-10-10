import { afterEach, describe, expect, it, vi } from "vitest";
import { readWechatClipboard, wechatArticleLinks } from "../wechatCapture";

describe("WeChat public clipboard URLs", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); Reflect.deleteProperty(window, "nowenDesktop"); });
  it("detects public links and strips session and tracking parameters", () => {
    expect(wechatArticleLinks("文章 https://mp.weixin.qq.com/s/abc?key=secret&uin=123#x。私密文本"))
      .toEqual(["https://mp.weixin.qq.com/s/abc"]);
    expect(wechatArticleLinks("https://mp.weixin.qq.com/s?__biz=a&mid=2&idx=1&key=secret"))
      .toEqual(["https://mp.weixin.qq.com/s?__biz=a&mid=2&idx=1"]);
  });
  it("ignores non-article hosts, profile sessions, credentials, and incomplete links", () => {
    expect(wechatArticleLinks("https://example.com/x https://mp.weixin.qq.com.evil/s/a https://mp.weixin.qq.com/mp/profile_ext?key=secret https://secret@mp.weixin.qq.com/s/a https://mp.weixin.qq.com:444/s/a https://mp.weixin.qq.com/s")).toEqual([]);
    expect(wechatArticleLinks("x".repeat(16385))).toEqual([]);
  });
  it("deduplicates and rejects oversized batches", () => {
    expect(wechatArticleLinks("https://mp.weixin.qq.com/s/a?scene=1 https://mp.weixin.qq.com/s/a?scene=2")).toHaveLength(1);
    expect(wechatArticleLinks(Array.from({ length: 21 }, (_, i) => `https://mp.weixin.qq.com/s/article-${i}`).join("\n"))).toEqual([]);
  });
  it("does not request clipboard access automatically", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const readText = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { readText }, permissions: { query: vi.fn().mockResolvedValue({ state: "prompt" }) } });
    expect(await readWechatClipboard()).toEqual([]); expect(readText).not.toHaveBeenCalled();
  });
  it("reads granted browser clipboard and handles denied APIs", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const readText = vi.fn().mockResolvedValue("private https://mp.weixin.qq.com/s/article?key=secret");
    vi.stubGlobal("navigator", { clipboard: { readText }, permissions: { query: vi.fn().mockResolvedValue({ state: "granted" }) } });
    expect(await readWechatClipboard()).toEqual(["https://mp.weixin.qq.com/s/article"]);
    readText.mockRejectedValue(new Error("denied")); expect(await readWechatClipboard()).toEqual([]);
  });
});
