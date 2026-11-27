import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { createDocx, irToTiptap, parseDocx, tiptapToIr } from "../index";
import { repairTiptapJson } from "@/lib/tiptapSchemaRepair";

async function blobToUint8Array(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") {
    return new Uint8Array(await blob.arrayBuffer());
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error || new Error("Failed to read Blob"));
    reader.readAsArrayBuffer(blob);
  });
}

describe("Word 文档 OOXML 双向 Round-Trip（Tiptap ↔ DocxIR ↔ .docx）", () => {
  it("完整往返保留页面设置、页眉页脚、分页符、标题、行距、列表与合并表格", async () => {
    const sourceDoc = {
      type: "doc",
      content: [
        {
          type: "wordPageSetup",
          attrs: {
            paperSize: "A5",
            orientation: "landscape",
            marginTop: 54,
            marginRight: 36,
            marginBottom: 54,
            marginLeft: 36,
            headerText: "测试页眉",
            footerText: "测试页脚",
          },
        },
        {
          type: "heading",
          attrs: { level: 1, textAlign: "center" },
          content: [{ type: "text", text: "年度总结" }],
        },
        {
          type: "paragraph",
          attrs: { firstLineIndent: 2, lineHeight: "1.5" },
          content: [
            {
              type: "text",
              text: "重点内容",
              marks: [
                { type: "bold" },
                { type: "textStyle", attrs: { color: "#ef4444", fontSize: "16px", fontFamily: "SimSun" } },
              ],
            },
          ],
        },
        {
          type: "orderedList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "第一项" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "第二项" }] }] },
          ],
        },
        { type: "pageBreak" },
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                { type: "tableHeader", attrs: { colspan: 2, rowspan: 1 }, content: [{ type: "paragraph", content: [{ type: "text", text: "合并表头" }] }] },
              ],
            },
            {
              type: "tableRow",
              content: [
                { type: "tableCell", attrs: { colspan: 1, rowspan: 1 }, content: [{ type: "paragraph", content: [{ type: "text", text: "左格" }] }] },
                { type: "tableCell", attrs: { colspan: 1, rowspan: 1 }, content: [{ type: "paragraph", content: [{ type: "text", text: "右格" }] }] },
              ],
            },
          ],
        },
      ],
    };

    const irOut = await tiptapToIr(sourceDoc, { title: "年度总结" });
    expect(irOut.sections[0].orientation).toBe("landscape");
    expect(irOut.sections[0].pageSize).toEqual({ w: 595, h: 420 });
    expect(irOut.sections[0].headerText).toBe("测试页眉");
    expect(irOut.sections[0].footerText).toBe("测试页脚");
    expect(irOut.sections[0].body.some((b) => b.type === "pageBreak")).toBe(true);

    const blob = await createDocx(irOut, { title: "年度总结" });
    const bytes = await blobToUint8Array(blob);

    // 解析回 DocxIR
    const irIn = await parseDocx(bytes);
    expect(irIn.sections[0].orientation).toBe("landscape");
    expect(irIn.sections[0].margins).toEqual({ top: 54, right: 36, bottom: 54, left: 36 });
    expect(irIn.sections[0].headerText).toBe("测试页眉");
    expect(irIn.sections[0].footerText).toBe("测试页脚");
    expect(irIn.sections[0].body.some((b) => b.type === "pageBreak")).toBe(true);

    // 再转回 Tiptap JSON
    const { doc: restored, warnings } = await irToTiptap(irIn);
    expect(warnings).toEqual([]);
    const nodes = restored.content ?? [];
    const setup = nodes.find((n) => n.type === "wordPageSetup");
    expect(setup?.attrs).toMatchObject({
      paperSize: "A5",
      orientation: "landscape",
      marginTop: 54,
      marginRight: 36,
      headerText: "测试页眉",
      footerText: "测试页脚",
    });
    expect(nodes.some((n) => n.type === "heading" && n.attrs?.level === 1)).toBe(true);
    expect(nodes.some((n) => n.type === "pageBreak")).toBe(true);
    expect(nodes.some((n) => n.type === "orderedList")).toBe(true);
    expect(nodes.some((n) => n.type === "table")).toBe(true);

    // 校验经过 schema repair 仍保留 wordPageSetup 与 pageBreak
    const repaired = repairTiptapJson(restored) as { content?: Array<{ type?: string; attrs?: Record<string, unknown> }> };
    expect(repaired.content?.some((n) => n.type === "wordPageSetup" && n.attrs?.paperSize === "A5" && n.attrs?.headerText === "测试页眉")).toBe(true);
    expect(repaired.content?.some((n) => n.type === "pageBreak")).toBe(true);
  });

  it("解析含修订与批注的 docx 时返回透明降级提示 warnings", async () => {
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p>
            <w:commentRangeStart w:id="1"/>
            <w:ins w:id="2"><w:r><w:t>修订文字</w:t></w:r></w:ins>
          </w:p>
        </w:body>
      </w:document>`,
    );
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const ir = await parseDocx(bytes);
    expect(ir.warnings?.some((w) => w.includes("修订"))).toBe(true);
    expect(ir.warnings?.some((w) => w.includes("批注"))).toBe(true);
  });
});
