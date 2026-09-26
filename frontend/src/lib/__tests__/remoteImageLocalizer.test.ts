import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import {
  extractRemoteImageUrls,
  extractRemoteImageUrlsFromMarkdown,
  localizeRemoteImages,
  replaceRemoteUrlsInHtml,
  replaceRemoteUrlsInMarkdown,
} from "../remoteImageLocalizer";

vi.mock("../api", () => ({ api: { attachments: { importRemoteImage: vi.fn() } } }));
vi.mock("../toast", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const importRemoteImage = vi.mocked(api.attachments.importRemoteImage);

beforeEach(() => { importRemoteImage.mockReset(); });

describe("remote image paste", () => {
  it("only extracts real image sources, deduplicating decoded HTML URLs", () => {
    const html = '<a href="https://x.test/a.png">link</a><img data-src="https://x.test/hidden.png" src="https://x.test/a.png?a=1&amp;b=2"><img src="https://x.test/a.png?a=1&amp;b=2">';
    expect(extractRemoteImageUrls(html).map((item) => item.originalUrl)).toEqual(["https://x.test/a.png?a=1&b=2"]);
    expect(extractRemoteImageUrlsFromMarkdown("[link](https://x.test/a.png) ![one](https://x.test/a.png) ![two](<https://x.test/a.png> \"title\")").map((item) => item.originalUrl)).toEqual(["https://x.test/a.png"]);
  });

  it("replaces image targets without rewriting ordinary links or text", () => {
    const map = new Map([["https://x.test/a.png", "/api/attachments/local"]]);
    const html = '<a href="https://x.test/a.png">https://x.test/a.png</a><img src="https://x.test/a.png" srcset="https://x.test/large.png 2x">';
    const root = document.createElement("div");
    root.innerHTML = replaceRemoteUrlsInHtml(html, map);
    expect(root.querySelector("a")?.getAttribute("href")).toBe("https://x.test/a.png");
    expect(root.querySelector("img")?.getAttribute("src")).toBe("/api/attachments/local");
    expect(root.querySelector("img")?.hasAttribute("srcset")).toBe(false);
    expect(replaceRemoteUrlsInMarkdown("[link](https://x.test/a.png) ![image](https://x.test/a.png)", map))
      .toBe("[link](https://x.test/a.png) ![image](/api/attachments/local)");
    expect(replaceRemoteUrlsInMarkdown('![image](<https://x.test/a.png> "title")', map))
      .toBe('![image](</api/attachments/local> "title")');
  });

  it("limits concurrent imports, deduplicates URLs, and keeps failed source links", async () => {
    let active = 0;
    let peak = 0;
    importRemoteImage.mockImplementation(async (_noteId, url) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active -= 1;
      if (url.endsWith("fail.png")) throw new Error("download failed");
      return { url: `/api/attachments/${url.split("/").pop()}` } as Awaited<ReturnType<typeof api.attachments.importRemoteImage>>;
    });
    const urls = ["a.png", "b.png", "c.png", "d.png", "e.png", "fail.png", "a.png"].map((name) => `https://x.test/${name}`);
    const progress: number[] = [];
    const results = await localizeRemoteImages(urls, "note-a", "paste", (done) => progress.push(done));
    expect(importRemoteImage).toHaveBeenCalledTimes(6);
    expect(peak).toBeLessThanOrEqual(4);
    expect(progress).toHaveLength(6);
    expect(results[0].localUrl).toBe("/api/attachments/a.png");
    expect(results[6].localUrl).toBe(results[0].localUrl);
    expect(results[5].success).toBe(false);
    expect(results[5].localUrl).toBe(urls[5]);
    const replacements = new Map(results.filter((result) => result.success).map((result) => [result.originalUrl, result.localUrl]));
    expect(replaceRemoteUrlsInMarkdown(`![ok](${urls[0]}) ![failed](${urls[5]})`, replacements))
      .toBe(`![ok](/api/attachments/a.png) ![failed](${urls[5]})`);
  });
});
