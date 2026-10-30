import { describe, expect, it, vi } from "vitest";
import { generateJSON, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { api } from "../api";
import { preparePastedImages, rescuePastedImages } from "../pastedImages";
import { extractRemoteImageUrls, localizeRemoteImages, replaceRemoteUrlsInHtml } from "../remoteImageLocalizer";

vi.mock("../api", () => ({ api: { attachments: { importRemoteImage: vi.fn() } } }));
vi.mock("../toast", () => ({ toast: {} }));

function prepare(html: string) {
  const result = preparePastedImages(html);
  const root = document.createElement("div");
  root.innerHTML = result.html;
  rescuePastedImages(root);
  return { ...result, root };
}

describe("web image paste recovery", () => {
  it.each([
    ['<img srcset="https://cdn.test/small.png 1x, https://cdn.test/large.png 2x">', "https://cdn.test/large.png"],
    ['<picture><source srcset="https://cdn.test/large.png 1280w"><img></picture>', "https://cdn.test/large.png"],
    ['<img src="//cdn.test/image.png">', "https://cdn.test/image.png"],
    ['<img zoomfile="https://cdn.test/image.png">', "https://cdn.test/image.png"],
    ['<img src="blob:https://www.yuque.com/temporary" data-src="https://cdn.test/image.png">', "https://cdn.test/image.png"],
    ['<img data-src="javascript:alert(1)" data-original="https://cdn.test/image.png">', "https://cdn.test/image.png"],
    ['<img data-src="/missing-origin.png" srcset="https://cdn.test/image.png 2x">', "https://cdn.test/image.png"],
  ])("recovers safe addresses before sanitizing: %s", (html, expected) => {
    const result = prepare(html);
    expect(result.root.querySelector("img")?.getAttribute("src")).toBe(expected);
    expect(result.imageStats.failed).toBe(0);
    expect(extractRemoteImageUrls(result.html).map((image) => image.originalUrl)).toEqual([expected]);
  });

  it("keeps valid source images instead of replacing them with alternate addresses", () => {
    const result = prepare('<img src="https://cdn.test/image.png" data-src="https://cdn.test/other.png">');
    expect(result.root.querySelector("img")?.getAttribute("src")).toBe("https://cdn.test/image.png");
    expect(result.imageStats).toEqual({ total: 1, rescued: 0, failed: 0 });
  });

  it("preserves a valid source even when URL normalization would change its spelling", () => {
    const result = prepare('<img src="https://cdn.test" data-src="https://cdn.test/other.png">');
    expect(result.root.querySelector("img")?.getAttribute("src")).toBe("https://cdn.test");
  });

  it("resolves relative sources using the source fragment and preserves placeholder fallbacks", () => {
    const result = prepare('<a href="https://source.test/article">article</a><img src="/images/photo.png"><img src="about:blank" data-src="https://cdn.test/photo.png">');
    expect([...result.root.querySelectorAll("img")].map((img) => img.getAttribute("src")))
      .toEqual(["https://source.test/images/photo.png", "https://cdn.test/photo.png"]);
    expect(result.imageStats.failed).toBe(0);
  });

  it("keeps Word image positions for RTF recovery without allowing local file access", () => {
    const result = preparePastedImages('<p>before</p><p><img src="file:///tmp/image.png"></p><p>after</p>');
    const root = document.createElement("div");
    root.innerHTML = result.html;
    expect(root.children[1].querySelector("img")).not.toBeNull();
    expect(root.children[1].querySelector("img")?.hasAttribute("src")).toBe(false);
    // 模拟 RTF 按位置回填的真实图片，不应再次判为失败。
    root.querySelector("img")!.setAttribute("src", `data:image/png;base64,${"a".repeat(300)}`);
    expect(rescuePastedImages(root).failed).toBe(0);
    expect(root.children[1].querySelector("img")).not.toBeNull();
  });

  it("keeps an image-only fragment routable and counts unavailable images once at insertion", () => {
    const result = preparePastedImages('<img src="blob:https://www.yuque.com/temporary">'.repeat(55));
    expect(result.html).not.toBe("");
    const root = document.createElement("div");
    root.innerHTML = result.html;
    expect(root.querySelectorAll("img")).toHaveLength(55);
    expect(rescuePastedImages(root).failed).toBe(55);
    expect(root.querySelectorAll("img")).toHaveLength(0);
  });

  it("keeps localized attachments through the second normalization pass", () => {
    const result = prepare('<img data-src="https://cdn.test/image.png">');
    result.root.innerHTML = replaceRemoteUrlsInHtml(result.html, new Map([["https://cdn.test/image.png", "/api/attachments/image-id"]]));
    expect(rescuePastedImages(result.root).failed).toBe(0);
    expect(result.root.querySelector("img")?.getAttribute("src")).toBe("/api/attachments/image-id");
    expect(extractRemoteImageUrls(result.root.innerHTML)).toEqual([]);
  });

  it("localizes recovered sources and inserts attachment URLs into the rich-text document", async () => {
    const upload = vi.mocked(api.attachments.importRemoteImage);
    upload.mockReset();
    upload.mockResolvedValue({ url: "/api/attachments/image-id" } as Awaited<ReturnType<typeof api.attachments.importRemoteImage>>);
    const result = preparePastedImages('<p>article</p><img srcset="https://cdn.test/photo.png 2x"><img data-src="https://cdn.test/photo.png">');
    const sources = extractRemoteImageUrls(result.html).map((image) => image.originalUrl);
    const localized = await localizeRemoteImages(sources, "note-id", "paste");
    const root = document.createElement("div");
    root.innerHTML = replaceRemoteUrlsInHtml(result.html, new Map(localized.map((image) => [image.originalUrl, image.localUrl])));
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledWith("note-id", "https://cdn.test/photo.png", "paste");
    expect(rescuePastedImages(root).failed).toBe(0);
    const doc: JSONContent = generateJSON(root.innerHTML, [StarterKit, Image]);
    expect(doc.content?.filter((node) => node.type === "image").map((node) => node.attrs?.src))
      .toEqual(["/api/attachments/image-id", "/api/attachments/image-id"]);
  });

  it.each(["javascript:alert(1)", "file:///tmp/image.png", "blob:https://www.yuque.com/temporary", "data:image/svg+xml;base64,PHN2Zz4=", "https:invalid", "/unresolved.png"])("reports an unusable image without retaining its unsafe address: %s", (src) => {
    const result = prepare(`<p>before<img src="${src}">after</p>`);
    expect(result.root.querySelector("img")).toBeNull();
    expect(result.root.textContent).toBe("beforeafter");
    expect(result.imageStats.failed).toBe(1);
  });

  it("still removes scripts and event handlers after recovering images", () => {
    const result = prepare('<script>alert(1)</script><img srcset="https://cdn.test/image.png 2x" onerror="alert(1)"><a href="javascript:alert(1)">link</a>');
    expect(result.root.querySelector("script")).toBeNull();
    expect(result.root.querySelector("img")?.hasAttribute("onerror")).toBe(false);
    expect(result.root.querySelector("a")?.hasAttribute("href")).toBe(false);
    expect(result.root.querySelector("img")?.getAttribute("src")).toBe("https://cdn.test/image.png");
  });

  it("reports all 55 unavailable images while retaining text and usable images", () => {
    const result = prepare('<p>text</p>' + '<img>'.repeat(55) + '<img src="https://cdn.test/image.png">');
    expect(result.imageStats).toEqual({ total: 56, rescued: 0, failed: 55 });
    expect(result.root.querySelectorAll("img")).toHaveLength(1);
    expect(result.root.textContent).toBe("text");
  });
});
