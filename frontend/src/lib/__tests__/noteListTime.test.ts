import { describe, expect, it } from "vitest";
import { formatKnowledgeTreeUpdatedAt, noteLocalDayKey } from "../noteListTime";

describe("note UTC timestamps", () => {
  it("renders SQLite UTC timestamps the same as explicit ISO Z", () => {
    const sqlite = "2026-10-10 02:03:00";
    const iso = "2026-10-10T02:03:00.000Z";
    expect(formatKnowledgeTreeUpdatedAt(sqlite, "zh-CN"))
      .toBe(formatKnowledgeTreeUpdatedAt(iso, "zh-CN"));
    expect(noteLocalDayKey(sqlite)).toBe(noteLocalDayKey(iso));
  });

  it("handles explicit timezone offsets consistently", () => {
    expect(noteLocalDayKey("2026-10-10T10:03:00+08:00"))
      .toBe(noteLocalDayKey("2026-10-10T02:03:00Z"));
  });

  it("rejects invalid dates without NaN or invalid formatted values", () => {
    expect(noteLocalDayKey("invalid")).toBeNull();
    expect(formatKnowledgeTreeUpdatedAt("invalid", "zh-CN")).toBe("");
  });
});
