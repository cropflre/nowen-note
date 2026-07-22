// @vitest-environment jsdom

import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCodeBlockHighlightPlugin,
  type LowlightLike,
} from "@/lib/codeBlockHighlightPlugin";
import { resolveEditorRuntimeDecision } from "@/lib/editorRuntimePolicy";
import {
  clearActiveEditorRuntimeDecision,
  setActiveEditorRuntimeDecision,
} from "@/lib/editorRuntimeStore";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    text: { group: "inline" },
    codeBlock: {
      attrs: { language: { default: "javascript" } },
      content: "text*",
      group: "block",
      code: true,
      toDOM: () => ["pre", ["code", 0]],
    },
  },
});

function viewportDecision() {
  return resolveEditorRuntimeDecision({
    content: `{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"${"x".repeat(120_000)}"}]}]}`,
    contentFormat: "tiptap-json",
  });
}

function waitForViewportRefresh(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 20));
}

describe("viewport-scoped code highlighting", () => {
  let view: EditorView | null = null;
  let host: HTMLDivElement | null = null;

  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => (
      window.setTimeout(() => callback(performance.now()), 0)
    ));
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => window.clearTimeout(handle));
    clearActiveEditorRuntimeDecision();
    setActiveEditorRuntimeDecision("viewport-note", viewportDecision());
  });

  afterEach(() => {
    view?.destroy();
    host?.remove();
    view = null;
    host = null;
    clearActiveEditorRuntimeDecision();
    vi.unstubAllGlobals();
  });

  it("highlights only the code block around the active viewport and updates after navigation", async () => {
    const calls: string[] = [];
    const lowlight: LowlightLike = {
      listLanguages: () => ["javascript"],
      registered: () => true,
      highlight: (_language, code) => {
        calls.push(code);
        return {
          children: [{
            value: code,
            properties: { className: ["hljs-keyword"] },
          }],
        };
      },
      highlightAuto: () => ({ children: [] }),
    };

    const plugin = createCodeBlockHighlightPlugin({
      name: "codeBlock",
      lowlight,
      viewportCharacterMargin: 1,
    });
    const doc = schema.node("doc", null, [
      schema.node("codeBlock", { language: "javascript" }, schema.text("first-visible-block")),
      schema.node("codeBlock", { language: "javascript" }, schema.text("middle-block")),
      schema.node("codeBlock", { language: "javascript" }, schema.text("last-visible-block")),
    ]);
    let state = EditorState.create({ doc, plugins: [plugin] });

    host = document.createElement("div");
    host.style.overflowY = "auto";
    host.style.height = "300px";
    document.body.appendChild(host);
    view = new EditorView(host, {
      state,
      dispatchTransaction(transaction) {
        state = state.apply(transaction);
        view?.updateState(state);
      },
    });

    await waitForViewportRefresh();
    expect(calls).toEqual(["first-visible-block"]);

    const thirdNodeStart = state.doc.child(0).nodeSize + state.doc.child(1).nodeSize;
    view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, thirdNodeStart + 1)));
    host.dispatchEvent(new Event("scroll"));
    await waitForViewportRefresh();

    expect(calls).toEqual(["first-visible-block", "last-visible-block"]);
    expect(calls).not.toContain("middle-block");
  });
});
