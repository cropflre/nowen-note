import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/react";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { Heading } from "@tiptap/extension-heading";
import { CodeBlock } from "@tiptap/extension-code-block";
import { ColumnsExtension } from "@/components/extensions/ColumnsExtension";
import { MathBlock } from "@/components/MathExtensions";
import { convertBlock } from "@/components/blockMenuActions";

async function createEditor(content: any, extra: any[] = []) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: [Document, Text, Paragraph, Heading.configure({ levels: [1, 2, 3] }), CodeBlock, ColumnsExtension, MathBlock, ...extra],
    content,
  });
  return { editor, el };
}

function firstTextblockPos(editor: Editor): number {
  let pos = -1;
  editor.state.doc.descendants((n, p) => {
    if (pos < 0 && n.isTextblock) { pos = p + 1; return false; }
    return true;
  });
  return pos;
}

describe("empty text conversion (repro)", () => {
  it("empty paragraph -> codeBlock (non-column)", async () => {
    const { editor, el } = await createEditor({ type: "doc", content: [{ type: "paragraph" }] });
    const pos = firstTextblockPos(editor);
    const ok = convertBlock(editor, { type: "codeBlock" }, pos);
    expect(ok).toBe(true);
    expect(JSON.stringify(editor.getJSON()).includes("codeBlock")).toBe(true);
    editor.destroy(); el.remove();
  });

  it("empty paragraph -> heading1 (non-column)", async () => {
    const { editor, el } = await createEditor({ type: "doc", content: [{ type: "paragraph" }] });
    const pos = firstTextblockPos(editor);
    const ok = convertBlock(editor, { type: "heading", level: 1 }, pos);
    expect(ok).toBe(true);
    expect(JSON.stringify(editor.getJSON()).includes("\"heading\"")).toBe(true);
    editor.destroy(); el.remove();
  });

  it("empty paragraph -> codeBlock (in column)", async () => {
    const { editor, el } = await createEditor({
      type: "doc", content: [{
        type: "column_container", content: [
          { type: "column", attrs: { colWidth: null }, content: [{ type: "paragraph" }] },
          { type: "column", attrs: { colWidth: null }, content: [{ type: "paragraph" }] },
        ],
      }],
    });
    let pos = -1, idx = 0;
    editor.state.doc.descendants((n, p) => { if (n.type.name === "column") { idx++; if (idx === 1) pos = p; } });
    const ok = convertBlock(editor, { type: "codeBlock" }, pos + 1);
    expect(ok).toBe(true);
    const json = JSON.stringify(editor.getJSON());
    expect(json).toContain("codeBlock");
    expect((editor.getJSON() as any).content[0].content.length).toBe(2); // 不丢栏
    editor.destroy(); el.remove();
  });

  it("empty NON-text block (mathBlock) in column -> codeBlock (line 528 path)", async () => {
    const { editor, el } = await createEditor({
      type: "doc", content: [{
        type: "column_container", content: [
          { type: "column", attrs: { colWidth: null }, content: [{ type: "mathBlock", attrs: { latex: "" } }] },
          { type: "column", attrs: { colWidth: null }, content: [{ type: "paragraph" }] },
        ],
      }],
    });
    let pos = -1, idx = 0;
    editor.state.doc.descendants((n, p) => { if (n.type.name === "column") { idx++; if (idx === 1) pos = p; } });
    const ok = convertBlock(editor, { type: "codeBlock" }, pos + 1);
    expect(ok).toBe(true);
    const json = JSON.stringify(editor.getJSON());
    expect(json).toContain("codeBlock");
    expect((editor.getJSON() as any).content[0].content.length).toBe(2); // 不丢栏
    editor.destroy(); el.remove();
  });
});
