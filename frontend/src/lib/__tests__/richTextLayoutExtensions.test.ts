type LayoutNode = { type?: string; attrs: Record<string, unknown>; content: LayoutNode[] };
import { Editor, generateHTML, generateJSON } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import "@/lib/imageNodeTransformBootstrap";
import { tiptapExtensions } from "@/lib/importService";
import { repairTiptapJson } from "@/lib/tiptapSchemaRepair";
import {
  normalizeFirstLineIndent,
  normalizeTableLayoutAlign,
  normalizeTableWidthMode,
} from "@/components/extensions/RichTextLayoutExtensions";

describe("rich text layout extensions (#772)", () => {
  it("normalizes layout attrs to safe enumerated values", () => {
    expect(normalizeFirstLineIndent(2)).toBe(2);
    expect(normalizeFirstLineIndent("2em")).toBe(2);
    expect(normalizeFirstLineIndent("4em")).toBe(0);
    expect(normalizeTableLayoutAlign("center")).toBe("center");
    expect(normalizeTableLayoutAlign("end")).toBe("right");
    expect(normalizeTableLayoutAlign("fixed;position:absolute")).toBe("left");
    expect(normalizeTableWidthMode("100%")).toBe("full");
    expect(normalizeTableWidthMode("9999px")).toBe("auto");
  });

  it("applies and removes first-line 2em indent across selected paragraphs only", () => {
    const editor = new Editor({
      extensions: tiptapExtensions,
      content: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "第一段" }] },
          { type: "paragraph", content: [{ type: "text", text: "第二段" }] },
          { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "标题" }] },
        ],
      },
    });

    editor.commands.selectAll();
    expect(editor.commands.setFirstLineIndent(2)).toBe(true);
    let json = editor.getJSON() as LayoutNode;
    expect(json.content[0].attrs.firstLineIndent).toBe(2);
    expect(json.content[1].attrs.firstLineIndent).toBe(2);
    expect(json.content[2].attrs.firstLineIndent).toBeUndefined();

    expect(editor.commands.setFirstLineIndent(0)).toBe(true);
    json = editor.getJSON() as LayoutNode;
    expect(json.content[0].attrs.firstLineIndent).toBe(0);
    expect(json.content[1].attrs.firstLineIndent).toBe(0);
    editor.destroy();
  });

  it("persists first-line indent, whole-table alignment, width and colwidth through repair", () => {
    const input = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: {
            blockId: "blk_para7720",
            textAlign: null,
            lineHeight: null,
            indent: 0,
            firstLineIndent: 2,
          },
          content: [{ type: "text", text: "中文首行缩进" }],
        },
        {
          type: "table",
          attrs: {
            blockId: "blk_table772",
            tableAligns: null,
            colgroup: [{ width: 160 }],
            tableLayoutAlign: "center",
            tableWidthMode: "full",
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
        },
      ],
    } as unknown as LayoutNode;

    const repaired = repairTiptapJson(input) as LayoutNode;
    expect(repaired.content[0].attrs.firstLineIndent).toBe(2);
    expect(repaired.content[1].attrs.tableLayoutAlign).toBe("center");
    expect(repaired.content[1].attrs.tableWidthMode).toBe("full");
    expect(repaired.content[1].content[0].content[0].attrs.colwidth).toEqual([160]);

    const editor = new Editor({ extensions: tiptapExtensions, content: repaired });
    const roundTrip = editor.getJSON() as LayoutNode;
    expect(roundTrip.content[0].attrs.firstLineIndent).toBe(2);
    expect(roundTrip.content[1].attrs.tableLayoutAlign).toBe("center");
    expect(roundTrip.content[1].attrs.tableWidthMode).toBe("full");
    expect(roundTrip.content[1].content[0].content[0].attrs.colwidth).toEqual([160]);

    const html = generateHTML(roundTrip, tiptapExtensions);
    expect(html).toContain('data-first-line-indent="2"');
    expect(html).toMatch(/text-indent:\s*2em/i);
    expect(html).toContain('data-nowen-table-align="center"');
    expect(html).toContain('data-nowen-table-width="full"');
    expect(html).toMatch(/margin-left:\s*auto/i);
    expect(html).toMatch(/width:\s*100%/i);

    const parsed = generateJSON(html, tiptapExtensions) as LayoutNode;
    expect(parsed.content[0].attrs.firstLineIndent).toBe(2);
    expect(parsed.content[1].attrs.tableLayoutAlign).toBe("center");
    expect(parsed.content[1].attrs.tableWidthMode).toBe("full");
    editor.destroy();
  });

  it("updates whole-table alignment and width without confusing per-cell alignment metadata", () => {
    const editor = new Editor({
      extensions: tiptapExtensions,
      content: {
        type: "doc",
        content: [{
          type: "table",
          attrs: {
            tableAligns: ["right"],
            colgroup: [{ width: 120 }],
          },
          content: [{
            type: "tableRow",
            content: [{
              type: "tableCell",
              attrs: { colspan: 1, rowspan: 1, colwidth: [120], align: "right" },
              content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }],
            }],
          }],
        }],
      },
    });

    editor.commands.setTextSelection(4);
    expect(editor.commands.setTableLayoutAlign("right")).toBe(true);
    expect(editor.commands.setTableWidthMode("full")).toBe(true);

    const table = (editor.getJSON() as LayoutNode).content[0];
    expect(table.attrs.tableLayoutAlign).toBe("right");
    expect(table.attrs.tableWidthMode).toBe("full");
    expect(table.attrs.tableAligns).toEqual(["right"]);
    expect(table.content[0].content[0].attrs.align).toBe("right");
    editor.destroy();
  });
});
