import { Editor } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { EditorContent } from "@tiptap/react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import * as VideoExtension from "@/components/VideoExtension";

const { getVideoDisplayStyle, Video } = VideoExtension;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function getStopDecision(target: Element): boolean | undefined {
  let decision: boolean | undefined;
  target.addEventListener(
    "mousedown",
    (event) => {
      decision = (
        VideoExtension as typeof VideoExtension & {
          shouldStopVideoNodeEvent?: (props: { event: Event }) => boolean;
        }
      ).shouldStopVideoNodeEvent?.({ event });
    },
    { once: true },
  );
  target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  return decision;
}

async function renderVideoNodeView() {
  const handleMouseDown = vi.fn();
  const editor = new Editor({
    extensions: [Document, Paragraph, Text, Video],
    content: {
      type: "doc",
      content: [
        {
          type: "video",
          attrs: {
            src: "/api/attachments/att-video?inline=1",
            originalUrl: "/api/attachments/att-video",
            platform: "file",
            kind: "file",
            filename: "clip.mp4",
          },
        },
      ],
    },
    editorProps: {
      handleDOMEvents: {
        mousedown: () => {
          handleMouseDown();
          return true;
        },
      },
    },
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(EditorContent, { editor }));
  });

  const wrapper = host.querySelector<HTMLElement>(".video-node-wrapper");
  const video = wrapper?.querySelector<HTMLVideoElement>("video");
  expect(wrapper).not.toBeNull();
  expect(video).not.toBeNull();

  await act(async () => {
    wrapper!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
  const toolbar = wrapper!.querySelector<HTMLElement>("[data-video-toolbar]");
  expect(toolbar).not.toBeNull();

  return {
    editor,
    handleMouseDown,
    host,
    root,
    toolbar: toolbar!,
    video: video!,
    wrapper: wrapper!,
  };
}

describe("VideoExtension file uploads", () => {
  it("inserts uploaded video attachments as file video nodes", () => {
    const editor = new Editor({
      extensions: [Document, Paragraph, Text, Video],
      content: "<p>hello</p>",
    });

    const ok = (editor.commands as any).setVideoFile({
      previewUrl: "/api/attachments/att-video?inline=1",
      url: "/api/attachments/att-video",
      attachmentId: "att-video",
      filename: "clip.mp4",
      mimeType: "video/mp4",
      size: 1024,
    });

    expect(ok).toBe(true);
    const videoNode = editor.getJSON().content?.find((node) => node.type === "video");
    expect(videoNode?.attrs).toMatchObject({
      src: "/api/attachments/att-video?inline=1",
      originalUrl: "/api/attachments/att-video",
      platform: "file",
      kind: "file",
      attachmentId: "att-video",
      filename: "clip.mp4",
      mimeType: "video/mp4",
      size: 1024,
    });
    expect(editor.getHTML()).toContain("playsinline");
  });

  it("keeps same-origin access for allowlisted iframe video players", () => {
    const editor = new Editor({
      extensions: [Document, Paragraph, Text, Video],
      content: {
        type: "doc",
        content: [{
          type: "video",
          attrs: {
            src: "https://player.bilibili.com/player.html?bvid=BV1xx411c7mD",
            platform: "bilibili",
            kind: "iframe",
          },
        }],
      },
    });

    expect(editor.getHTML()).toContain('sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"');
  });

  it("uses a compact portrait card for vertical video ratios", () => {
    const style = getVideoDisplayStyle(9 / 16);

    expect(style.wrapper.maxWidth).toBe("min(320px, 100%)");
    expect(style.video.width).toBe("min(320px, calc(100vw - 48px))");
    expect(style.video.aspectRatio).toBe(String(9 / 16));
  });

  it("uses a medium card for landscape video ratios", () => {
    const style = getVideoDisplayStyle(16 / 9);

    expect(style.wrapper.maxWidth).toBe("min(640px, 100%)");
    expect(style.video.width).toBe("min(640px, 100%)");
    expect(style.video.aspectRatio).toBe(String(16 / 9));
  });

  it("uses a compact fallback before video metadata is loaded", () => {
    const style = getVideoDisplayStyle(null);

    expect(style.wrapper.maxWidth).toBe("min(480px, 100%)");
    expect(style.video.width).toBe("min(480px, 100%)");
    expect(style.video.aspectRatio).toBe("16 / 9");
  });
});

describe("VideoExtension NodeView events", () => {
  it("keeps native video control events away from ProseMirror", () => {
    const video = document.createElement("video");

    expect(getStopDecision(video)).toBe(true);
  });

  it("keeps toolbar descendant events away from ProseMirror", () => {
    const toolbar = document.createElement("div");
    toolbar.setAttribute("data-video-toolbar", "");
    const icon = document.createElement("span");
    toolbar.append(icon);

    expect(getStopDecision(icon)).toBe(true);
  });

  it("leaves ordinary video node events to ProseMirror", () => {
    const wrapper = document.createElement("div");

    expect(getStopDecision(wrapper)).toBe(false);
  });

  it("wires the event boundary into the rendered NodeView", async () => {
    const fixture = await renderVideoNodeView();
    try {
      await act(async () => {
        fixture.video.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        fixture.toolbar.firstElementChild?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      });
      expect(fixture.handleMouseDown).not.toHaveBeenCalled();

      await act(async () => {
        fixture.wrapper.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      });
      expect(fixture.handleMouseDown).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => {
        fixture.root.unmount();
      });
      fixture.editor.destroy();
      fixture.host.remove();
    }
  });
});
