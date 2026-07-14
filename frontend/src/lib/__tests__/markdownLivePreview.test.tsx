// @vitest-environment jsdom

import React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";

vi.mock("@/components/MarkdownPreview", () => ({
  MarkdownPreview: ({ markdown: source }: { markdown: string }) => (
    <div data-testid="preview-block">{source}</div>
  ),
}));

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
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("markdownLivePreviewExtension", () => {
  it("keeps complete quote lines so live callouts receive the same markdown as full preview", () => {
    const doc = "编辑中的段落\n\n> [!TIP]\n> 提示正文\n\n尾部段落";
    const state = EditorState.create({
      doc,
      selection: { anchor: 1 },
      extensions: [markdown()],
    });

    const callout = collectMarkdownLivePreviewBlocks(state).find((block) => block.markdown.includes("[!TIP]"));
    expect(callout?.markdown).toBe("> [!TIP]\n> 提示正文");
    expect(callout?.from).toBe(doc.indexOf("> [!TIP]"));
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
