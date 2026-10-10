import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor, generateHTML, generateJSON } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { getRichTextExtensions } from "../richTextExtensions";
import { getTiptapExtensions, tiptapJsonToMarkdown, markdownToTiptapJSON } from "../contentFormat";
import { repairTiptapJson } from "../tiptapSchemaRepair";
import { noteContentToExportHtml } from "../exportServiceCore";
import { copyBlock, cutBlock, deleteBlock, pasteBlock, convertBlock, addBlockBelow } from "@/components/blockMenuActions";

const editors: Editor[] = [];
const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const fixture = { type: "doc", content: [
  paragraph("Existing content"),
  { type: "callout", attrs: { type: "green", icon: "✅" }, content: [paragraph("First callout paragraph"), paragraph("Second callout paragraph")] },
  { type: "column_container", content: [
    { type: "column", attrs: { colWidth: 175, resized: true }, content: [paragraph("Left column")] },
    { type: "column", content: [paragraph("Right column"), { type: "image", attrs: { src: "/api/attachments/test-image", alt: "Retained image" } }] },
  ] },
  { type: "details", attrs: { open: true }, content: [
    { type: "detailsSummary", content: [{ type: "text", text: "Summary" }] },
    { type: "detailsContent", content: [paragraph("Hidden body"), paragraph("Another body paragraph")] },
  ] },
  { type: "paragraph", content: [{ type: "emoji", attrs: { name: "smile" } }, { type: "text", text: "Emoji text" }] },
  { type: "codeBlock", attrs: { language: "javascript", title: "Example" }, content: [{ type: "text", text: "const value = 1;" }] },
] };

function createEditor(content: any = { type: "doc", content: [paragraph("Protected content")] }) {
  const editor = new Editor({ extensions: [StarterKit, ...getRichTextExtensions()], content });
  editors.push(editor);
  return editor;
}
afterEach(() => { editors.splice(0).forEach((editor) => editor.destroy()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function assertPreserved(json: any) {
  const result = JSON.stringify(json);
  for (const text of ["Existing content", "First callout paragraph", "Second callout paragraph", "Left column", "Right column", "Hidden body", "Another body paragraph", "Summary", "Emoji text", "Retained image", "const value = 1;"]) expect(result).toContain(text);
  for (const type of ["callout", "column_container", "details", "emoji", "codeBlock"]) expect(result).toContain(`"type":"${type}"`);
  expect(result).toContain('"icon":"✅"');
  expect(result).toContain('"resized":true');
  expect(result).toContain('"colWidth":175');
  expect(result).toContain('"title":"Example"');
}

describe("rich-text content preservation", () => {
  it("keeps all nodes and attributes through schema repair repeatedly", () => {
    let content: any = fixture;
    for (let round = 0; round < 3; round++) { content = repairTiptapJson(content); assertPreserved(content); }
  });
  it("preserves special containers through Markdown switching repeatedly", () => {
    let content: any = fixture;
    for (let round = 0; round < 3; round++) {
      const markdown = tiptapJsonToMarkdown(content);
      expect(markdown).not.toBe("");
      content = markdownToTiptapJSON(markdown);
      assertPreserved(content);
    }
  });
  it("keeps static HTML parse and render compatible", () => {
    const html = generateHTML(fixture, getTiptapExtensions());
    assertPreserved(generateJSON(html, getTiptapExtensions()));
  });
  it("exports complete rich content through the actual export schema", () => {
    assertPreserved(generateJSON(noteContentToExportHtml(JSON.stringify(fixture), "", "tiptap-json"), getTiptapExtensions()));
  });
});

describe("structural block conversion", () => {
  it.each(["callout", "details", "columns", "blockquote"] as const)("retains multiple paragraphs and media when converting to %s", (type) => {
    const editor = new Editor({ extensions: getTiptapExtensions(), content: { type: "doc", content: [
      { type: "callout", content: [paragraph("First"), paragraph("Second"), { type: "image", attrs: { src: "/preserved.png" } }] },
    ] } });
    editors.push(editor);
    if (type !== "callout") expect(convertBlock(editor, { type }, 1)).toBe(true);
    editor.state.doc.check();
    const converted = editor.getJSON();
    expect(JSON.stringify(converted)).toContain("/preserved.png");
    expect(editor.state.doc.textContent).toContain("FirstSecond");
    expect(convertBlock(editor, { type: "paragraph" }, 1)).toBe(true);
    editor.state.doc.check();
    expect(editor.state.doc.textContent).toBe("FirstSecond");
    expect(JSON.stringify(editor.getJSON())).toContain("/preserved.png");
  });
  it("refuses conversion to code when it would lose structured content", () => {
    const editor = createEditor({ type: "doc", content: [{ type: "callout", content: [paragraph("First"), paragraph("Second")] }] });
    const before = editor.getJSON();
    expect(convertBlock(editor, { type: "codeBlock" }, 1)).toBe(false);
    expect(editor.getJSON()).toEqual(before);
  });
  it("adds a valid folding block without replacing the first image", () => {
    const editor = new Editor({ extensions: getTiptapExtensions(), content: { type: "doc", content: [{ type: "image", attrs: { src: "/preserved.png" } }] } });
    editors.push(editor);
    expect(addBlockBelow(editor, "details", 0)).not.toBeNull();
    editor.state.doc.check();
    expect(editor.state.doc.firstChild?.type.name).toBe("image");
    expect(editor.state.doc.child(1).type.name).toBe("details");
    expect(editor.state.doc.child(1).child(1).firstChild?.type.name).toBe("paragraph");
  });
});

describe("block clipboard and permission safety", () => {
  it("keeps the original block when clipboard writing fails", async () => {
    const editor = createEditor();
    Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => false) });
    const snapshot = editor.getJSON();
    expect(await cutBlock(editor, 1)).toBe(false);
    expect(editor.getJSON()).toEqual(snapshot);
  });
  it("does not cut rich content after only a plain-text copy", async () => {
    const editor = createEditor();
    Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => false) });
    vi.stubGlobal("navigator", { platform: "Linux", userAgent: "Test Linux", clipboard: { writeText: vi.fn(async () => {}) } });
    expect(await copyBlock(editor, 1)).toBe(true);
    expect(await cutBlock(editor, 1)).toBe(false);
    expect(editor.state.doc.textContent).toBe("Protected content");
  });
  it("does not delete changes made during a clipboard copy", async () => {
    const editor = createEditor();
    Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => {
      editor.commands.insertContentAt(editor.state.doc.content.size, paragraph("Concurrent edit"));
      return true;
    }) });
    expect(await cutBlock(editor, 1)).toBe(false);
    expect(editor.state.doc.textContent).toContain("Protected content");
    expect(editor.state.doc.textContent).toContain("Concurrent edit");
  });
  it("blocks all mutations after the editor becomes read-only", async () => {
    const editor = createEditor();
    editor.setEditable(false);
    const snapshot = editor.getJSON();
    deleteBlock(editor, 1);
    expect(convertBlock(editor, { type: "details" }, 1)).toBe(false);
    expect(await cutBlock(editor, 1)).toBe(false);
    expect(await pasteBlock(editor, 1)).toBe(false);
    expect(editor.getJSON()).toEqual(snapshot);
  });
  it("pastes readText as literal text rather than interpreting HTML", async () => {
    const editor = createEditor();
    vi.stubGlobal("navigator", { platform: "Linux", userAgent: "Test Linux", clipboard: { readText: vi.fn(async () => '<img src="x" onerror="alert(1)">') } });
    expect(await pasteBlock(editor, 1)).toBe(true);
    expect(editor.state.doc.textContent).toContain('<img src="x" onerror="alert(1)">');
    expect(JSON.stringify(editor.getJSON())).not.toContain('"type":"image"');
  });
  it("preserves nested HTML and existing media while rejecting clipboard scripts", async () => {
    const editor = new Editor({ extensions: getTiptapExtensions(), content: { type: "doc", content: [{ type: "image", attrs: { src: "/api/attachments/existing" } }] } });
    editors.push(editor);
    const html = generateHTML(fixture, getTiptapExtensions()) + '<script>alert(1)</script><img src="javascript:alert(1)" onerror="alert(1)">';
    vi.stubGlobal("navigator", { platform: "Linux", userAgent: "Test Linux", clipboard: { read: vi.fn(async () => [{ types: ["text/html"], getType: async () => ({ text: async () => html }) }]) } });
    expect(await pasteBlock(editor, 0)).toBe(true);
    editor.state.doc.check();
    assertPreserved(editor.getJSON());
    expect(JSON.stringify(editor.getJSON())).toContain("/api/attachments/existing");
    expect(editor.getHTML()).not.toMatch(/<script|onerror|javascript:/);
  });
});
