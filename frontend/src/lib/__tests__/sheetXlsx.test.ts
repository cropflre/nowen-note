import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { normalizeSheetData } from "@/lib/sheetModel";
import { createSheetXlsx, parseSheetXlsx } from "@/lib/sheetXlsx";

describe("sheetXlsx", () => {
  it("round-trips the first worksheet without adding a third-party spreadsheet engine", async () => {
    const source = normalizeSheetData({
      version: 1,
      rows: [{ id: "r1", height: 32 }, { id: "r2", height: 40 }],
      columns: [
        { id: "c1", title: "金额", width: 132, type: "number", align: "right" },
        { id: "c2", title: "日期", width: 128, type: "date", align: "center" },
        { id: "c3", title: "备注", width: 180, type: "text", align: "left" },
      ],
      cells: {
        "r1:c1": "1200.5",
        "r2:c1": "350",
        "r1:c2": "2026-09-28",
        "r2:c2": "2026-10-01",
        "r1:c3": "深圳 & 南山",
        "r2:c3": "A < B / 中文",
      },
    });

    const buffer = await createSheetXlsx(source, "预算/清单");
    const bytes = new Uint8Array(buffer);
    expect(String.fromCharCode(bytes[0], bytes[1])).toBe("PK");

    const restored = await parseSheetXlsx(buffer);
    expect(restored.columns.map((column) => column.title)).toEqual(["金额", "日期", "备注"]);
    expect(restored.columns.map((column) => column.type)).toEqual(["number", "date", "text"]);
    expect(restored.cells["r1:c1"]).toBe("1200.5");
    expect(restored.cells["r2:c2"]).toBe("2026-10-01");
    expect(restored.cells["r1:c3"]).toBe("深圳 & 南山");
    expect(restored.cells["r2:c3"]).toBe("A < B / 中文");
  });

  it("imports common shared-string, cached-formula and styled-date cells", async () => {
    const zip = new JSZip();
    zip.file("xl/workbook.xml", `<?xml version="1.0"?>
      <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
        xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
      </workbook>`);
    zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1"
          Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"
          Target="/xl/worksheets/sheet1.xml"/>
      </Relationships>`);
    zip.file("xl/sharedStrings.xml", `<?xml version="1.0"?>
      <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <si><t>日期</t></si>
        <si><r><t>说明</t></r></si>
        <si><r><t>深</t></r><r><t>圳</t></r></si>
      </sst>`);
    zip.file("xl/styles.xml", `<?xml version="1.0"?>
      <styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <cellXfs count="2">
          <xf numFmtId="0"/>
          <xf numFmtId="14" applyNumberFormat="1"/>
        </cellXfs>
      </styleSheet>`);
    zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0"?>
      <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <sheetData>
          <row r="1">
            <c r="A1" t="s"><v>0</v></c>
            <c r="B1" t="s"><v>1</v></c>
          </row>
          <row r="2">
            <c r="A2" s="1"><v>46293</v></c>
            <c r="B2" t="s"><v>2</v></c>
          </row>
          <row r="3">
            <c r="A3" s="1"><f>A2+1</f><v>46294</v></c>
            <c r="B3" t="str"><f>CONCAT("W","PS")</f><v>WPS</v></c>
          </row>
        </sheetData>
      </worksheet>`);

    const buffer = await zip.generateAsync({ type: "arraybuffer" });
    const restored = await parseSheetXlsx(buffer);
    expect(restored.columns.map((column) => column.title)).toEqual(["日期", "说明"]);
    expect(restored.columns[0].type).toBe("date");
    expect(restored.cells["r1:c1"]).toBe("2026-09-28");
    expect(restored.cells["r2:c1"]).toBe("2026-09-29");
    expect(restored.cells["r1:c2"]).toBe("深圳");
    expect(restored.cells["r2:c2"]).toBe("WPS");
  });

  it("honors the 1904 date system used by some spreadsheet exports", async () => {
    const zip = new JSZip();
    zip.file("xl/workbook.xml", `<?xml version="1.0"?>
      <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
        xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <workbookPr date1904="1"/>
        <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
      </workbook>`);
    zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1"
          Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"
          Target="worksheets/sheet1.xml"/>
      </Relationships>`);
    zip.file("xl/styles.xml", `<?xml version="1.0"?>
      <styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <numFmts count="1"><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/></numFmts>
        <cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="165"/></cellXfs>
      </styleSheet>`);
    zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0"?>
      <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <sheetData>
          <row r="1"><c r="A1" t="inlineStr"><is><t>日期</t></is></c></row>
          <row r="2"><c r="A2" s="1"><v>44831</v></c></row>
        </sheetData>
      </worksheet>`);

    const restored = await parseSheetXlsx(await zip.generateAsync({ type: "arraybuffer" }));
    expect(restored.columns[0].type).toBe("date");
    expect(restored.cells["r1:c1"]).toBe("2026-09-28");
  });

  it("rejects archives that do not contain an OOXML workbook", async () => {
    await expect(parseSheetXlsx(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });
});
