// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import {
  collectMarkdownLivePreviewBlocks,
  markdownLivePreviewExtension,
} from "@/lib/markdownLivePreview";

beforeAll(() => {
  if (!(globalThis as any).ResizeObserver) {
    (globalThis as any).ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (!globalThis.requestAnimationFrame) {
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback) =>
      globalThis.setTimeout(() => callback(Date.now()), 0) as unknown as number;
    globalThis.cancelAnimationFrame = (id: number) => globalThis.clearTimeout(id);
  }
  if (!globalThis.matchMedia) {
    globalThis.matchMedia = (() => ({
      matches: false,
      media: "",
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    })) as typeof globalThis.matchMedia;
  }
});

afterEach(() => {
  document.body.innerHTML = "";
});

async function flushPreview() {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

describe("markdownLivePreviewExtension", () => {
  it("keeps imported quote lines and trailing SiYuan IAL in one semantic block", () => {
    const doc = [
      "编辑中的段落",
      "",
      "> [!TIP]- 提示",
      "> 提示正文",
      '{: id="20260719010101-abcdefg"}',
      "",
      "尾部段落",
    ].join("\n");
    const state = EditorState.create({
      doc,
      selection: { anchor: 1 },
      extensions: [markdown()],
    });

    const callout = collectMarkdownLivePreviewBlocks(state).find((block) => block.markdown.includes("[!TIP]"));
    expect(callout?.markdown).toBe(
      '> [!TIP]- 提示\n> 提示正文\n{: id="20260719010101-abcdefg"}',
    );
    expect(callout?.from).toBe(doc.indexOf("> [!TIP]"));
  });

  it("renders an inactive imported TIP through the real MarkdownPreview plugin chain", async () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const doc = "> [!TIP] 温馨提示\n> 真实导入正文\n\n当前编辑段落";
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        selection: { anchor: doc.lastIndexOf("当前") },
        extensions: [markdown(), markdownLivePreviewExtension],
      }),
    });

    await flushPreview();
    const callout = parent.querySelector(".cm-live-preview-render blockquote");
    expect(callout).not.toBeNull();
    expect(callout?.textContent).toContain("温馨提示");
    expect(callout?.textContent).toContain("真实导入正文");
    expect(callout?.className).toContain("emerald");
    view.destroy();
  });

  it("installs block replacements without using a ViewPlugin decoration source", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const doc = "# Rendered heading\n\nRendered paragraph\n\nEditing paragraph";

    const state = EditorState.create({
      doc,
      selection: { anchor: doc.lastIndexOf("Editing") },
      extensions: [markdown(), markdownLivePreviewExtension],
    });

    let view: EditorView | undefined;
    expect(() => {
      view = new EditorView({ state, parent });
    }).not.toThrow();

    expect(parent.querySelector(".cm-live-preview-block")).not.toBeNull();
    view?.destroy();
  });

  it("rebuilds block replacements when the active source block changes", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const doc = "First paragraph\n\nSecond paragraph";
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        selection: { anchor: 1 },
        extensions: [markdown(), markdownLivePreviewExtension],
      }),
    });

    expect(() => {
      view.dispatch({ selection: { anchor: doc.lastIndexOf("Second") } });
    }).not.toThrow();
    expect(parent.querySelector(".cm-live-preview-block")).not.toBeNull();

    view.destroy();
  });
});
