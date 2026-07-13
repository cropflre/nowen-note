import { describe, expect, it } from "vitest";
import { statsCenterTestUtils } from "../tasks/StatsCenter";

describe("StatsCenter timestamp handling", () => {
  it("treats SQLite datetime values as UTC and ISO offsets as absolute time", () => {
    expect(statsCenterTestUtils.parseDateValue("2026-07-13 01:30:00")?.toISOString())
      .toBe("2026-07-13T01:30:00.000Z");
    expect(statsCenterTestUtils.parseDateValue("2026-07-13T09:30:00+08:00")?.toISOString())
      .toBe("2026-07-13T01:30:00.000Z");
  });
});
