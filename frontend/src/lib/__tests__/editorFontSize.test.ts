import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.resolve(__dirname, "../../index.css"), "utf8");
const markdownEditor = readFileSync(
  path.resolve(__dirname, "../../components/MarkdownEditorImpl.tsx"),
  "utf8",
);

describe("editor default font size", () => {
  it("applies the display-only preference to rich text and Markdown preview", () => {
    expect(css).toMatch(/\.ProseMirror\s*\{[^}]*font-size:\s*var\(--editor-font-size, inherit\)/s);
    expect(css).toMatch(/\.nowen-md-preview\s*\{[^}]*font-size:\s*var\(--editor-font-size, inherit\)/s);
  });

  it("keeps the existing Markdown source default until a preference is selected", () => {
    expect(markdownEditor).toContain('fontSize: "var(--editor-font-size, 15px)"');
  });
});
