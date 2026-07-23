import { describe, expect, it } from "vitest";

import { planTiptapBlockPatch } from "@/lib/tiptapBlockPatchPlanner";

function paragraph(blockId: string, text: string) {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: text ? [{ type: "text", text }] : [],
  };
}

function doc(content: unknown[]) {
  return JSON.stringify({ type: "doc", content });
}

describe("Tiptap empty document Block reconciliation", () => {
  it("deletes the final persisted Block and lets the server create the canonical empty paragraph", () => {
    expect(planTiptapBlockPatch(
      doc([paragraph("blk_empty001", "Last text")]),
      doc([]),
    )).toEqual({
      kind: "empty-document",
      operations: [{ type: "delete", blockId: "blk_empty001" }],
      affectedBlockIds: ["blk_empty001"],
    });
  });

  it("handles the schema placeholder paragraph when it has no stable Block ID", () => {
    expect(planTiptapBlockPatch(
      doc([
        paragraph("blk_empty001", "First"),
        paragraph("blk_empty002", "Second"),
      ]),
      doc([{
        type: "paragraph",
        attrs: { blockId: null, textAlign: null, lineHeight: null },
        content: [],
      }]),
    )).toEqual({
      kind: "empty-document",
      operations: [
        { type: "delete", blockId: "blk_empty001" },
        { type: "delete", blockId: "blk_empty002" },
      ],
      affectedBlockIds: ["blk_empty001", "blk_empty002"],
    });
  });

  it("keeps identified empty paragraphs and complex documents on their established paths", () => {
    expect(planTiptapBlockPatch(
      doc([paragraph("blk_empty001", "Text")]),
      doc([paragraph("blk_local000", "")]),
    )).toMatchObject({
      kind: "top-level-structural",
      operations: [
        { type: "delete", blockId: "blk_empty001" },
        { type: "create", blockId: "blk_local000", text: "" },
      ],
    });

    expect(planTiptapBlockPatch(
      doc([{
        type: "bulletList",
        content: [{
          type: "listItem",
          attrs: { blockId: "blk_item0000" },
          content: [paragraph("blk_nested00", "Nested")],
        }],
      }]),
      doc([]),
    )).toBeNull();
  });
});
