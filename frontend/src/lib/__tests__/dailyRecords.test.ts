import { describe, expect, it } from "vitest";

import {
  extractJournalPreview,
  formatCurrentTimestamp,
  formatLocalDateKey,
  parseLocalDateKey,
  relativeLocalDateKey,
  shiftLocalDateKey,
  shiftLocalMonthKey,
} from "@/lib/dailyRecords";

describe("daily records date helpers", () => {
  it("formats dates in local calendar space", () => {
    expect(formatLocalDateKey(new Date(2026, 7, 3, 23, 50))).toBe("2026-08-03");
  });

  it("shifts across day, month and year boundaries without UTC conversion", () => {
    expect(shiftLocalDateKey("2026-08-31", 1)).toBe("2026-09-01");
    expect(shiftLocalDateKey("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftLocalDateKey("2028-02-28", 1)).toBe("2028-02-29");
  });

  it("moves by calendar month and clamps to the target month end", () => {
    expect(shiftLocalMonthKey("2026-03-31", -1)).toBe("2026-02-28");
    expect(shiftLocalMonthKey("2028-01-31", 1)).toBe("2028-02-29");
    expect(shiftLocalMonthKey("2026-12-31", 1)).toBe("2027-01-31");
  });

  it("derives relative dates from the caller local day", () => {
    const now = new Date(2026, 7, 31, 23, 59);
    expect(relativeLocalDateKey(0, now)).toBe("2026-08-31");
    expect(relativeLocalDateKey(1, now)).toBe("2026-09-01");
    expect(relativeLocalDateKey(2, now)).toBe("2026-09-02");
  });

  it("rejects impossible calendar dates", () => {
    expect(() => parseLocalDateKey("2026-02-30")).toThrow("Invalid calendar date");
    expect(() => parseLocalDateKey("2026/02/03")).toThrow("Invalid local date key");
  });

  it("formats a stable local timestamp", () => {
    expect(formatCurrentTimestamp(new Date(2026, 7, 3, 9, 5))).toBe("2026-08-03 09:05");
  });
});

describe("daily journal preview", () => {
  it("prefers authoritative contentText", () => {
    expect(extractJournalPreview('{"type":"doc"}', "今天完成了产品评审")).toBe("今天完成了产品评审");
  });

  it("extracts text from tiptap json", () => {
    const content = JSON.stringify({
      type: "doc",
      content: [
        { type: "heading", content: [{ type: "text", text: "今日复盘" }] },
        { type: "paragraph", content: [{ type: "text", text: "修复了日期导航。" }] },
      ],
    });
    expect(extractJournalPreview(content)).toBe("今日复盘\n修复了日期导航。");
  });

  it("compacts repeated paragraph gaps from contentText", () => {
    expect(extractJournalPreview("", "第一段\n\n\n第二段\n \n第三段")).toBe(
      "第一段\n第二段\n第三段",
    );
  });

  it("normalizes markdown and truncates long content", () => {
    expect(extractJournalPreview("# 标题\n\n**正文**", "", 4)).toBe("标题\n正…");
  });
});
