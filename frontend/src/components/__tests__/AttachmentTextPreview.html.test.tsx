// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AttachmentPreview from "@/components/attachmentPreview/AttachmentPreview";
import { sanitizeAttachmentHtmlForPreview } from "@/lib/attachmentHtmlPreview";

vi.mock("react-i18next", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-i18next")>(),
  useTranslation: () => ({ t: (value: string) => value, i18n: { language: "zh-CN" } }),
}));
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(async () => true) }));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RESUME_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <style>:root{--ink:#171c24}.page{width:210mm;color:var(--ink)}</style>
</head>
<body>
  <main class="page">
    <h1>个人简历</h1>
    <a href="https://example.com/portfolio">作品集</a>
    <a href="#experience">工作经历</a>
    <img src="data:image/png;base64,iVBORw0KGgo=" alt="avatar">
  </main>
  <script>window.__xss = true;</script>
</body>
</html>`;

function mockResponse(text: string, status = 200) {
  return { ok: true, status, arrayBuffer: async () => new TextEncoder().encode(text).buffer };
}

describe("HTML attachment preview", () => {
  let host: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    fetchMock = vi.fn().mockResolvedValue(mockResponse(RESUME_HTML));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  async function renderAttachment(filename = "简历.html", mimeType = "text/html; charset=utf-8", size = RESUME_HTML.length) {
    await act(async () => {
      root.render(<AttachmentPreview url="/api/attachments/html-file" filename={filename} mimeType={mimeType} size={size} />);
    });
    for (let i = 0; i < 20; i++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      if (host.querySelector("iframe") || host.querySelector("pre")) return;
    }
    throw new Error(`HTML preview did not render: ${host.innerHTML}`);
  }

  it("renders .html attachments in a scriptless opaque-origin sandbox iframe with HTML badge", async () => {
    await renderAttachment();

    expect(fetchMock).toHaveBeenCalledWith("/api/attachments/html-file", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    const iframe = host.querySelector("iframe");
    expect(iframe).not.toBeNull();
    const sandbox = iframe?.getAttribute("sandbox") || "";
    expect(sandbox).not.toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
    expect(sandbox).toContain("allow-popups");
    expect(iframe?.getAttribute("referrerpolicy")).toBe("no-referrer");

    const srcDoc = iframe?.getAttribute("srcdoc") || "";
    expect(srcDoc).toContain("个人简历");
    expect(srcDoc).toContain(":root{--ink:#171c24}");
    expect(srcDoc).not.toContain("<script");
    expect(srcDoc).toContain('http-equiv="Content-Security-Policy"');
    expect(srcDoc).toContain("script-src 'none'");

    const badge = host.querySelector(".font-mono");
    expect(badge?.textContent?.trim().toLowerCase()).toBe("html");
  });

  it("switches between rendered HTML view and untouched HTML source without re-fetching", async () => {
    await renderAttachment("resume.htm", "application/octet-stream");

    const tabs = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(tabs).toHaveLength(2);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector("iframe")).not.toBeNull();

    await act(async () => { tabs[1].click(); });
    expect(host.querySelector("iframe")).toBeNull();
    expect(host.querySelector("pre")?.textContent).toBe(RESUME_HTML);
    expect(host.textContent).toContain("折行");

    await act(async () => { tabs[0].click(); });
    expect(host.querySelector("iframe")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("strips dangerous tags, event handlers, and script URLs while keeping styles and safe links", () => {
    const dirty = `<!doctype html>
    <html>
      <head>
        <base href="https://evil.example/">
        <meta http-equiv="refresh" content="0;url=https://evil.example">
        <style>body { font-family: sans-serif; }</style>
      </head>
      <body onload="alert(1)">
        <script>alert(2)</script>
        <iframe src="https://evil.example"></iframe>
        <object data="https://evil.example/x.swf"></object>
        <img src="data:image/png;base64,abc" onerror="alert(3)">
        <a id="bad" href="  java&#10;script:alert(4)">bad</a>
        <a id="ext" href="https://nowen.example/doc">ext</a>
        <a id="anchor" href="#section-1">anchor</a>
      </body>
    </html>`;

    const clean = sanitizeAttachmentHtmlForPreview(dirty);
    const parsed = new DOMParser().parseFromString(clean, "text/html");

    expect(parsed.querySelector("script")).toBeNull();
    expect(parsed.querySelector("iframe")).toBeNull();
    expect(parsed.querySelector("object")).toBeNull();
    expect(parsed.querySelector("base")).toBeNull();
    expect(parsed.querySelector('meta[http-equiv="refresh"]')).toBeNull();
    expect(parsed.body.hasAttribute("onload")).toBe(false);
    expect(parsed.querySelector("img")?.hasAttribute("onerror")).toBe(false);
    expect(parsed.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,abc");
    expect(parsed.querySelector("#bad")?.hasAttribute("href")).toBe(false);

    const extLink = parsed.querySelector("#ext");
    expect(extLink?.getAttribute("target")).toBe("_blank");
    expect(extLink?.getAttribute("rel")).toBe("noopener noreferrer");

    const anchorLink = parsed.querySelector("#anchor");
    expect(anchorLink?.getAttribute("href")).toBe("#section-1");
    expect(anchorLink?.hasAttribute("target")).toBe(false);

    expect(parsed.querySelector("style")?.textContent).toContain("font-family: sans-serif");
  });

  it("preserves the 2MB Range guard and truncated notice for large HTML attachments", async () => {
    fetchMock.mockResolvedValue(mockResponse("<!doctype html><html><body><h1>大文件</h1></body></html>", 206));
    await renderAttachment("large.html", "text/html", 2 * 1024 * 1024 + 1);

    expect(fetchMock).toHaveBeenCalledWith("/api/attachments/html-file", expect.objectContaining({
      headers: { Range: "bytes=0-204799" },
    }));
    expect(host.textContent).toContain("已截断");
    expect(host.querySelector("iframe")).not.toBeNull();
  });
});
