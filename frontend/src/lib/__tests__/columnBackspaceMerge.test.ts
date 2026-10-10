import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/react";
import { ColumnsExtension, backspaceFromAfterColumn } from "@/components/extensions/ColumnsExtension";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { Document } from "@tiptap/extension-document";
import { TextSelection } from "@tiptap/pm/state";
import type { Transaction } from "@tiptap/pm/state";

async function createEditor(content?: any) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: [Document, Text, Paragraph, ColumnsExtension],
    content,
  });
  return { editor, el };
}

function countColumns(editor: Editor): number {
  let n = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "column") n++;
    return true;
  });
  return n;
}

function putCursorAtStartOfText(editor: Editor, text: string) {
  let pos = -1;
  editor.state.doc.descendants((node, p) => {
    if (pos < 0 && node.isTextblock && node.textContent === text) {
      pos = p + 1;
      return false;
    }
    return true;
  });
  const sel = TextSelection.create(editor.state.doc, pos);
  editor.view.dispatch(editor.state.tr.setSelection(sel));
}

/**
 * 回归：分栏下方段落开头按 Backspace，ProseMirror 默认会把段落「包成新的一栏」
 * 追加进容器（2 栏 → 3 栏）。backspaceFromAfterColumn 改为并入最后一栏末尾。
 */
describe("backspace into columns (regression)", () => {
  it("empty paragraph below columns: cursor moves into last column, NO new column", async () => {
    const { editor, el } = await createEditor({
      type: "doc",
      content: [
        {
          type: "column_container",
          content: [
            { type: "column", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] },
            { type: "column", content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }] },
          ],
        },
        { type: "paragraph" },
      ],
    });
    putCursorAtStartOfText(editor, "");
    const dispatched = backspaceFromAfterColumn(editor.state, (tr: Transaction) => editor.view.dispatch(tr));
    expect(dispatched).toBe(true);
    expect(countColumns(editor)).toBe(2);
    editor.destroy();
    el.remove();
  });

  it("non-empty paragraph below columns: content merges into last column, NO new column", async () => {
    const { editor, el } = await createEditor({
      type: "doc",
      content: [
        {
          type: "column_container",
          content: [
            { type: "column", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] },
            { type: "column", content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }] },
          ],
        },
        { type: "paragraph", content: [{ type: "text", text: "c" }] },
      ],
    });
    putCursorAtStartOfText(editor, "c");
    const dispatched = backspaceFromAfterColumn(editor.state, (tr: Transaction) => editor.view.dispatch(tr));
    expect(dispatched).toBe(true);
    expect(countColumns(editor)).toBe(2);
    // "c" 应并入最后一栏，且与 "b" 合成同一段落（bc）
    const lastCol = editor.state.doc.content.firstChild!.lastChild!;
    const lastPara = lastCol.lastChild!;
    expect(lastPara.type.name).toBe("paragraph");
    expect(lastPara.textContent).toBe("bc");
    editor.destroy();
    el.remove();
  });
});
