// @vitest-environment jsdom
import React, { act } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HtmlPreviewPane from "@/components/HtmlPreviewPane";
import type { Note } from "@/types";
import type { NoteEditorHandle } from "@/components/editors/types";
import { resetAttachmentAccessStateForTests } from "@/lib/noteAttachmentAccessBridge";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
const signedRender = vi.hoisted(() => ({ query: "" }));
vi.mock("@/lib/api", () => ({
  getBaseUrl: () => "https://notes.example.com/api",
  resolveAttachmentUrl: (url: string) => url.startsWith("/api/attachments/")
    ? `http://127.0.0.1:3000${url}${signedRender.query && url.includes("123e4567-e89b-42d3-a456-426614174216") ? `?${signedRender.query}` : ""}`
    : url,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const longUrl = `https://mp.weixin.qq.com/s/${"very-long-source-url-".repeat(20)}`;
const fragment = [
  `<blockquote><p>作者：测试 · 来源：<a href="${longUrl}">${longUrl}</a></p></blockquote>`,
  `<section style="width:980px;min-width:980px;white-space:nowrap">`,
  `<p style="white-space:nowrap">手机上不能整段截断。</p>`,
  `<img src="/api/attachments/image-id" width="1200" style="width:1200px;height:700px" alt="正文配图">`,
  `</section>`,
  `<pre><code>const veryLongLine = "${"x".repeat(300)}";</code></pre>`,
  `<script>alert('unsafe')</script>`,
].join("");

function mockNote(content: string): Note {
  return { id: "note-1", content } as Note;
}

describe("HtmlPreviewPane responsive clipped article (#789)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetAttachmentAccessStateForTests();
    localStorage.clear();
    signedRender.query = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    resetAttachmentAccessStateForTests();
  });

  it("keeps imported markup read-only while applying the fragment-only responsive wrapper", async () => {
    const note = mockNote(fragment);
    const editorRef = React.createRef<NoteEditorHandle>();
    const onUpdate = vi.fn();
    await act(async () => {
      root.render(<HtmlPreviewPane ref={editorRef} note={note} onUpdate={onUpdate} />);
    });

    const article = host.querySelector<HTMLElement>(".html-preview-content");
    expect(article).not.toBeNull();
    expect(article?.parentElement?.className).toContain("min-w-0");
    expect(host.querySelector("iframe")).toBeNull();
    expect(article?.querySelector("a")?.getAttribute("href")).toBe(longUrl);
    expect(article?.querySelector("a")?.textContent).toBe(longUrl);
    expect(article?.querySelector("section")?.getAttribute("style")).toContain("min-width:980px");
    expect(article?.querySelector("img")?.getAttribute("src")).toBe("http://127.0.0.1:3000/api/attachments/image-id");
    expect(article?.querySelector("script")).toBeNull();
    expect(article?.querySelector("pre code")?.textContent).toContain("veryLongLine");
    expect(editorRef.current?.getSnapshot?.()?.content).toBe(fragment);
    expect(onUpdate).not.toHaveBeenCalled();
  });


  it("defers an imported article's unsigned images, then shows them after note-scoped signing", async () => {
    const id = "123e4567-e89b-42d3-a456-426614174216";
    const html = `<article><p>微信正文</p><img src="/api/attachments/${id}" alt="wechat"></article>`;
    localStorage.setItem("nowen-token", "jwt-token");
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn((_url: RequestInfo | URL) => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const onUpdate = vi.fn();
    await act(async () => {
      root.render(<HtmlPreviewPane note={mockNote(html)} onUpdate={onUpdate} />);
    });

    const before = host.querySelector<HTMLImageElement>('img[alt="wechat"]')!;
    expect(before.hasAttribute("src")).toBe(false);
    expect(before.dataset.nowenAttachmentPending).toBe("true");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("noteId=note-1");

    signedRender.query = "exp=2000000000&sig=ready&scope=v2.scope";
    await act(async () => {
      finish(new Response(JSON.stringify({
        urls: { [id]: `/api/attachments/${id}?${signedRender.query}` },
      }), { status: 200, headers: { "content-type": "application/json" } }));
      await Promise.resolve();
    });

    const after = host.querySelector<HTMLImageElement>('img[alt="wechat"]')!;
    expect(after.getAttribute("src")).toContain("sig=ready");
    expect(after.dataset.nowenAttachmentPending).toBeUndefined();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("scopes fixed-width, nowrap and media guards to mobile fragments while preserving scrollable tables and code", () => {
    // Vite maps import.meta.url to a browser URL under jsdom and stubs CSS imports.
    // Read the actual file from the frontend working directory instead.
    const responsiveStyles = readFileSync(resolve(process.cwd(), "src/components/HtmlPreviewPane.css"), "utf8");
    expect(responsiveStyles).toContain(".html-preview-content");
    expect(responsiveStyles).toContain("@media (max-width: 639px)");
    expect(responsiveStyles).toMatch(/:where\(a\)[\s\S]*?overflow-wrap: anywhere !important/);
    expect(responsiveStyles).toMatch(/:where\(img, picture, video, canvas, svg\)[\s\S]*?max-width: 100% !important/);
    expect(responsiveStyles).toMatch(/:where\(table, pre\)[\s\S]*?overflow-x: auto/);
    expect(responsiveStyles).toMatch(/:where\(div, section, article, p, blockquote, figure, figcaption, ul, ol, li\)[\s\S]*?min-width: 0 !important/);
    expect(responsiveStyles).toMatch(/:where\(pre, pre \*, code, code \*\)[\s\S]*?white-space: pre !important/);
  });

  it("continues rendering full-page clones in a sandboxed iframe without the fragment CSS wrapper", async () => {
    const fullPage = '<!DOCTYPE html><html><head><title>网页克隆</title></head><body><p style="width:980px">完整网页</p></body></html>';
    await act(async () => {
      root.render(<HtmlPreviewPane note={mockNote(fullPage)} onUpdate={vi.fn()} />);
    });
    const iframe = host.querySelector<HTMLIFrameElement>("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute("sandbox")).not.toContain("allow-scripts");
    expect(iframe?.getAttribute("srcdoc")).toContain("完整网页");
    expect(host.querySelector(".html-preview-content")).toBeNull();
  });
});
