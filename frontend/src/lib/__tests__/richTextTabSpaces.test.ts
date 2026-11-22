// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { Editor, type JSONContent } from "@tiptap/core";
import { markdownToTiptapJSON, tiptapJsonToMarkdown } from "@/lib/contentFormat";
import { tiptapExtensions } from "@/lib/importService";
import { noteContentToExportHtml } from "@/lib/exportServiceCore";
import { insertTabSpaces, removeTabSpaces, TAB_SPACES } from "@/lib/richTextTabSpaces";
import { repairTiptapJson } from "@/lib/tiptapSchemaRepair";

const NBSP = "\u00a0";
const editors: Editor[] = [];
const paragraph = (text: string) => ({ type: "paragraph", content: text ? [{ type: "text", text }] : [] });
const doc = (...content: unknown[]) => ({ type: "doc", content });

afterEach(() => {
  while (editors.length > 0) editors.pop()?.destroy();
});

function createEditor(content: unknown, cursor: number, selectionEnd = cursor): Editor {
  const editor = new Editor({ element: document.createElement("div"), extensions: tiptapExtensions, content: content as JSONContent });
  editors.push(editor);
  editor.commands.setTextSelection({ from: cursor, to: selectionEnd });
  return editor;
}

const run = (editor: Editor, command: typeof insertTabSpaces) => command(editor.state, editor.view.dispatch);
const firstText = (json: JSONContent): string => json.content?.[0]?.content?.[0]?.text ?? "";

describe("Tab inserts four spaces in rich-text body (Issue #915)", () => {
  it("inserts four non-breaking spaces at the cursor in paragraphs and headings", () => {
    const editor = createEditor(doc(paragraph("Hello world")), 7);
    expect(run(editor, insertTabSpaces)).toBe(true);
    expect(editor.state.doc.textContent).toBe(`Hello ${TAB_SPACES}world`);
    expect(TAB_SPACES).toBe(NBSP.repeat(4));
    expect(editor.state.selection.from).toBe(11);

    const heading = createEditor(doc({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Title" }] }), 1);
    expect(run(heading, insertTabSpaces)).toBe(true);
    expect(heading.state.doc.textContent).toBe(`${TAB_SPACES}Title`);
  });

  it("leaves selections and code blocks to the existing indentation rules", () => {
    const selected = createEditor(doc(paragraph("Hello world")), 1, 6);
    expect(run(selected, insertTabSpaces)).toBe(false);
    expect(selected.state.doc.textContent).toBe("Hello world");

    const code = createEditor(doc({ type: "codeBlock", content: [{ type: "text", text: "const a = 1;" }] }), 1);
    expect(run(code, insertTabSpaces)).toBe(false);
    expect(run(code, removeTabSpaces)).toBe(false);
    expect(code.state.doc.textContent).toBe("const a = 1;");
  });

  it("Shift+Tab removes the spaces before the cursor, then leading spaces, otherwise reports nothing to do", () => {
    const afterTab = createEditor(doc(paragraph(`Hello ${NBSP.repeat(6)}world`)), 13);
    expect(run(afterTab, removeTabSpaces)).toBe(true);
    expect(afterTab.state.doc.textContent).toBe(`Hello ${NBSP.repeat(2)}world`);

    const leading = createEditor(doc(paragraph(`${TAB_SPACES}Indented paragraph`)), 15);
    expect(run(leading, removeTabSpaces)).toBe(true);
    expect(leading.state.doc.textContent).toBe("Indented paragraph");

    const plain = createEditor(doc(paragraph("word next")), 6);
    expect(run(plain, removeTabSpaces)).toBe(false);
    expect(plain.state.doc.textContent).toBe("word next");
  });

  it("counts inline images as one position when looking back from the cursor", () => {
    const content = doc({ type: "paragraph", content: [
      { type: "text", text: TAB_SPACES },
      { type: "image", attrs: { src: "/api/attachments/inline" } },
      { type: "text", text: "after" },
    ] });
    const editor = createEditor(content, 6);
    expect(run(editor, removeTabSpaces)).toBe(true);
    expect(editor.state.doc.firstChild?.firstChild?.type.name).toBe("image");
    expect(editor.state.doc.textContent).toBe("after");
  });

  it("keeps the indentation through schema repair, Markdown switching and export", () => {
    const content = doc(paragraph(`${TAB_SPACES}First paragraph`), paragraph(`${TAB_SPACES}Second${TAB_SPACES}paragraph`));
    const repaired = repairTiptapJson(repairTiptapJson(content)) as JSONContent;
    expect(firstText(repaired)).toBe(`${TAB_SPACES}First paragraph`);
    expect(repaired.content?.[1]?.content?.[0]?.text).toBe(`${TAB_SPACES}Second${TAB_SPACES}paragraph`);

    const markdown = tiptapJsonToMarkdown(content);
    expect(markdown.startsWith(TAB_SPACES)).toBe(true);
    const back = markdownToTiptapJSON(markdown) as JSONContent;
    expect(back.content?.map((node) => node.type)).toEqual(["paragraph", "paragraph"]);
    expect(firstText(back)).toBe(`${TAB_SPACES}First paragraph`);
    expect(back.content?.[1]?.content?.[0]?.text).toBe(`${TAB_SPACES}Second${TAB_SPACES}paragraph`);

    const html = noteContentToExportHtml(JSON.stringify(content), "", "tiptap-json");
    expect(html).toContain("&nbsp;&nbsp;&nbsp;&nbsp;First paragraph");
  });

  it("documents why plain spaces are not used: schema repair collapses them", () => {
    const repaired = repairTiptapJson(doc(paragraph("    Lead and    middle"))) as JSONContent;
    expect(firstText(repaired)).toBe("Lead and middle");
  });
});
