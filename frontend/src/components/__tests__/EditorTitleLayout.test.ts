import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const editors = [
  { name: "Rich text", file: "TiptapEditor.tsx", marker: 'data-mobile-editor-title=""' },
  { name: "Markdown", file: "MarkdownEditorImpl.tsx", marker: 'data-markdown-mobile-title=""' },
];

describe("Compact editor document title", () => {
  for (const { name, file, marker } of editors) {
    const source = readFileSync(path.resolve(__dirname, "..", file), "utf8");
    const start = source.indexOf(marker);
    const titleSection = source.slice(start, source.indexOf("/>", start));

    it(`${name} uses the same compact, readable title hierarchy`, () => {
      expect(titleSection).toContain("text-lg leading-7 md:text-xl font-semibold");
      expect(titleSection).not.toMatch(/md:text-(2xl|3xl)|font-bold|md:pt-6/);
      expect(titleSection).toContain('compactMobileEditing ? "pt-2" : "pt-3"');
      expect(titleSection).toContain("block w-full");
    });

    it(`${name} preserves full wrapping, auto-height and title editing`, () => {
      expect(titleSection).toContain("break-words");
      expect(titleSection).toContain("el.scrollHeight");
      expect(titleSection).toContain("onBlur={handleTitleBlur}");
      expect(titleSection).toContain("onCompositionStart={handleTitleCompositionStart}");
      expect(titleSection).toContain("onCompositionEnd={handleTitleCompositionEnd}");
      expect(titleSection).not.toMatch(/truncate|line-clamp|max-h-/);
    });
  }
});
