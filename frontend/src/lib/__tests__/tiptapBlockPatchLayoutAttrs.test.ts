import { describe, expect, it } from "vitest";
import { normalizeSafeTiptapReplacementNode } from "@/lib/tiptapBlockPatchNode";

function paragraph(blockId: string, firstLineIndent: unknown) {
  return {
    type: "paragraph",
    attrs: {
      blockId,
      textAlign: null,
      lineHeight: null,
      indent: 0,
      firstLineIndent,
    },
    content: [{ type: "text", text: "正文" }],
  };
}

function table(blockId: string, align: unknown, width: unknown) {
  return {
    type: "table",
    attrs: {
      blockId,
      tableAligns: null,
      colgroup: [{ width: 160 }],
      tableLayoutAlign: align,
      tableWidthMode: width,
    },
    content: [{
      type: "tableRow",
      attrs: { height: 40 },
      content: [{
        type: "tableCell",
        attrs: { colspan: 1, rowspan: 1, colwidth: [160], align: null },
        content: [{
          type: "paragraph",
          attrs: {
            blockId: "blk_cell7720",
            textAlign: null,
            lineHeight: null,
            indent: 0,
            firstLineIndent: 0,
          },
          content: [{ type: "text", text: "A" }],
        }],
      }],
    }],
  };
}

describe("client block patch layout attrs (#772)", () => {
  it("keeps safe paragraph and table layout attrs", () => {
    expect(normalizeSafeTiptapReplacementNode(
      paragraph("blk_para7720", 2),
      "blk_para7720",
    )).not.toBeNull();

    const normalized = normalizeSafeTiptapReplacementNode(
      table("blk_table772", "center", "full"),
      "blk_table772",
    ) as any;
    expect(normalized?.attrs?.tableLayoutAlign).toBe("center");
    expect(normalized?.attrs?.tableWidthMode).toBe("full");
  });

  it("rejects arbitrary paragraph/table layout values", () => {
    expect(normalizeSafeTiptapReplacementNode(
      paragraph("blk_para7721", "calc(100vw)"),
      "blk_para7721",
    )).toBeNull();

    expect(normalizeSafeTiptapReplacementNode(
      table("blk_table773", "absolute", "9999px"),
      "blk_table773",
    )).toBeNull();
  });
});
