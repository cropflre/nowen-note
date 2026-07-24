import React, { act } from "react";
import { EditorView } from "@codemirror/view";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Note } from "@/types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue || _key,
  }),
}));

vi.mock("@/components/TagInput", () => ({ default: () => null }));

vi.mock("@/lib/markdownAnalysisClient", () => ({
  createMarkdownAnalysisController: () => ({
    analyze: () => 1,
    destroy: () => undefined,
  }),
}));

vi.mock("@/lib/editorRuntimePolicy", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/editorRuntimePolicy")>();
  return {
    ...original,
    resolveEditorRuntimeDecision: () => ({
      mode: "lightweight-edit",
      reasons: ["serialized-size"],
      disabledCapabilities: [],
      capabilities: {
        editable: true,
        livePreview: false,
        syntaxHighlight: false,
        eagerHeavyNodes: false,
        wholeDocumentAnalysis: false,
        realtimeDecorations: false,
        collaboration: true,
        richNodeToolbars: false,
      },
      profile: {},
    }),
  };
});

import LargeMarkdownSafeEditor from "../LargeMarkdownSafeEditor";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function note(id: string, content: string): Note {
  return {
    id,
    userId: "user-1",
    notebookId: "book-1",
    workspaceId: null,
    title: id,
    content,
    contentText: content,
    contentFormat: "markdown",
    isPinned: 0,
    isFavorite: 0,
    isLocked: 0,
    isArchived: 0,
    isTrashed: 0,
    trashedAt: null,
    version: 1,
    sortOrder: 0,
    createdAt: "2026-07-24 00:00:00",
    updatedAt: "2026-07-24 00:00:00",
    tags: [],
  };
}

function button(host: HTMLElement, name: string): HTMLButtonElement {
  const match = Array.from(host.querySelectorAll("button"))
    .find((item) => item.textContent?.includes(name));
  if (!match) throw new Error(`找不到按钮：${name}`);
  return match;
}

function editorView(host: HTMLElement): EditorView {
  const editor = host.querySelector<HTMLElement>(".cm-editor");
  if (!editor) throw new Error("CodeMirror 尚未挂载");
  const view = EditorView.findFromDOM(editor);
  if (!view) throw new Error("无法读取 CodeMirror 实例");
  return view;
}

describe("LargeMarkdownSafeEditor 大文档预览", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [],
    });
    if (!globalThis.ResizeObserver) {
      vi.stubGlobal("ResizeObserver", class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      });
    }
    if (!globalThis.matchMedia) {
      vi.stubGlobal("matchMedia", () => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
      }));
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("默认显示源代码，并在进入预览时读取 CodeMirror 最新内容", async () => {
    await act(async () => {
      root.render(<LargeMarkdownSafeEditor note={note("note-a", "旧内容")} onUpdate={vi.fn()} />);
    });
    const view = editorView(host);
    expect(view.dom.closest("[data-large-markdown-source]")?.hasAttribute("hidden")).toBe(false);

    await act(async () => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "# 最新编辑内容" } });
      button(host, "预览").click();
    });

    expect(host.querySelector("[data-large-markdown-preview]")?.textContent).toContain("最新编辑内容");
    expect(view.dom.isConnected).toBe(true);
    expect(view.dom.closest("[data-large-markdown-source]")?.hasAttribute("hidden")).toBe(true);

    await act(async () => button(host, "源代码").click());
    expect(editorView(host)).toBe(view);
    expect(view.state.doc.toString()).toBe("# 最新编辑内容");
  });

  it("按全局任务索引回写 CodeMirror，且只读预览不可修改", async () => {
    const markdown = [
      "# 第一段",
      "",
      "- [ ] 第一项",
      "",
      "a".repeat(60_000),
      "",
      "# 第二段",
      "",
      "- [ ] 第二项",
      "",
      "b".repeat(60_000),
    ].join("\n");
    await act(async () => {
      root.render(<LargeMarkdownSafeEditor note={note("note-a", markdown)} onUpdate={vi.fn()} />);
    });
    await act(async () => button(host, "预览").click());
    const checkboxes = host.querySelectorAll<HTMLInputElement>("[data-large-markdown-preview] input[type='checkbox']");
    expect(checkboxes).toHaveLength(2);
    await act(async () => checkboxes[1].click());
    expect(editorView(host).state.doc.toString()).toBe(markdown.replace("- [ ] 第二项", "- [x] 第二项"));

    const readonlyMarkdown = "- [ ] 只读任务";
    await act(async () => {
      root.render(<LargeMarkdownSafeEditor note={note("note-readonly", readonlyMarkdown)} onUpdate={vi.fn()} editable={false} />);
    });
    const readonlyCheckbox = host.querySelectorAll<HTMLInputElement>("[data-large-markdown-preview] input[type='checkbox']")[0];
    await act(async () => readonlyCheckbox.click());
    expect(editorView(host).state.doc.toString()).toBe(readonlyMarkdown);
  });

  it("切换笔记时刷新仍在显示的预览快照", async () => {
    await act(async () => {
      root.render(<LargeMarkdownSafeEditor note={note("note-a", "第一篇内容")} onUpdate={vi.fn()} />);
    });
    await act(async () => button(host, "预览").click());
    expect(host.querySelector("[data-large-markdown-preview]")?.textContent).toContain("第一篇内容");

    await act(async () => {
      root.render(<LargeMarkdownSafeEditor note={note("note-b", "第二篇内容")} onUpdate={vi.fn()} />);
    });
    expect(host.querySelector("[data-large-markdown-preview]")?.textContent).toContain("第二篇内容");
    expect(host.querySelector("[data-large-markdown-preview]")?.textContent).not.toContain("第一篇内容");
  });

  it("预览模式点击大纲时滚动可见标题而不是隐藏的源码编辑器", async () => {
    let scrolledElement: Element | null = null;
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: function scrollIntoView() { scrolledElement = this; },
    });
    let scrollTo: ((pos: number) => void) | null = null;
    const markdown = "# 第一章\n\n[[note:12345678-1234-1234-1234-123456789abc|一篇内部笔记]]\n\n## 第二章";

    await act(async () => {
      root.render(
        <LargeMarkdownSafeEditor
          note={note("note-outline", markdown)}
          onUpdate={vi.fn()}
          onEditorReady={(callback) => { scrollTo = callback; }}
        />,
      );
    });
    await act(async () => button(host, "预览").click());
    await act(async () => scrollTo?.(markdown.indexOf("## 第二章")));

    expect(scrolledElement).not.toBeNull();
    expect((scrolledElement as Element | null)?.tagName).toBe("H2");
    expect((scrolledElement as Element | null)?.textContent).toBe("第二章");
  });
});
