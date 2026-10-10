import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { tiptapToIr } from "./tiptap-to-ir";
import { createDocx } from "./docx-serializer";

describe("DOCX editor layout preservation (#772)", () => {
  it("maps 2-character first-line indent, table alignment, width and column widths to OOXML", async () => {
    const ir = await tiptapToIr({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { firstLineIndent: 2 },
          content: [{ type: "text", text: "中文正文" }],
        },
        {
          type: "table",
          attrs: {
            tableLayoutAlign: "center",
            tableWidthMode: "full",
            colgroup: [{ width: 160 }, { width: "240px" }],
          },
          content: [{
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: { colspan: 1, rowspan: 1, colwidth: [160] },
                content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }],
              },
              {
                type: "tableCell",
                attrs: { colspan: 1, rowspan: 1, colwidth: [240] },
                content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }],
              },
            ],
          }],
        },
      ],
    });

    expect(ir.sections[0].body[0]).toMatchObject({
      type: "paragraph",
      indent: { firstLineChars: 2 },
    });
    expect(ir.sections[0].body[1]).toMatchObject({
      type: "table",
      alignment: "center",
      widthMode: "full",
      colWidths: [120, 180],
    });

    const blob = await createDocx(ir, { title: "layout" });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const xml = await zip.file("word/document.xml")!.async("string");

    expect(xml).toContain('w:firstLineChars="200"');
    expect(xml).toContain('<w:jc w:val="center"/>');
    expect(xml).toContain('<w:tblW w:w="5000" w:type="pct"/>');
    expect(xml).toContain('<w:gridCol w:w="2400"/>');
    expect(xml).toContain('<w:gridCol w:w="3600"/>');
  });

  it("exports explicit auto-width and right alignment without arbitrary CSS", async () => {
    const ir = await tiptapToIr({
      type: "doc",
      content: [{
        type: "table",
        attrs: {
          tableLayoutAlign: "right",
          tableWidthMode: "auto",
        },
        content: [{
          type: "tableRow",
          content: [{
            type: "tableCell",
            attrs: { colspan: 1, rowspan: 1, colwidth: null },
            content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }],
          }],
        }],
      }],
    });

    const blob = await createDocx(ir);
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toContain('<w:jc w:val="right"/>');
    expect(xml).toContain('<w:tblW w:w="0" w:type="auto"/>');
  });
});
