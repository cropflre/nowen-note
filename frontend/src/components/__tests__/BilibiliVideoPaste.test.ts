// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { afterEach, describe, expect, it } from "vitest";

import {
  BilibiliVideoPasteHandler,
  parseStandaloneBilibiliVideoPaste,
} from "@/components/MarkdownEnhancements";
import { Video } from "@/components/VideoExtension";

const editors: Editor[] = [];
const hosts: HTMLElement[] = [];

function createEditor(): Editor {
  const host = document.createElement("div");
  document.body.appendChild(host);
  hosts.push(host);

  const editor = new Editor({
    element: host,
    extensions: [Document, Paragraph, Text, BilibiliVideoPasteHandler, Video],
    content: "<p></p>",
  });
  editors.push(editor);
  return editor;
}

function dispatchPaste(editor: Editor, text: string): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      getData: (type: string) => type === "text/plain" ? text : "",
    },
  });
  editor.view.dom.dispatchEvent(event);
  return event;
}

afterEach(() => {
  while (editors.length) editors.pop()?.destroy();
  while (hosts.length) hosts.pop()?.remove();
});

describe("Bilibili video paste", () => {
  const url = "https://www.bilibili.com/video/BV1mwMc6uEdX/?spm_id_from=333.1007.tianma.3-4-10.click&vd_source=b4f3d938cdbe6b42748e81a63e3b9ce9";

  it("normalizes a standalone Bilibili URL into safe iframe attributes", () => {
    expect(parseStandaloneBilibiliVideoPaste(url)).toEqual({
      src: "https://player.bilibili.com/player.html?bvid=BV1mwMc6uEdX&autoplay=0&high_quality=1",
      platform: "bilibili",
      kind: "iframe",
      originalUrl: url,
    });
  });

  it("inserts a video node when the standalone URL is pasted", () => {
    const editor = createEditor();
    const event = dispatchPaste(editor, url);
    const videoNode = editor.getJSON().content?.find((node) => node.type === "video");

    expect(event.defaultPrevented).toBe(true);
    expect(videoNode).toMatchObject({
      type: "video",
      attrs: {
        src: "https://player.bilibili.com/player.html?bvid=BV1mwMc6uEdX&autoplay=0&high_quality=1",
        platform: "bilibili",
        kind: "iframe",
        originalUrl: url,
      },
    });
  });

  it("does not convert prose containing a Bilibili URL", () => {
    expect(parseStandaloneBilibiliVideoPaste(`参考链接：${url}`)).toBeNull();
  });
});
