import { describe, expect, it } from "vitest";
import {
  addSheetColumn,
  addSheetRow,
  deleteSheetColumn,
  deleteSheetRow,
  normalizeSheetData,
  resizeSheetColumn,
  resizeSheetRow,
  setSheetCell,
  sortSheetRows,
} from "@/lib/sheetModel";

const base = () => normalizeSheetData({
  rows: [{ id: "r1", height: 32 }, { id: "r2", height: 32 }],
  columns: [{ id: "c1", title: "A", width: 120 }, { id: "c2", title: "B", width: 120 }],
  cells: { "r1:c1": "20", "r2:c1": "3", "r1:c2": "Beta", "r2:c2": "Alpha" },
});

describe("sheetModel", () => {
  it("edits cells and keeps sparse storage", () => {
    expect(setSheetCell(base(), "r1", "c1", "42").cells["r1:c1"]).toBe("42");
    expect(setSheetCell(base(), "r1", "c1", "").cells["r1:c1"]).toBeUndefined();
  });

  it("adds and deletes rows and columns with their cells", () => {
    const withRow = addSheetRow(base());
    expect(withRow.rows).toHaveLength(3);
    const withColumn = addSheetColumn(withRow);
    expect(withColumn.columns).toHaveLength(3);
    expect(deleteSheetRow(withColumn, "r1").cells["r1:c1"]).toBeUndefined();
    expect(deleteSheetColumn(withColumn, "c1").cells["r2:c1"]).toBeUndefined();
  });

  it("clamps row height and column width", () => {
    expect(resizeSheetRow(base(), "r1", 2).rows[0].height).toBe(24);
    expect(resizeSheetColumn(base(), "c1", 999).columns[0].width).toBe(480);
  });

  it("sorts numeric and text values by a selected column", () => {
    expect(sortSheetRows(base(), "c1", "asc").rows.map(row => row.id)).toEqual(["r2", "r1"]);
    expect(sortSheetRows(base(), "c2", "asc").rows.map(row => row.id)).toEqual(["r2", "r1"]);
  });
});
