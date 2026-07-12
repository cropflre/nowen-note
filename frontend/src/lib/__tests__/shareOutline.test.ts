import { describe, expect, it } from "vitest";
import {
  addHeadingIdsToHtml,
  createHeadingId,
  extractOutlineFromHtml,
  extractOutlineFromMarkdown,
  extractOutlineFromTiptap,
} from "@/lib/shareOutline";

describe("shareOutline", () => {
  it("extracts h1-h6 from TipTap JSON", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: "Intro" }],
        },
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Nested " }, { type: "text", text: "Topic" }],
        },
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "Details" }],
        },
        {
          type: "heading",
          attrs: { level: 5 },
          content: [{ type: "text", text: "Too deep" }],
        },
        {
          type: "heading",
          attrs: { level: 6 },
          content: [{ type: "text", text: "Deepest" }],
        },
      ],
    };

    expect(extractOutlineFromTiptap(doc)).toEqual([
      { id: "intro", level: 1, text: "Intro" },
      { id: "nested-topic", level: 2, text: "Nested Topic" },
      { id: "details", level: 3, text: "Details" },
      { id: "too-deep", level: 5, text: "Too deep" },
      { id: "deepest", level: 6, text: "Deepest" },
    ]);
  });

  it("creates stable unique ids for duplicate headings", () => {
    const md = ["# Intro", "## Intro", "### Intro", "##### Intro"].join("\n\n");

    expect(extractOutlineFromMarkdown(md).map((item) => item.id)).toEqual([
      "intro",
      "intro-2",
      "intro-3",
      "intro-4",
    ]);
  });

  it("skips empty headings", () => {
    const md = ["#   ", "## Real heading", "### \t"].join("\n");

    expect(extractOutlineFromMarkdown(md)).toEqual([
      { id: "real-heading", level: 2, text: "Real heading" },
    ]);
  });

  it("returns an empty outline when there are no headings", () => {
    expect(extractOutlineFromMarkdown("plain text\n\n- list item")).toEqual([]);
    expect(extractOutlineFromTiptap({ type: "doc", content: [{ type: "paragraph" }] })).toEqual([]);
    expect(extractOutlineFromHtml("<p>plain text</p>")).toEqual([]);
  });

  it("does not extract markdown headings from fenced code blocks", () => {
    const md = ["```md", "# Not a heading", "```", "", "## Real heading"].join("\n");

    expect(extractOutlineFromMarkdown(md)).toEqual([
      { id: "real-heading", level: 2, text: "Real heading" },
    ]);
  });

  it("extracts HTML h1-h6 and can add matching ids", () => {
    const html = "<h1>Intro</h1><p>x</p><h2>Intro</h2><h4>Deep</h4><h5>Deeper</h5><h6>Deepest</h6>";

    expect(extractOutlineFromHtml(html)).toEqual([
      { id: "intro", level: 1, text: "Intro" },
      { id: "intro-2", level: 2, text: "Intro" },
      { id: "deep", level: 4, text: "Deep" },
      { id: "deeper", level: 5, text: "Deeper" },
      { id: "deepest", level: 6, text: "Deepest" },
    ]);
    expect(addHeadingIdsToHtml(html)).toContain('<h1 id="intro"');
    expect(addHeadingIdsToHtml(html)).toContain('<h2 id="intro-2"');
    expect(addHeadingIdsToHtml(html)).toContain('<h4 id="deep"');
    expect(addHeadingIdsToHtml(html)).toContain('<h5 id="deeper"');
    expect(addHeadingIdsToHtml(html)).toContain('<h6 id="deepest"');
  });

  it("normalizes heading ids with a fallback for punctuation-only headings", () => {
    expect(createHeadingId("Hello, World!")).toBe("hello-world");
    expect(createHeadingId("!!!")).toBe("heading");
  });
});
