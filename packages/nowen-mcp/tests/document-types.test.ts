import test from "node:test";
import assert from "node:assert/strict";
import {
  applyExcelUpdates,
  buildWorkbookFromSheets,
  summarizeExcelWorkbook,
} from "../src/document-types-tools.js";

test("Excel helpers build, summarize and patch sheets and cells cleanly", () => {
  const wb = buildWorkbookFromSheets("销售统计", [
    {
      name: "Q1",
      rows: [
        ["产品", "销量", "单价", "总额"],
        ["A", 10, 20, "=B2*C2"],
        ["B", 5, 30, "=B3*C3"],
      ],
    },
  ]);

  const summary = summarizeExcelWorkbook(wb);
  assert.equal(summary.length, 1);
  assert.equal(summary[0].name, "Q1");
  assert.equal(summary[0].nonEmptyCellCount, 12);
  assert.deepEqual(summary[0].previewRows[0], {
    row: 0,
    cells: { "0": "产品", "1": "销量", "2": "单价", "3": "总额" },
  });
  assert.equal(summary[0].previewRows[1].cells["3"], "=B2*C2");

  // 精准修改单元格、清空单元格并新增工作表
  const patched = applyExcelUpdates(wb, {
    cellUpdates: [
      { sheetName: "Q1", row: 1, col: 1, value: 12 },
      { sheetName: "Q1", row: 2, col: 0, value: null },
      { sheetName: "Q1", row: 3, col: 0, value: "合计" },
      { sheetName: "Q1", row: 3, col: 3, formula: "=SUM(D2:D3)" },
    ],
    sheets: [
      {
        name: "汇总",
        rows: [["指标", "数值"], ["总计", 390]],
      },
    ],
  });

  const after = summarizeExcelWorkbook(patched);
  assert.equal(after.length, 2);
  assert.equal(after[0].previewRows[1].cells["1"], 12);
  assert.equal(after[0].previewRows[2].cells["0"], undefined);
  assert.equal(after[0].previewRows[3].cells["0"], "合计");
  assert.equal(after[0].previewRows[3].cells["3"], "=SUM(D2:D3)");
  assert.equal(after[1].name, "汇总");
  assert.equal(after[1].previewRows[1].cells["1"], 390);
});

test("applyExcelUpdates rejects unknown sheet name or id", () => {
  const wb = buildWorkbookFromSheets("测试", [{ name: "Sheet1", rows: [["A"]] }]);
  assert.throws(
    () => applyExcelUpdates(wb, { cellUpdates: [{ sheetName: "不存在", row: 0, col: 0, value: 1 }] }),
    /工作表名称不存在/,
  );
  assert.throws(
    () => applyExcelUpdates(wb, { cellUpdates: [{ sheetId: "sheet-99", row: 0, col: 0, value: 1 }] }),
    /工作表 ID 不存在/,
  );
});
