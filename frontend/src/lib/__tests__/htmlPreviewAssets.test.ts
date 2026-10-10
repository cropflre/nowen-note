// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { resolveHtmlPreviewAssetUrls } from "@/lib/htmlPreviewAssets";

describe("htmlPreviewAssets", () => {
  it("resolves local attachment image urls before rendering HTML preview", () => {
    const html = [
      '<p><img src="/api/attachments/local-image" alt="local"></p>',
      '<p><img src="https://mmbiz.qpic.cn/remote.jpg" alt="remote"></p>',
      '<p><img src="data:image/png;base64,abc" alt="data"></p>',
    ].join("");

    const result = resolveHtmlPreviewAssetUrls(
      html,
      (src) => (src.startsWith("/api/attachments/") ? `http://127.0.0.1:3000${src}` : src),
    );

    expect(result).toContain('src="http://127.0.0.1:3000/api/attachments/local-image"');
    expect(result).toContain('src="https://mmbiz.qpic.cn/remote.jpg"');
    expect(result).toContain('src="data:image/png;base64,abc"');
  });
  it("defers unsigned UUID images and srcset in both HTML modes, then upgrades without mutating storage", () => {
    const id = "123e4567-e89b-42d3-a456-426614174216";
    const raw = [
      `<picture><source srcset="/api/attachments/${id} 1x, /api/attachments/${id}?w=720 2x">`,
      `<img src="/api/attachments/${id}" srcset="/api/attachments/${id}?w=360 360w" alt="wechat"></picture>`,
      '<img src="https://mmbiz.qpic.cn/remote.jpg" alt="remote">',
    ].join("");
    let signed = false;
    const resolve = (src: string) => {
      if (!signed || !src.includes("/api/attachments/")) return src;
      return `${src}${src.includes("?") ? "&" : "?"}exp=2000000000&sig=valid&scope=v2.scope`;
    };

    const initial = resolveHtmlPreviewAssetUrls(raw, resolve, { deferUnsignedAttachments: true });
    const initialDoc = new DOMParser().parseFromString(initial, "text/html");
    const initialImage = initialDoc.querySelector<HTMLImageElement>('img[alt="wechat"]')!;
    expect(initialImage.hasAttribute("src")).toBe(false);
    expect(initialImage.hasAttribute("srcset")).toBe(false);
    expect(initialImage.dataset.nowenAttachmentPending).toBe("true");
    expect(initialDoc.querySelector("source")?.hasAttribute("srcset")).toBe(false);
    expect(initialDoc.querySelector<HTMLImageElement>('img[alt="remote"]')?.src).toBe("https://mmbiz.qpic.cn/remote.jpg");

    signed = true;
    const ready = resolveHtmlPreviewAssetUrls(raw, resolve, { deferUnsignedAttachments: true });
    const readyDoc = new DOMParser().parseFromString(ready, "text/html");
    expect(readyDoc.querySelector<HTMLImageElement>('img[alt="wechat"]')?.getAttribute("src")).toContain("sig=valid");
    expect(readyDoc.querySelector('img[alt="wechat"]')?.getAttribute("srcset")).toContain("sig=valid");
    expect(readyDoc.querySelector("source")?.getAttribute("srcset")).toContain("sig=valid");
    expect(raw).not.toContain("sig=valid");
    expect(raw).toContain(`src="/api/attachments/${id}"`);

    const documentHtml = `<!DOCTYPE html><html><body>${raw}</body></html>`;
    const deferredDocument = resolveHtmlPreviewAssetUrls(documentHtml, (src) => src, {
      fullDocument: true,
      deferUnsignedAttachments: true,
    });
    expect(deferredDocument).toMatch(/^<!DOCTYPE html>/);
    const doc = new DOMParser().parseFromString(deferredDocument, "text/html");
    expect(doc.querySelector('img[alt="wechat"]')?.hasAttribute("src")).toBe(false);
    expect(doc.querySelector("source")?.hasAttribute("srcset")).toBe(false);
  });

  it("does not expose unsigned attachment image URLs to DOMParser or sanitizer before authorization", () => {
    const id = "5bc403c1-2c1f-4541-ba2a-c8e9ab1b5fbd";
    const raw = `<blockquote><p>微信正文</p></blockquote><picture><source srcset="/api/attachments/${id} 2x"><img src="/api/attachments/${id}" alt="wechat"></picture>`;
    const parse = DOMParser.prototype.parseFromString;
    const parserSpy = vi.spyOn(DOMParser.prototype, "parseFromString").mockImplementation(function (
      this: DOMParser, html: string, type: DOMParserSupportedType,
    ) {
      expect(html).not.toMatch(/<img[^>]+src=["']\/api\/attachments\//);
      expect(html).not.toMatch(/<source[^>]+srcset=["']\/api\/attachments\//);
      return parse.call(this, html, type);
    });
    const sanitize = vi.fn((html: string) => {
      expect(html).not.toMatch(/<img[^>]+src=["']\/api\/attachments\//);
      return html;
    });
    try {
      const initial = resolveHtmlPreviewAssetUrls(raw, (src) => src, {
        deferUnsignedAttachments: true,
        sanitizeHtml: sanitize,
      });
      expect(initial).toContain('data-nowen-attachment-pending="true"');
      expect(initial).not.toContain(`src="/api/attachments/${id}"`);
      expect(initial).not.toContain("data-nowen-preview-src-token");
      expect(sanitize).toHaveBeenCalledTimes(1);
      expect(parserSpy).toHaveBeenCalledTimes(1);

      const signed = resolveHtmlPreviewAssetUrls(raw, (src) =>
        src.startsWith("/api/attachments/") ? `${src}?exp=2000000000&sig=ok&scope=note` : src,
        { deferUnsignedAttachments: true, sanitizeHtml: sanitize },
      );
      expect(signed).toContain("sig=ok");
      expect(signed).not.toContain("data-nowen-preview-src-token");
    } finally {
      parserSpy.mockRestore();
    }
  });

  it("defers bare video/audio and poster before authorizing the media URL", () => {
    const id = "123e4567-e89b-42d3-a456-426614174216";
    const raw = '<video src="/api/attachments/' + id + '" poster="/api/attachments/' + id + '"><source src="/api/attachments/' + id + '"></video><audio><source src="/api/attachments/' + id + '"></audio>';
    const deferred = resolveHtmlPreviewAssetUrls(raw, (src) => src, { deferUnsignedAttachments: true });
    const doc = new DOMParser().parseFromString(deferred, "text/html");
    expect(doc.querySelector("video")?.hasAttribute("src")).toBe(false);
    expect(doc.querySelector("video")?.hasAttribute("poster")).toBe(false);
    expect(doc.querySelector("video source")?.hasAttribute("src")).toBe(false);
    expect(doc.querySelector("audio source")?.hasAttribute("src")).toBe(false);
    const signed = resolveHtmlPreviewAssetUrls(raw, (src) => src.includes("/api/attachments/") ? src + "?exp=123&sig=ok&scope=note" : src, { deferUnsignedAttachments: true });
    expect(signed).toContain("sig=ok");
    expect(signed).not.toContain("data-nowen-preview-src-token");
    expect(raw).not.toContain("sig=ok");
  });
  it("preserves deliberately shared URLs and signed URLs without network gating", () => {
    const id = "123e4567-e89b-42d3-a456-426614174216";
    const html = `<img src="/api/attachments/${id}?share=public-token"><img src="/api/attachments/${id}?exp=123&sig=ok&scope=owner">`;
    const result = resolveHtmlPreviewAssetUrls(html, (src) => src, { deferUnsignedAttachments: true });
    const imgs = new DOMParser().parseFromString(result, "text/html").querySelectorAll("img");
    expect(imgs.length).toBe(2);
    expect(imgs[0].getAttribute("src")).toContain("share=public-token");
    expect(imgs[1].getAttribute("src")).toContain("sig=ok");
  });

});
