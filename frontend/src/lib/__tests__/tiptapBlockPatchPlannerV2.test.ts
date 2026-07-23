import { describe, expect, it } from "vitest";

import { planTiptapBlockPatch } from "@/lib/tiptapBlockPatchPlanner";

function doc(content: unknown[]) {
  return JSON.stringify({ type: "doc", content });
}

function paragraph(blockId: string, content: unknown[], attrs: Record<string, unknown> = {}) {
  return {
    type: "paragraph",
    attrs: { blockId, textAlign: null, lineHeight: null, ...attrs },
    content,
  };
}

describe("Tiptap Block Patch V2 planner", () => {
  it("plans mark, hard-break and block-attribute changes as one replace operation", () => {
    const blockId = "blk_rich0000";
    const before = doc([paragraph(blockId, [{ type: "text", text: "Before" }])]);
    const afterNode = paragraph(blockId, [
      { type: "text", text: "Bold", marks: [{ type: "bold" }] },
      { type: "hardBreak" },
      {
        type: "text",
        text: "Nowen",
        marks: [{
          type: "link",
          attrs: {
            href: "https://example.com/docs",
            target: "_blank",
            rel: "noopener noreferrer nofollow",
            class: null,
          },
        }],
      },
      {
        type: "text",
        text: " styled",
        marks: [{ type: "textStyle", attrs: { color: "#ef4444", fontSize: "20px" } }],
      },
    ], { textAlign: "center", lineHeight: "1.6" });

    expect(planTiptapBlockPatch(before, doc([afterNode]))).toEqual({
      kind: "node-replace",
      operations: [{ type: "replace", blockId, node: afterNode }],
      affectedBlockIds: [blockId],
    });
  });

  it("plans heading level and code language changes without replacing the full note", () => {
    const headingId = "blk_heading00";
    const codeId = "blk_code0000";
    const before = doc([
      paragraph(headingId, [{ type: "text", text: "Title" }]),
      {
        type: "codeBlock",
        attrs: { blockId: codeId, language: null, indent: 0 },
        content: [{ type: "text", text: "const a = 1" }],
      },
    ]);
    const heading = {
      type: "heading",
      attrs: { blockId: headingId, level: 3, textAlign: "right", lineHeight: "1.8" },
      content: [{ type: "text", text: "Title", marks: [{ type: "italic" }] }],
    };
    const code = {
      type: "codeBlock",
      attrs: { blockId: codeId, language: "typescript", indent: 2 },
      content: [{ type: "text", text: "const answer: number = 42" }],
    };

    expect(planTiptapBlockPatch(before, doc([heading, code]))).toEqual({
      kind: "node-replace",
      operations: [
        { type: "replace", blockId: headingId, node: heading },
        { type: "replace", blockId: codeId, node: code },
      ],
      affectedBlockIds: [headingId, codeId],
    });
  });

  it("keeps unsafe, unknown and schema-changing replacements on whole-note save", () => {
    const blockId = "blk_safe0000";
    const before = doc([paragraph(blockId, [{ type: "text", text: "Safe" }])]);

    const unsafeLink = paragraph(blockId, [{
      type: "text",
      text: "Unsafe",
      marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }],
    }]);
    expect(planTiptapBlockPatch(before, doc([unsafeLink]))).toBeNull();

    const unknownMark = paragraph(blockId, [{
      type: "text",
      text: "Mention",
      marks: [{ type: "mention", attrs: { id: "user-1" } }],
    }]);
    expect(planTiptapBlockPatch(before, doc([unknownMark]))).toBeNull();

    const listBefore = doc([{
      type: "bulletList",
      content: [{
        type: "listItem",
        attrs: { blockId: "blk_item0000" },
        content: [paragraph(blockId, [{ type: "text", text: "Nested" }])],
      }],
    }]);
    const listAfter = doc([{
      type: "bulletList",
      content: [{
        type: "listItem",
        attrs: { blockId: "blk_item0000" },
        content: [{
          type: "heading",
          attrs: { blockId, level: 2, textAlign: null, lineHeight: null },
          content: [{ type: "text", text: "Nested" }],
        }],
      }],
    }]);
    expect(planTiptapBlockPatch(listBefore, listAfter)).toBeNull();
  });
});
