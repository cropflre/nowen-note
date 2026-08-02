import { describe, expect, it } from "vitest";
import {
  localDateRangeToUtcSqlBounds,
  localDateTimeInputToUtcIso,
  utcSqlToLocalDateTimeInput,
} from "../dateTime";

describe("UTC/local time contract", () => {
  it("converts Shanghai datetime-local to UTC before submission", () => {
    expect(localDateTimeInputToUtcIso("2026-07-31T13:30", -480))
      .toBe("2026-07-31T05:30:00.000Z");
  });

  it("converts UTC SQL back to Shanghai datetime-local for editing", () => {
    expect(utcSqlToLocalDateTimeInput("2026-07-31 05:30:00", -480))
      .toBe("2026-07-31T13:30");
  });

  it("converts a local calendar day to exact UTC query bounds", () => {
    expect(localDateRangeToUtcSqlBounds({
      from: "2026-07-31",
      to: "2026-07-31",
    }, -480)).toEqual({
      from: "2026-07-30 16:00:00",
      to: "2026-07-31 15:59:59",
    });
  });
});
