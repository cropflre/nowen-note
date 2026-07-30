// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";

import { markdownLivePreviewExtension } from "@/lib/markdownLivePreview";

const CALLOUTS = [
  { type: "NOTE", title: "Note", body: "Note正文", className: "border-blue-400/70" },
  { type: "TIP", title: "Tip", body: "Tip正文", className: "border-emerald-400/70" },
  { type: "IMPORTANT", title: "Important", body: "Important正文", className: "border-violet-400/70" },
  { type: "WARNING", title: "Warning", body: "Warning正文", className: "border-amber-400/80" },
  { type: "CAUTION", title: "Caution", body: "Caution正文", className: "border-red-400/80" },
] as const;

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
  await new Promise((resolve) => setTimeout(resolve, 40));
}

describe("Markdown live preview SiYuan Callouts", () => {
  it("renders NOTE, TIP, IMPORTANT, WARNING and CAUTION while preserving Markdown source", async () => {
    for (const expected of CALLOUTS) {
      const parent = document.createElement("div");
      document.body.appendChild(parent);
      const source = [
        `> [!${expected.type}] ${expected.title}`,
        `> ${expected.body}`,
      ].join("\n");
      const doc = `${source}\n\n当前编辑段落`;

      const view = new EditorView({
        parent,
        state: EditorState.create({
          doc,
          selection: { anchor: doc.lastIndexOf("当前编辑段落") },
          extensions: [markdown(), markdownLivePreviewExtension],
        }),
      });

      await flushPreview();

      const blockquote = parent.querySelector(".cm-live-preview-render blockquote");
      expect(blockquote, `${expected.type} should render`).not.toBeNull();
      expect(blockquote?.className).toContain(expected.className);
      expect(blockquote?.textContent).toContain(expected.title);
      expect(blockquote?.textContent).toContain(expected.body);
      expect(blockquote?.textContent).not.toContain(`[!${expected.type}]`);
      expect(view.state.doc.toString()).toContain(source);

      view.destroy();
      parent.remove();
    }
  });
});
