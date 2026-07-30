// @vitest-environment jsdom

import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import SiyuanRichTextCalloutBridge from "@/components/SiyuanRichTextCalloutBridge";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("SiyuanRichTextCalloutBridge", () => {
  it("decorates Callouts inserted into the actual Tiptap editor root after mount", async () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<SiyuanRichTextCalloutBridge />);
    });

    document.body.insertAdjacentHTML(
      "beforeend",
      '<div class="prose prose-sm max-w-none focus:outline-none min-h-[300px] px-1" contenteditable="true" spellcheck="false"><blockquote><p>[!TIP] Tip 💡</p><p>正文</p></blockquote></div>',
    );

    await act(async () => {
      await Promise.resolve();
      callbacks.splice(0).forEach((callback) => callback(0));
    });

    const editorRoot = document.querySelector<HTMLElement>('.prose[contenteditable="true"]');
    const blockquote = editorRoot?.querySelector("blockquote");
    expect(editorRoot).not.toBeNull();
    expect(editorRoot?.classList.contains("ProseMirror")).toBe(false);
    expect(blockquote?.classList.contains("nowen-siyuan-callout")).toBe(true);
    expect(blockquote?.getAttribute("data-callout-type")).toBe("tip");
    expect(blockquote?.querySelector("p")?.getAttribute("data-callout-title")).toBe("Tip");

    await act(async () => {
      root.unmount();
    });
  });
});
