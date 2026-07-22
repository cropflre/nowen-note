import { Editor } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { afterEach, describe, expect, it } from "vitest";

import {
  createSearchReplaceExtension,
  searchReplacePluginKey,
} from "@/components/SearchReplacePanel";
import { resolveEditorRuntimeDecision } from "@/lib/editorRuntimePolicy";
import {
  clearActiveEditorRuntimeDecision,
  setActiveEditorRuntimeDecision,
} from "@/lib/editorRuntimeStore";

function lightweightDecision() {
  return resolveEditorRuntimeDecision({
    content: `{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"${"x".repeat(400_000)}"}]}]}`,
    contentFormat: "tiptap-json",
  });
}

function createEditor(text: string) {
  return new Editor({
    extensions: [Document, Paragraph, Text, createSearchReplaceExtension()],
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    },
  });
}

function runQuery(editor: Editor, query: string) {
  editor.view.dispatch(editor.state.tr.setMeta(searchReplacePluginKey, {
    query,
    caseSensitive: false,
    wholeWord: false,
    useRegex: false,
  }));
  return searchReplacePluginKey.getState(editor.state) as any;
}

afterEach(() => {
  clearActiveEditorRuntimeDecision();
});

describe("runtime-aware rich-text search", () => {
  it("bounds matches and paints only the active result in lightweight mode", () => {
    setActiveEditorRuntimeDecision("search-lightweight", lightweightDecision());
    const editor = createEditor(Array.from({ length: 800 }, () => "needle").join(" "));
    try {
      const state = runQuery(editor, "needle");
      expect(state.matches).toHaveLength(500);
      expect(state.truncated).toBe(true);
      expect(state.deco.find()).toHaveLength(1);
    } finally {
      editor.destroy();
    }
  });

  it("maps existing results instead of rescanning the whole document on each edit", () => {
    setActiveEditorRuntimeDecision("search-map", lightweightDecision());
    const editor = createEditor("needle alpha needle beta");
    try {
      const initial = runQuery(editor, "needle");
      expect(initial.matches).toHaveLength(2);
      expect(initial.stale).toBe(false);

      editor.view.dispatch(editor.state.tr.insertText("prefix ", 1));
      const mapped = searchReplacePluginKey.getState(editor.state) as any;
      expect(mapped.matches).toHaveLength(2);
      expect(mapped.matches[0].from).toBeGreaterThan(initial.matches[0].from);
      expect(mapped.stale).toBe(true);
      expect(mapped.deco.find()).toHaveLength(1);
    } finally {
      editor.destroy();
    }
  });

  it("keeps complete matching and decorations in normal mode", () => {
    const editor = createEditor(Array.from({ length: 620 }, () => "needle").join(" "));
    try {
      const state = runQuery(editor, "needle");
      expect(state.matches).toHaveLength(620);
      expect(state.truncated).toBe(false);
      expect(state.deco.find()).toHaveLength(620);
    } finally {
      editor.destroy();
    }
  });
});
