// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import {
  collectMarkdownLivePreviewBlocks,
  markdownLivePreviewEditAnchor,
  markdownLivePreviewExtension,
  markdownLivePreviewNoteId,
} from "@/lib/markdownLivePreview";
import { resetAttachmentAccessStateForTests } from "@/lib/noteAttachmentAccessBridge";

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
  localStorage.clear();
  resetAttachmentAccessStateForTests();
  vi.unstubAllGlobals();
});

async function flushPreview() {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

describe("markdownLivePreviewExtension", () => {
  it("authorizes Live-mode images for their own note and updates the scope even for identical text", async () => {
    resetAttachmentAccessStateForTests();
    localStorage.setItem("nowen-token", "jwt-token");
    const id = "123e4567-e89b-42d3-a456-426614174216";
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.href);
      return new Response(JSON.stringify({ urls: { [id]: `/api/attachments/${id}?exp=2000000000&sig=${url.searchParams.get("noteId")}&scope=v2.scope` } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);
    const parent = document.createElement("div"); document.body.appendChild(parent);
    const scope = new Compartment();
    const doc = `![image](/api/attachments/${id})\n\nEditing paragraph`;
    const view = new EditorView({ parent, state: EditorState.create({ doc, selection: { anchor: doc.length },
      extensions: [markdown(), scope.of(markdownLivePreviewNoteId.of("note-a")), markdownLivePreviewExtension],
    }) });
    try {
      await vi.waitFor(() => {
        // CodeMirror widgets mount their React subtree asynchronously.
        expect(parent.querySelector("img")?.getAttribute("src")).toContain("sig=note-a");
      }, { timeout: 2500 });
      view.dispatch({ effects: scope.reconfigure(markdownLivePreviewNoteId.of("note-b")) });
      resetAttachmentAccessStateForTests();
      await vi.waitFor(() => {
        expect(fetch.mock.calls.some(([url]) => String(url).includes("noteId=note-b"))).toBe(true);
        expect(parent.querySelector("img")?.getAttribute("src")).toContain("sig=note-b");
      }, { timeout: 2500 });
      expect(view.state.doc.toString()).toBe(doc);
    } finally { view.destroy(); }
  });

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

  it("keeps every multi-cursor source block visible in Live mode", () => {
    const doc = "First paragraph\n\nSecond paragraph\n\nThird paragraph";
    const state = EditorState.create({
      doc,
      selection: EditorSelection.create([
        EditorSelection.cursor(doc.indexOf("First") + 1),
        EditorSelection.cursor(doc.indexOf("Third") + 1),
      ]),
      extensions: [EditorState.allowMultipleSelections.of(true), markdown()],
    });

    const blocks = collectMarkdownLivePreviewBlocks(state);
    expect(blocks.some((block) => block.markdown.includes("First paragraph"))).toBe(false);
    expect(blocks.some((block) => block.markdown.includes("Third paragraph"))).toBe(false);
    expect(blocks.some((block) => block.markdown.includes("Second paragraph"))).toBe(true);
  });

  it("places a previewed fenced-code click inside the code body", () => {
    const markdown = "```bash\necho hello\n```";
    expect(markdownLivePreviewEditAnchor(markdown, 40)).toBe(40 + "```bash\n".length);
    expect(markdownLivePreviewEditAnchor("Plain paragraph", 40)).toBe(40);
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
      selection: { anchor: 1 },
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
