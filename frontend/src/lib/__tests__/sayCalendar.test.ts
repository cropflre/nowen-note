import { describe, expect, it } from "vitest";
import { groupDiariesByDate } from "../sayCalendar";

describe("moment calendar dates", () => {
  it("groups a midnight record by the user's local day", () => {
    const createdAt = new Date(2026, 9, 2, 0, 30).toISOString();
    const item = { createdAt };
    expect([...groupDiariesByDate([item])]).toEqual([["2026-10-02", [item]]]);
  });

  it("treats SQLite UTC and ISO timestamps as the same instant", () => {
    const iso = new Date(2026, 9, 2, 0, 30).toISOString();
    const items = [{ createdAt: iso }, { createdAt: iso.slice(0, 19).replace("T", " ") }];
    expect([...groupDiariesByDate(items)]).toEqual([["2026-10-02", items]]);
  });

  it("keeps late-night records on their local day in negative UTC offsets", () => {
    const item = { createdAt: new Date(2026, 9, 2, 23, 30).toISOString() };
    expect([...groupDiariesByDate([item])]).toEqual([["2026-10-02", [item]]]);
  });

  it("does not create calendar markers for invalid timestamps", () => {
    expect(groupDiariesByDate([{ createdAt: "invalid" }, { createdAt: null }, {}]).size).toBe(0);
  });
});
