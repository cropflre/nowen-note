import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { parseSheetXlsx, parseWorkbookXlsx, workbookSheetToImport, XLSX_PREVIEW_LIMITS } from "@/lib/sheetXlsx";
import { workbookFixture, dataWorksheet } from "./xlsxFixture";

describe("XLSX workbook preview", () => {
  it("preserves first row, Excel column names and workbook sheet order; import keeps header semantics", async () => {
    const buffer = await workbookFixture([{ name: "预算 &amp; 数据", xml: dataWorksheet }, { name: "空表", xml: "<worksheet><sheetData/></worksheet>" }]);
    const workbook = await parseWorkbookXlsx(buffer);
    expect(workbook.sheets.map((sheet) => sheet.name)).toEqual(["预算 & 数据", "空表"]);
    expect(workbook.sheets[0].data.columns.map((column) => column.title)).toEqual(["A", "B"]);
    expect(workbook.sheets[0].data.cells).toEqual({ "r1:c1": "名称", "r1:c2": "金额", "r2:c1": "房租", "r2:c2": "3000" });
    expect(workbook.sheets[1].data.rows).toEqual([]);
    const imported = workbookSheetToImport(workbook.sheets[0].data);
    expect(imported.columns.map((column) => column.title)).toEqual(["名称", "金额"]);
    expect(imported.cells["r1:c2"]).toBe("3000");
    expect(await parseSheetXlsx(buffer)).toEqual(imported);
  });

  it("reads prefixed XML, booleans, explicit dates, sparse cells and cached results without executing formulas", async () => {
    const execute = vi.fn();
    (globalThis as any).xlsxExecute = execute;
    const buffer = await workbookFixture([{ name: "值", xml: `<s:worksheet xmlns:s="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><s:sheetData>
      <s:row r="1"><s:c r="A1" t="b"><s:v>1</s:v></s:c><s:c r="B1" t="b"><s:v>0</s:v></s:c><s:c r="C1" t="d"><s:v>2026-10-03T00:00:00Z</s:v></s:c><s:c r="D1"><s:f>xlsxExecute()</s:f><s:v>42</s:v></s:c><s:c r="E1" s="1"><s:f>SUM(A1)</s:f></s:c><s:c r="F1"/></s:row>
      <s:row r="3"><s:c r="C3" t="inlineStr"><s:is><s:t>&lt;script&gt;xlsxExecute()&lt;/script&gt;</s:t></s:is></s:c></s:row>
      </s:sheetData></s:worksheet>` }], { "xl/styles.xml": '<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>' });
    const { data } = (await parseWorkbookXlsx(buffer)).sheets[0];
    expect(data.cells).toEqual({ "r1:c1": "TRUE", "r1:c2": "FALSE", "r1:c3": "2026-10-03", "r1:c4": "42", "r3:c3": "<script>xlsxExecute()</script>" });
    expect(data.rows).toHaveLength(3);
    expect(data.columns).toHaveLength(6);
    expect(execute).not.toHaveBeenCalled();
    delete (globalThis as any).xlsxExecute;
  });

  it.each(["A1001", "GS1"])("rejects out-of-range cell %s without silently truncating", async (ref) => {
    const buffer = await workbookFixture([{ name: "大表", xml: `<worksheet><sheetData><row><c r="${ref}"><v>1</v></c></row></sheetData></worksheet>` }]);
    await expect(parseWorkbookXlsx(buffer)).rejects.toMatchObject({ code: "limit" });
  });

  it("checks worksheet dimensions and allows exactly 1000 preview rows", async () => {
    const accepted = await workbookFixture([{ name: "表", xml: '<worksheet><dimension ref="A1:A1000"/><sheetData><row><c r="A1000"><v>1</v></c></row></sheetData></worksheet>' }]);
    expect((await parseWorkbookXlsx(accepted)).sheets[0].data.rows).toHaveLength(1000);
    const rejected = await workbookFixture([{ name: "表", xml: '<worksheet><dimension ref="A1:A1001"/><sheetData/></worksheet>' }]);
    await expect(parseWorkbookXlsx(rejected)).rejects.toMatchObject({ code: "limit" });
  });

  it("rejects more than 20 worksheets and more than 200000 total grid cells", async () => {
    const tooManySheets = await workbookFixture(Array.from({ length: 21 }, (_, i) => ({ name: `表${i}`, xml: "<worksheet/>" })));
    await expect(parseWorkbookXlsx(tooManySheets)).rejects.toMatchObject({ code: "limit" });
    const full = '<worksheet><sheetData><row><c r="GR1000"><v>1</v></c></row></sheetData></worksheet>';
    const tooManyCells = await workbookFixture([{ name: "1", xml: full }, { name: "2", xml: dataWorksheet }]);
    await expect(parseWorkbookXlsx(tooManyCells)).rejects.toMatchObject({ code: "limit" });
  });

  it("rejects oversized input before attempting ZIP parsing", async () => {
    await expect(parseWorkbookXlsx(new Uint8Array(XLSX_PREVIEW_LIMITS.fileBytes + 1))).rejects.toMatchObject({ code: "limit" });
  });

  it("rejects excessive XML expansion before inflating it", async () => {
    const buffer = await workbookFixture([{ name: "表", xml: dataWorksheet }]);
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    for (let offset = 0; offset < bytes.length - 46; offset++) {
      if (view.getUint32(offset, true) === 0x02014b50) {
        const nameLength = view.getUint16(offset + 28, true);
        const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
        if (!name.endsWith(".xml")) continue;
        view.setUint32(offset + 24, XLSX_PREVIEW_LIMITS.xmlBytes + 1, true);
        break;
      }
    }
    await expect(parseWorkbookXlsx(buffer)).rejects.toMatchObject({ code: "limit" });
  });

  it("enforces actual XML bytes when ZIP sizes are dishonest", async () => {
    const buffer = await workbookFixture([{ name: "表", xml: dataWorksheet }]);
    const view = new DataView(buffer);
    for (let offset = 0; offset < view.byteLength - 46; offset++) {
      if (view.getUint32(offset, true) === 0x02014b50) view.setUint32(offset + 24, 1, true);
    }
    const original = XLSX_PREVIEW_LIMITS.xmlBytes;
    XLSX_PREVIEW_LIMITS.xmlBytes = 50;
    try { await expect(parseWorkbookXlsx(buffer)).rejects.toMatchObject({ code: "limit" }); }
    finally { XLSX_PREVIEW_LIMITS.xmlBytes = original; }
  });

  it.each(["<worksheet><sheetData>", "<other/>", '<!DOCTYPE worksheet [<!ENTITY text "untrusted">]><worksheet/>' ])("rejects malformed or invalid worksheet XML", async (xml) => {
    await expect(parseWorkbookXlsx(await workbookFixture([{ name: "表", xml }]))).rejects.toMatchObject({ code: "invalid" });
  });

  it("rejects missing sheet relationships, missing parts, ZIP and encrypted CFB data", async () => {
    const zip = await JSZip.loadAsync(await workbookFixture([{ name: "表", xml: dataWorksheet }]));
    zip.remove("xl/worksheets/custom0.xml");
    await expect(parseWorkbookXlsx(await zip.generateAsync({ type: "arraybuffer" }))).rejects.toMatchObject({ code: "invalid" });
    zip.file("xl/_rels/workbook.xml.rels", '<Relationships><Relationship Id="r0" Type="a/worksheet" TargetMode="External" Target="https://example.com/file.xml"/></Relationships>');
    await expect(parseWorkbookXlsx(await zip.generateAsync({ type: "arraybuffer" }))).rejects.toMatchObject({ code: "invalid" });
    await expect(parseWorkbookXlsx(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).rejects.toMatchObject({ code: "invalid" });
    await expect(parseWorkbookXlsx(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({ code: "invalid" });
  });
});
