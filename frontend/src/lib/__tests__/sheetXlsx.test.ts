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

  it("rejects archives that do not contain an OOXML workbook", async () => {
    await expect(parseSheetXlsx(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });
});
