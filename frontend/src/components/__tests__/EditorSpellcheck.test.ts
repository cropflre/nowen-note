import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const tiptapEditorSource = readFileSync(
  path.resolve(__dirname, "../TiptapEditor.tsx"),
  "utf8",
);

const markdownEditorSource = readFileSync(
  path.resolve(__dirname, "../MarkdownEditorImpl.tsx"),
  "utf8",
);

describe("editor spellcheck", () => {
  it("disables spellcheck for the rich text title and document body", () => {
    expect(tiptapEditorSource).toContain("spellCheck={false}");
    expect(tiptapEditorSource).toContain('spellcheck: "false"');
  });

  it("disables spellcheck for the Markdown title and document body", () => {
    expect(markdownEditorSource).toContain("spellCheck={false}");
    expect(markdownEditorSource).toContain(
      'EditorView.contentAttributes.of({ spellcheck: "false" })',
    );
  });
});
