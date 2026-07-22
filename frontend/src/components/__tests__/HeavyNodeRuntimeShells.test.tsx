// @vitest-environment jsdom

import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Editor } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { EditorContent } from "@tiptap/react";
import { afterEach, describe, expect, it } from "vitest";
import { Video } from "@/components/VideoExtension";
import MermaidView from "@/components/MermaidView";
import { resolveEditorRuntimeDecision } from "@/lib/editorRuntimePolicy";
import {
  clearActiveEditorRuntimeDecision,
  setActiveEditorRuntimeDecision,
} from "@/lib/editorRuntimeStore";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function lightweightDecision() {
  return resolveEditorRuntimeDecision({
    content: `{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"${"x".repeat(400_000)}"}]}]}`,
    contentFormat: "tiptap-json",
  });
}

function mediaDocument(attrs: Record<string, unknown>) {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Keep the initial cursor outside the media node." }],
      },
      { type: "video", attrs },
    ],
  };
}

async function renderMediaNode(attrs: Record<string, unknown>) {
  const editor = new Editor({
    extensions: [Document, Paragraph, Text, Video],
    content: mediaDocument(attrs),
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(EditorContent, { editor }));
  });
  return { editor, host, root };
}

afterEach(() => {
  clearActiveEditorRuntimeDecision();
  document.body.innerHTML = "";
});

describe("heavy node runtime shells", () => {
  it("does not create a video element in lightweight mode until the user requests it", async () => {
    setActiveEditorRuntimeDecision("video-note", lightweightDecision());
    const fixture = await renderMediaNode({
      src: "/api/attachments/video-1?inline=1",
      originalUrl: "/api/attachments/video-1",
      platform: "file",
      kind: "file",
      filename: "large.mp4",
    });

    try {
      expect(fixture.host.querySelector("[data-video-placeholder]")).not.toBeNull();
      expect(fixture.host.querySelector("video")).toBeNull();
      expect(fixture.host.querySelector("iframe")).toBeNull();

      await act(async () => {
        fixture.host.querySelector<HTMLButtonElement>("[data-video-placeholder] button")?.click();
      });

      expect(fixture.host.querySelector("[data-video-placeholder]")).toBeNull();
      expect(fixture.host.querySelector("video")).not.toBeNull();
    } finally {
      await act(async () => fixture.root.unmount());
      fixture.editor.destroy();
      fixture.host.remove();
    }
  });

  it("does not create an iframe in lightweight mode until the user requests it", async () => {
    setActiveEditorRuntimeDecision("iframe-note", lightweightDecision());
    const fixture = await renderMediaNode({
      src: "https://www.youtube-nocookie.com/embed/example",
      originalUrl: "https://www.youtube.com/watch?v=example",
      platform: "youtube",
      kind: "iframe",
    });

    try {
      expect(fixture.host.querySelector("[data-video-placeholder]")).not.toBeNull();
      expect(fixture.host.querySelector("iframe")).toBeNull();

      await act(async () => {
        fixture.host.querySelector<HTMLButtonElement>("[data-video-placeholder] button")?.click();
      });

      expect(fixture.host.querySelector("[data-video-placeholder]")).toBeNull();
      expect(fixture.host.querySelector("iframe")).not.toBeNull();
    } finally {
      await act(async () => fixture.root.unmount());
      fixture.editor.destroy();
      fixture.host.remove();
    }
  });

  it("keeps Mermaid parsing and SVG creation behind the lightweight placeholder", async () => {
    setActiveEditorRuntimeDecision("mermaid-note", lightweightDecision());
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          <MermaidView
            source={"flowchart TD\n  A --> B"}
            debounceMs={0}
          />,
        );
      });

      expect(host.querySelector("[data-mermaid-runtime-state=deferred]")).not.toBeNull();
      expect(host.querySelector(".mermaid-view-loading")).toBeNull();
      expect(host.querySelector(".mermaid-view-svg")).toBeNull();
      expect(host.textContent).toContain("需手动加载");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
