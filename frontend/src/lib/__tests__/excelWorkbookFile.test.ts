// Excel 工作簿 XLSX / CSV 往返。功能来源：cropflre/nowen-note PR #802（以仓库现有 JSZip 读取器替代 xlsx@0.18.5）。
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  EXCEL_FILE_LIMITS,
  ExcelFileError,
  readCsvWorkbook,
  readXlsxWorkbook,
  shiftFormulaReferences,
  writeCsvSheet,
  writeXlsxWorkbook,
  type ExcelWorkbook,
} from "@/lib/excelWorkbookFile";
import { workbookFixture } from "./xlsxFixture";

function sampleWorkbook(): ExcelWorkbook {
  return {
    id: "workbook-01",
    name: "预算",
    locale: "zhCN",
    styles: { date: { n: { pattern: "yyyy-mm-dd" } }, pct: { n: { pattern: "0.0%" } } },
    sheetOrder: ["sheet-01", "sheet-02"],
    sheets: {
      "sheet-01": {
        id: "sheet-01", name: "收入 & 支出", rowCount: 200, columnCount: 26,
        cellData: {
          0: { 0: { v: "项目", t: 1 }, 1: { v: "金额", t: 1 }, 2: { v: "完成", t: 1 } },
          1: { 0: { v: "工资 <A&B>", t: 1 }, 1: { v: 1200.5, t: 2 }, 2: { v: 1, t: 3 } },
          2: { 0: { v: "奖金", t: 1 }, 1: { v: 300, t: 2 }, 2: { v: 0, t: 3 } },
          3: { 0: { v: "合计", t: 1 }, 1: { f: "=SUM(B2:B3)", v: 1500.5, t: 2 }, 2: { f: "=B4/2", v: 750.25, t: 2 } },
          4: { 0: { v: 46000, t: 2, s: "date" }, 1: { v: 0.125, t: 2, s: "pct" }, 3: { f: "=\"总计\"&B4", v: "总计1500.5", t: 1 } },
          6: { 0: { v: "合并标题", t: 1 } },
        },
        mergeData: [{ startRow: 6, endRow: 7, startColumn: 0, endColumn: 2 }],
        columnData: { 0: { w: 152 } },
        rowData: { 6: { h: 40 } },
      },
      "sheet-02": {
        id: "sheet-02", name: "引用", rowCount: 200, columnCount: 26, hidden: 1,
        cellData: { 0: { 0: { f: "='收入 & 支出'!B4*2", v: 3001, t: 2 } } },
        mergeData: [],
      },
    },
  };
}

describe("Excel workbook XLSX", () => {
  it("round-trips sheets, values, formulas, merges, number formats and sizes", async () => {
    const source = sampleWorkbook();
    const buffer = await writeXlsxWorkbook(source);
    // 日期写出确切格式码，而不是随 Excel 区域设置变化的内置编号 14。
    const stylesXml = await (await JSZip.loadAsync(buffer)).file("xl/styles.xml")!.async("string");
    expect(stylesXml).toContain('formatCode="yyyy-mm-dd"');
    const { workbook, warnings } = await readXlsxWorkbook(buffer, "预算");
    expect(warnings).toEqual([]);
    const order = workbook.sheetOrder.map((id) => workbook.sheets[id]);
    expect(order.map((sheet) => sheet.name)).toEqual(["收入 & 支出", "引用"]);
    expect(order[1].hidden).toBe(1);

    const [first, second] = order;
    const original = source.sheets["sheet-01"].cellData;
    for (const [row, columns] of Object.entries(original)) {
      for (const [column, cell] of Object.entries(columns)) {
        const restored = first.cellData[row][column];
        expect({ v: restored.v, t: restored.t, f: restored.f }).toEqual({ v: cell.v, t: cell.t, f: cell.f });
        const pattern = cell.s ? source.styles[cell.s].n!.pattern : undefined;
        expect(restored.s ? workbook.styles[restored.s].n!.pattern : undefined).toBe(pattern);
      }
    }
    expect(second.cellData["0"]["0"].f).toBe("='收入 & 支出'!B4*2");
    expect(first.mergeData).toEqual([{ startRow: 6, endRow: 7, startColumn: 0, endColumn: 2 }]);
    expect(first.columnData?.["0"].w).toBe(152);
    expect(first.rowData?.["6"].h).toBe(40);

    // 再导出一次，第二轮与第一轮内容一致（往返稳定）。
    const again = await readXlsxWorkbook(await writeXlsxWorkbook(workbook), "预算");
    expect(again.workbook.sheets).toEqual(workbook.sheets);
  });

  it("expands shared formulas, converts 1904 dates and lists every feature it cannot keep", async () => {
    const buffer = await workbookFixture([{
      name: "数据",
      xml: `<worksheet><cols><col min="1" max="2" width="20" customWidth="1"/></cols><sheetData>
        <row r="1"><c r="A1"><v>1</v></c><c r="B1"><f t="shared" ref="B1:B3" si="0">A1*$C$1+SUM($A$1:A1)</f><v>3</v></c><c r="C1" s="1"><v>2</v></c><c r="D1" s="2"><v>0</v></c></row>
        <row r="2"><c r="A2"><v>2</v></c><c r="B2"><f t="shared" si="0"/><v>7</v></c></row>
        <row r="3"><c r="A3"><v>3</v></c><c r="B3"><f t="shared" si="0"/><v>12</v></c><c r="C3"><f t="array" ref="C3">SUM(A1:A3*2)</f><v>12</v></c></row>
      </sheetData><conditionalFormatting sqref="A1"/><dataValidations count="1"/></worksheet>`,
    }], {
      "xl/workbook.xml": `<workbook xmlns:r="r"><workbookPr date1904="1"/><sheets><sheet name="数据" r:id="r0"/></sheets><definedNames><definedName name="X">数据!$A$1</definedName></definedNames></workbook>`,
      "xl/styles.xml": `<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="0" fontId="1"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
      "xl/charts/chart1.xml": "<c/>",
      "xl/comments1.xml": "<comments/>",
      "xl/drawings/vmlDrawing1.vml": "<xml/>",
    });
    const { workbook, warnings } = await readXlsxWorkbook(buffer, "导入");
    const sheet = workbook.sheets[workbook.sheetOrder[0]];
    expect(sheet.cellData["1"]["1"].f).toBe("=A2*$C$1+SUM($A$1:A2)");
    expect(sheet.cellData["2"]["1"].f).toBe("=A3*$C$1+SUM($A$1:A3)");
    expect(sheet.cellData["0"]["3"]).toMatchObject({ v: 1462, t: 2 });
    expect(workbook.styles[sheet.cellData["0"]["3"].s!].n!.pattern).toBe("yyyy-mm-dd");
    expect(sheet.columnData?.["1"].w).toBe(145);
    expect(warnings).toEqual(expect.arrayContaining([
      "图表", "批注", "名称管理器中的定义名称", "条件格式", "数据验证",
      "单元格样式（字体、颜色、边框、对齐）", "数组公式（已按普通公式导入，结果可能不同）",
    ]));
    // 批注自带的 VML 不是图片，不应误报。
    expect(warnings).not.toContain("图片与绘图对象");
  });

  it("rejects unsupported, damaged and oversized workbooks instead of importing part of them", async () => {
    await expect(readXlsxWorkbook(new TextEncoder().encode("ID;not a zip").buffer, "x")).rejects.toMatchObject({ code: "unsupported" });
    const tooTall = await workbookFixture([{ name: "大", xml: `<worksheet><dimension ref="A1:B${EXCEL_FILE_LIMITS.rows + 1}"/><sheetData/></worksheet>` }]);
    await expect(readXlsxWorkbook(tooTall, "x")).rejects.toMatchObject({ code: "limit" });
    const wide = await workbookFixture([{ name: "宽", xml: `<worksheet><sheetData><row r="1"><c r="${"ALM"}1"><v>1</v></c></row></sheetData></worksheet>` }]);
    await expect(readXlsxWorkbook(wide, "x")).rejects.toBeInstanceOf(ExcelFileError);
    const orphan = await workbookFixture([{ name: "坏", xml: `<worksheet><sheetData><row r="1"><c r="A1"><f t="shared" si="9"/></c></row></sheetData></worksheet>` }]);
    await expect(readXlsxWorkbook(orphan, "x")).rejects.toMatchObject({ code: "invalid" });
    const doctype = new JSZip();
    doctype.file("xl/workbook.xml", "<!DOCTYPE x [<!ENTITY a \"b\">]><workbook/>");
    await expect(readXlsxWorkbook(await doctype.generateAsync({ type: "arraybuffer" }), "x")).rejects.toBeInstanceOf(ExcelFileError);
    await expect(readXlsxWorkbook(new Uint8Array(EXCEL_FILE_LIMITS.fileBytes + 1), "x")).rejects.toMatchObject({ code: "limit" });
  });
});

describe("shiftFormulaReferences", () => {
  it("moves only relative references and leaves strings, sheet names and functions intact", () => {
    expect(shiftFormulaReferences("A1+$B$1+C$2+$D3", 2, 1)).toBe("B3+$B$1+D$2+$D5");
    expect(shiftFormulaReferences("SUM(A1:A3)&\"A1\"&LOG10(A1)", 1, 0)).toBe("SUM(A2:A4)&\"A1\"&LOG10(A2)");
    expect(shiftFormulaReferences("'Q1 A1'!B2+Table1[A1]+SUM(A:A)+SUM(1:1)", 1, 1)).toBe("'Q1 A1'!C3+Table1[A1]+SUM(B:B)+SUM(2:2)");
    expect(() => shiftFormulaReferences("A1", -1, 0)).toThrow(ExcelFileError);
  });
});

describe("Excel workbook CSV", () => {
  it("keeps text exactly, converts only lossless numbers and never turns CSV text into formulas", () => {
    const { workbook } = readCsvWorkbook("\uFEFF编号,金额,备注\r\n007,1.50,\"含,逗号\"\n42,-3,\"=HYPERLINK(\"\"x\"\")\"\n", "导入");
    const cells = workbook.sheets["sheet-01"].cellData;
    expect(cells["1"]["0"]).toEqual({ v: "007", t: 1 });
    expect(cells["1"]["1"]).toEqual({ v: "1.50", t: 1 });
    expect(cells["2"]["0"]).toEqual({ v: 42, t: 2 });
    expect(cells["2"]["1"]).toEqual({ v: -3, t: 2 });
    expect(cells["2"]["2"]).toEqual({ v: "=HYPERLINK(\"x\")", t: 1 });
    expect(cells["1"]["2"].f).toBeUndefined();

    const { csv, warnings } = writeCsvSheet(workbook);
    expect(csv).toBe("编号,金额,备注\r\n007,1.50,\"含,逗号\"\r\n42,-3,\"=HYPERLINK(\"\"x\"\")\"");
    expect(warnings).toEqual([]);
    expect(readCsvWorkbook(csv, "导入").workbook.sheets).toEqual(workbook.sheets);
  });

  it("explains what a CSV export leaves out and rejects oversized input", () => {
    const { csv, warnings } = writeCsvSheet(sampleWorkbook(), "sheet-01");
    expect(csv.split("\r\n")[3]).toBe("合计,1500.5,750.25");
    expect(csv.split("\r\n")[1]).toBe("工资 <A&B>,1200.5,TRUE");
    // 日期格式的单元格导出为日期文本，而不是序列号 46000。
    expect(csv.split("\r\n")[4]).toBe("2025-12-09,0.125,,总计1500.5");
    expect(warnings).toEqual([
      "只导出当前工作表「收入 & 支出」，其余 1 张工作表不包含在 CSV 中",
      "公式以计算结果导出",
      "合并单元格不会保留",
    ]);
    expect(() => readCsvWorkbook("a\n".repeat(EXCEL_FILE_LIMITS.rows + 1), "x")).toThrow(ExcelFileError);
  });
});
