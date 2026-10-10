import { describe, expect, it } from "vitest";
import {
  formatServerTime,
  parseServerTime,
  localDateRangeToUtcSqlBounds,
  localDateTimeInputToUtcIso,
  utcSqlToLocalDateTimeInput,
} from "../dateTime";

describe("UTC/local time contract", () => {
  it("interprets SQLite last-login timestamps as UTC, not local wall time", () => {
    const loggedInAt = parseServerTime("2026-10-10 06:10:00");
    expect(loggedInAt?.toISOString()).toBe("2026-10-10T06:10:00.000Z");
    expect(parseServerTime("2026-10-10T06:10:00.000Z")?.getTime())
      .toBe(loggedInAt?.getTime());
    expect(parseServerTime("2026-10-10T14:10:00+08:00")?.getTime())
      .toBe(loggedInAt?.getTime());
  });

  it("displays last-login timestamps in the browser's requested timezone", () => {
    const timeOptions: Intl.DateTimeFormatOptions = {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    };
    expect(formatServerTime("2026-10-10 06:10:00", timeOptions)).toContain("14:10");
    expect(formatServerTime("2026-10-10T06:10:00.000Z", timeOptions)).toContain("14:10");
    expect(formatServerTime("2026-10-10 06:10:00", { ...timeOptions, timeZone: "UTC" }))
      .toContain("06:10");
  });

  it("preserves local calendar-day boundaries and handles users without a login", () => {
    const date = parseServerTime("2026-10-10 17:30:00");
    expect(date?.toISOString()).toBe("2026-10-10T17:30:00.000Z");
    expect(new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Shanghai",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(date!)).toBe("11, 01:30");
    expect(formatServerTime(null, undefined, "—")).toBe("—");
    expect(formatServerTime("invalid", undefined, "—")).toBe("—");
  });

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
