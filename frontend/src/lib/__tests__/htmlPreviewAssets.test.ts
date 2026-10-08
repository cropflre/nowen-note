// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
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
