// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import TextAlign from "@tiptap/extension-text-align";
import { AlignmentShortcuts } from "@/components/extensions/AlignmentShortcuts";
import { tiptapExtensions } from "@/lib/importService";

const editors: Editor[] = [];
afterEach(() => { while (editors.length > 0) editors.pop()?.destroy(); });

// Same keymap order as the editor: StarterKit (inline code Mod-E) and TextAlign (Mod-Shift-E) are registered too.
function createEditor(): Editor {
  const extensions = [...tiptapExtensions.filter((extension) => extension.name !== "textAlign"), TextAlign.configure({ types: ["heading", "paragraph"] }), AlignmentShortcuts];
  const editor = new Editor({ element: document.createElement("div"), extensions, content: { type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "Word style shortcuts" }] },
  ] } });
  editors.push(editor);
  editor.commands.setTextSelection({ from: 1, to: 5 });
  return editor;
}

function press(editor: Editor, key: string, init: KeyboardEventInit = {}): boolean {
  // Real browsers always set keyCode; ProseMirror's keymap relies on it for shifted letters.
  const event = new KeyboardEvent("keydown", { key, keyCode: key.toUpperCase().charCodeAt(0), ctrlKey: true, bubbles: true, cancelable: true, ...init });
  let handled = false;
  editor.view.someProp("handleKeyDown", (handler) => { handled = handler(editor.view, event) || handled; return handled; });
  return handled;
}

describe("Word-style alignment shortcuts in the rich-text editor (Issue #915)", () => {
  it("centres with Ctrl+E and aligns left with Ctrl+L instead of toggling inline code", () => {
    const editor = createEditor();
    expect(press(editor, "e")).toBe(true);
    expect(editor.state.doc.firstChild?.attrs.textAlign).toBe("center");
    expect(editor.isActive("code")).toBe(false);
    expect(press(editor, "l")).toBe(true);
    expect(editor.state.doc.firstChild?.attrs.textAlign).toBe("left");
  });

  it("moves inline code to Ctrl+Shift+E", () => {
    const editor = createEditor();
    expect(press(editor, "E", { shiftKey: true })).toBe(true);
    expect(editor.isActive("code")).toBe(true);
    expect(editor.state.doc.firstChild?.attrs.textAlign).not.toBe("center");
  });
});
