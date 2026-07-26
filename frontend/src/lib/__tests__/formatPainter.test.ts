import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Highlight from "@tiptap/extension-highlight";
import TextAlign from "@tiptap/extension-text-align";
import { Color, FontSize, TextStyle } from "@tiptap/extension-text-style";
import { afterEach, describe, expect, it } from "vitest";
import { LineHeightExtension } from "@/components/LineHeightExtension";
import {
  applyCapturedTextFormat,
  captureTextFormat,
  normalizeSafeFormatColor,
  type CapturedTextFormat,
} from "@/lib/formatPainter";

const editors: Editor[] = [];

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
});

function createEditor(content: object): Editor {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      StarterKit,
      Highlight.configure({ multicolor: true }),
      TextStyle,
      Color,
      FontSize,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      LineHeightExtension,
    ],
    content,
  });
  editors.push(editor);
  return editor;
}

function findTextRange(editor: Editor, text: string): { from: number; to: number } {
  let result: { from: number; to: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || result) return;
    const index = node.text?.indexOf(text) ?? -1;
    if (index >= 0) result = { from: pos + index, to: pos + index + text.length };
  });
  if (!result) throw new Error(`Text not found: ${text}`);
  return result;
}

function textMarks(editor: Editor, text: string): Record<string, Record<string, unknown>> {
  let result: Record<string, Record<string, unknown>> | null = null;
  editor.state.doc.descendants((node) => {
    if (!node.isText || result || !node.text?.includes(text)) return;
    result = Object.fromEntries(node.marks.map((mark) => [mark.type.name, { ...mark.attrs }]));
  });
  if (!result) throw new Error(`Text not found: ${text}`);
  return result;
}

function blockForText(editor: Editor, text: string) {
  let result: { type: string; attrs: Record<string, unknown> } | null = null;
  editor.state.doc.descendants((node) => {
    if (result || !node.isTextblock || !node.textContent.includes(text)) return;
    result = { type: node.type.name, attrs: { ...node.attrs } };
  });
  if (!result) throw new Error(`Block not found: ${text}`);
  return result;
}

describe("safe format painter", () => {
  it("captures and applies only whitelisted inline and single-block styles", () => {
    const editor = createEditor({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2, textAlign: "center", lineHeight: "1.6" },
          content: [
            {
              type: "text",
              text: "Source",
              marks: [
                { type: "bold" },
                { type: "italic" },
                { type: "underline" },
                { type: "strike" },
                { type: "textStyle", attrs: { fontSize: "20px", color: "#ef4444" } },
                { type: "highlight", attrs: { color: "#fef9c3" } },
                { type: "link", attrs: { href: "https://source.example", target: "_blank", rel: "noopener noreferrer nofollow" } },
              ],
            },
          ],
        },
        {
          type: "paragraph",
          attrs: { textAlign: "right", lineHeight: "1.8" },
          content: [
            {
              type: "text",
              text: "Target",
              marks: [
                { type: "textStyle", attrs: { fontSize: "12px", color: "#3b82f6" } },
                { type: "link", attrs: { href: "https://target.example", target: "_blank", rel: "noopener noreferrer nofollow" } },
              ],
            },
          ],
        },
      ],
    });

    editor.commands.setTextSelection(findTextRange(editor, "Source"));
    const captured = captureTextFormat(editor);
    expect(captured.ok).toBe(true);
    if (!captured.ok || !captured.format) throw new Error("format capture failed");

    expect(captured.format).toMatchObject({
      marks: {
        bold: true,
        italic: true,
        underline: true,
        strike: true,
        fontSize: "20px",
        color: "#ef4444",
        highlight: "#fef9c3",
      },
      block: {
        nodeType: "heading",
        headingLevel: 2,
        textAlign: "center",
        lineHeight: "1.6",
      },
    });

    editor.commands.setTextSelection(findTextRange(editor, "Target"));
    expect(applyCapturedTextFormat(editor, captured.format)).toMatchObject({ ok: true });

    const marks = textMarks(editor, "Target");
    expect(marks.bold).toBeDefined();
    expect(marks.italic).toBeDefined();
    expect(marks.underline).toBeDefined();
    expect(marks.strike).toBeDefined();
    expect(marks.highlight).toMatchObject({ color: "#fef9c3" });
    expect(marks.textStyle).toMatchObject({
      fontSize: "20px",
      color: "#ef4444",
    });
    expect(marks.link).toMatchObject({ href: "https://target.example" });
    expect(editor.getText()).toContain("Source");
    expect(editor.getText()).toContain("Target");

    expect(blockForText(editor, "Target")).toMatchObject({
      type: "heading",
      attrs: { level: 2, textAlign: "center", lineHeight: "1.6" },
    });
  });

  it("uses one history transaction so a single undo restores the target", () => {
    const editor = createEditor({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Source", marks: [{ type: "bold" }] }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Target", marks: [{ type: "italic" }] }],
        },
      ],
    });

    editor.commands.setTextSelection(findTextRange(editor, "Source"));
    const captured = captureTextFormat(editor);
    if (!captured.ok || !captured.format) throw new Error("format capture failed");
    editor.commands.setTextSelection(findTextRange(editor, "Target"));
    applyCapturedTextFormat(editor, captured.format);
    expect(textMarks(editor, "Target").bold).toBeDefined();
    expect(textMarks(editor, "Target").italic).toBeUndefined();

    editor.commands.undo();
    expect(textMarks(editor, "Target").bold).toBeUndefined();
    expect(textMarks(editor, "Target").italic).toBeDefined();
  });

  it("degrades multi-block targets without converting their node types", () => {
    const editor = createEditor({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 3, textAlign: "center", lineHeight: "1.8" },
          content: [{ type: "text", text: "Source", marks: [{ type: "bold" }] }],
        },
        { type: "paragraph", content: [{ type: "text", text: "First" }] },
        { type: "paragraph", content: [{ type: "text", text: "Second" }] },
      ],
    });

    editor.commands.setTextSelection(findTextRange(editor, "Source"));
    const captured = captureTextFormat(editor);
    if (!captured.ok || !captured.format) throw new Error("format capture failed");
    const first = findTextRange(editor, "First");
    const second = findTextRange(editor, "Second");
    editor.commands.setTextSelection({ from: first.from, to: second.to });

    expect(applyCapturedTextFormat(editor, captured.format)).toMatchObject({ ok: true, degraded: true });
    expect(blockForText(editor, "First")).toMatchObject({
      type: "paragraph",
      attrs: { textAlign: "center", lineHeight: "1.8" },
    });
    expect(blockForText(editor, "Second")).toMatchObject({
      type: "paragraph",
      attrs: { textAlign: "center", lineHeight: "1.8" },
    });
    expect(textMarks(editor, "First").bold).toBeDefined();
    expect(textMarks(editor, "Second").bold).toBeDefined();
  });

  it("keeps list structure when the requested heading conversion is invalid", () => {
    const editor = createEditor({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2, textAlign: "center", lineHeight: "1.6" },
          content: [{ type: "text", text: "Source", marks: [{ type: "bold" }] }],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "Nested target" }] },
              ],
            },
          ],
        },
      ],
    });

    editor.commands.setTextSelection(findTextRange(editor, "Source"));
    const captured = captureTextFormat(editor);
    if (!captured.ok || !captured.format) throw new Error("format capture failed");
    editor.commands.setTextSelection(findTextRange(editor, "Nested target"));

    expect(applyCapturedTextFormat(editor, captured.format)).toMatchObject({ ok: true, degraded: true });
    expect(blockForText(editor, "Nested target")).toMatchObject({
      type: "paragraph",
      attrs: { textAlign: "center", lineHeight: "1.6" },
    });
    expect(textMarks(editor, "Nested target").bold).toBeDefined();
  });

  it("rejects unsafe style values and readonly edits", () => {
    expect(normalizeSafeFormatColor("#abc")).toBe("#abc");
    expect(normalizeSafeFormatColor("rgb(12, 34, 56)")).toBe("rgb(12, 34, 56)");
    expect(normalizeSafeFormatColor("var(--secret)")).toBeNull();
    expect(normalizeSafeFormatColor("url(javascript:alert(1))")).toBeNull();
    expect(normalizeSafeFormatColor("rgb(999, 0, 0)")).toBeNull();

    const editor = createEditor({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Readonly" }] }],
    });
    editor.commands.setTextSelection(findTextRange(editor, "Readonly"));
    editor.setEditable(false);
    expect(captureTextFormat(editor)).toEqual({ ok: false, reason: "readonly" });

    const format: CapturedTextFormat = {
      marks: {
        bold: true,
        italic: false,
        underline: false,
        strike: false,
        fontSize: null,
        color: null,
        highlight: null,
      },
      block: null,
    };
    expect(applyCapturedTextFormat(editor, format)).toEqual({ ok: false, reason: "readonly" });
  });
});
