// @vitest-environment jsdom
import React, { act } from "react";
import { readFileSync } from "node:fs";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HtmlPreviewPane from "@/components/HtmlPreviewPane";
import type { Note } from "@/types";
import type { NoteEditorHandle } from "@/components/editors/types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/api", () => ({
  resolveAttachmentUrl: (url: string) => url.startsWith("/api/attachments/") ? `http://127.0.0.1:3000${url}` : url,
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
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.clearAllMocks();
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

  it("scopes fixed-width, nowrap and media guards to mobile fragments while preserving scrollable tables and code", () => {
    // Vitest's default CSS transform provides an empty module, even with ?raw.
    // Inspect the real source so that this test catches deleted/changed layout rules.
    const responsiveStyles = readFileSync(new URL("../HtmlPreviewPane.css", import.meta.url), "utf8");
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
