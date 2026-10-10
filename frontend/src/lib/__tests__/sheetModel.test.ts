import { describe, expect, it } from "vitest";
import {
  addSheetColumn,
  addSheetRow,
  deleteSheetColumn,
  deleteSheetRow,
  filterSheetRows,
  moveSheetColumn,
  moveSheetRow,
  normalizeSheetData,
  resizeSheetColumn,
  resizeSheetRow,
  setSheetCell,
  setSheetColumnAlignment,
  setSheetColumnType,
  sheetFromCsv,
  sheetToCsv,
  sortSheetRows,
} from "@/lib/sheetModel";

const base = () => normalizeSheetData({
  rows: [{ id: "r1", height: 32 }, { id: "r2", height: 32 }],
  columns: [
    { id: "c1", title: "金额", width: 120, type: "number", align: "right" },
    { id: "c2", title: "名称", width: 120, type: "text", align: "left" },
  ],
  cells: { "r1:c1": "20", "r2:c1": "3", "r1:c2": "Beta", "r2:c2": "Alpha" },
});

describe("sheetModel", () => {
  it("normalizes old sheet data with backward-compatible column metadata", () => {
    const data = normalizeSheetData({
      rows: [{ id: "r1" }],
      columns: [{ id: "c1", title: "A" }],
      cells: { "r1:c1": "legacy", "missing:c1": "ignored" },
    });
    expect(data.columns[0]).toMatchObject({ type: "text", align: "left" });
    expect(data.cells).toEqual({ "r1:c1": "legacy" });
  });

  it("edits cells and keeps sparse storage", () => {
    expect(setSheetCell(base(), "r1", "c1", "42").cells["r1:c1"]).toBe("42");
    expect(setSheetCell(base(), "r1", "c1", "").cells["r1:c1"]).toBeUndefined();
  });

  it("adds and deletes rows and columns with their cells", () => {
    const withRow = addSheetRow(base());
    expect(withRow.rows).toHaveLength(3);
    const withColumn = addSheetColumn(withRow);
    expect(withColumn.columns).toHaveLength(3);
    expect(withColumn.columns[2]).toMatchObject({ type: "text", align: "left" });
    expect(deleteSheetRow(withColumn, "r1").cells["r1:c1"]).toBeUndefined();
    expect(deleteSheetColumn(withColumn, "c1").cells["r2:c1"]).toBeUndefined();
  });

  it("clamps row height and column width", () => {
    expect(resizeSheetRow(base(), "r1", 2).rows[0].height).toBe(24);
    expect(resizeSheetColumn(base(), "c1", 999).columns[0].width).toBe(480);
  });

  it("stores column type and alignment without rewriting cell values", () => {
    const typed = setSheetColumnType(base(), "c2", "date");
    const aligned = setSheetColumnAlignment(typed, "c2", "center");
    expect(aligned.columns[1]).toMatchObject({ type: "date", align: "center" });
    expect(aligned.cells["r1:c2"]).toBe("Beta");
  });

  it("sorts typed numeric and text values by a selected column", () => {
    expect(sortSheetRows(base(), "c1", "asc").rows.map(row => row.id)).toEqual(["r2", "r1"]);
    expect(sortSheetRows(base(), "c2", "asc").rows.map(row => row.id)).toEqual(["r2", "r1"]);
  });

  it("filters the selected column without mutating row order", () => {
    const data = base();
    expect(filterSheetRows(data, "c2", "alp").map(row => row.id)).toEqual(["r2"]);
    expect(data.rows.map(row => row.id)).toEqual(["r1", "r2"]);
  });

  it("reorders rows and columns while keeping sparse cells keyed by ids", () => {
    const rowsMoved = moveSheetRow(base(), "r2", "r1", "before");
    expect(rowsMoved.rows.map(row => row.id)).toEqual(["r2", "r1"]);
    expect(rowsMoved.cells["r2:c1"]).toBe("3");

    const columnsMoved = moveSheetColumn(base(), "c2", "c1", "before");
    expect(columnsMoved.columns.map(column => column.id)).toEqual(["c2", "c1"]);
    expect(columnsMoved.cells["r1:c2"]).toBe("Beta");
  });

  it("round-trips CSV including quotes, commas and new lines", () => {
    let data = base();
    data = setSheetCell(data, "r1", "c2", 'A, "quoted"');
    data = setSheetCell(data, "r2", "c2", "line1\nline2");
    const csv = sheetToCsv(data);
    const restored = sheetFromCsv(csv);
    expect(restored.columns.map(column => column.title)).toEqual(["金额", "名称"]);
    expect(restored.cells["r1:c2"]).toBe('A, "quoted"');
    expect(restored.cells["r2:c2"]).toBe("line1\nline2");
    expect(restored.columns[0].type).toBe("number");
  });
});
