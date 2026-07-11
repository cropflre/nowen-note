import { generateHTML } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import "@/lib/imageNodeTransformBootstrap";
import { tiptapExtensions } from "@/lib/importService";
import { repairTiptapJson } from "@/lib/tiptapSchemaRepair";

describe("TableFidelityExtension", () => {
  it("normalizes numeric SiYuan alignment values and renders visible cell alignment", () => {
    const input = {
      type: "doc",
      content: [{
        type: "table",
        attrs: {
          tableAligns: [1, 2, 3],
          colgroup: [{ width: 120 }, { width: 180 }, { width: 240 }],
        },
        content: [{
          type: "tableRow",
          content: [{
            type: "tableCell",
            attrs: {
              colspan: 1,
              rowspan: 1,
              colwidth: [120],
              align: 2,
            },
            content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }],
          }],
        }],
      }],
    } as any;

    const repaired = repairTiptapJson(input) as any;
    const table = repaired.content?.[0];
    const cell = table?.content?.[0]?.content?.[0];

    expect(table?.attrs?.tableAligns).toEqual(["left", "center", "right"]);
    expect(table?.attrs?.colgroup).toEqual([{ width: 120 }, { width: 180 }, { width: 240 }]);
    expect(cell?.attrs?.align).toBe("center");

    const html = generateHTML(repaired, tiptapExtensions);
    expect(html).toContain("data-nowen-table-aligns");
    expect(html).toMatch(/text-align:\s*center/i);
    expect(html).not.toContain('align="2"');
  });
});
