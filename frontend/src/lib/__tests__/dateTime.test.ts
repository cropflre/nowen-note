import { afterEach, describe, expect, it } from "vitest";
import {
  formatDateKeyInTimeZone,
  formatServerTime,
  getEffectiveTimezoneOffsetMinutes,
  getEffectiveTzOffsetForApi,
  localDateRangeToUtcSqlBounds,
  localDateTimeInputToUtcIso,
  parseServerTime,
  setAppTimeZone,
  utcSqlToLocalDateTimeInput,
} from "../dateTime";
import { relativeLocalDateKey } from "../dailyRecords";
import { getTimeZoneSelectOptions, normalizeTimeZonePreference } from "../timeZones";

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
    expect(formatServerTime("2026-10-10 17:30:00", {
      timeZone: "Asia/Shanghai",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })).toMatch(/11.*01:30/);
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

describe("global app timezone preference", () => {
  afterEach(() => {
    setAppTimeZone("auto");
  });

  it("validates and normalizes configured timezone strings", () => {
    expect(normalizeTimeZonePreference("auto")).toBe("auto");
    expect(normalizeTimeZonePreference("Asia/Shanghai")).toBe("Asia/Shanghai");
    expect(normalizeTimeZonePreference("UTC")).toBe("UTC");
    expect(normalizeTimeZonePreference("Invalid/Zone")).toBe("auto");
    expect(normalizeTimeZonePreference("  Asia/Shanghai  ")).toBe("auto");
    expect(normalizeTimeZonePreference("")).toBe("auto");
    expect(normalizeTimeZonePreference(123)).toBe("auto");

    const options = getTimeZoneSelectOptions({ language: "zh-CN", currentValue: "Asia/Tokyo" });
    expect(options[0].value).toBe("auto");
    expect(options.some((item) => item.value === "Asia/Tokyo")).toBe(true);
  });

  it("formats and converts dates using the configured timezone (including DST)", () => {
    setAppTimeZone("Asia/Shanghai");
    const shanghaiFormat = formatServerTime("2026-07-31 18:30:00", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    expect(shanghaiFormat).toContain("02:30");
    expect(shanghaiFormat).toMatch(/2026/);
    expect(shanghaiFormat).toMatch(/08.*01|01.*08/);
    expect(utcSqlToLocalDateTimeInput("2026-07-31 05:30:00")).toBe("2026-07-31T13:30");
    expect(localDateTimeInputToUtcIso("2026-07-31T13:30")).toBe("2026-07-31T05:30:00.000Z");
    expect(localDateRangeToUtcSqlBounds({ from: "2026-07-31", to: "2026-07-31" })).toEqual({
      from: "2026-07-30 16:00:00",
      to: "2026-07-31 15:59:59",
    });
    expect(getEffectiveTimezoneOffsetMinutes(new Date("2026-07-31T05:30:00Z"))).toBe(-480);
    expect(getEffectiveTzOffsetForApi(new Date("2026-07-31T05:30:00Z"))).toBe(480);

    // Switch to America/New_York and verify both EDT (-240) and EST (+300 / -300 API)
    setAppTimeZone("America/New_York");
    expect(utcSqlToLocalDateTimeInput("2026-07-31 05:30:00")).toBe("2026-07-31T01:30");
    expect(localDateTimeInputToUtcIso("2026-07-31T13:30")).toBe("2026-07-31T17:30:00.000Z");
    expect(localDateTimeInputToUtcIso("2026-01-15T13:30")).toBe("2026-01-15T18:30:00.000Z");
    expect(getEffectiveTimezoneOffsetMinutes(new Date("2026-01-15T18:30:00Z"))).toBe(300);
    expect(getEffectiveTzOffsetForApi(new Date("2026-01-15T18:30:00Z"))).toBe(-300);
    expect(formatDateKeyInTimeZone(new Date("2026-10-10T17:30:00Z"))).toBe("2026-10-10");
    expect(relativeLocalDateKey(-1, new Date("2026-10-11T02:00:00Z"))).toBe("2026-10-09");

    setAppTimeZone("Asia/Shanghai");
    expect(formatDateKeyInTimeZone(new Date("2026-10-10T17:30:00Z"))).toBe("2026-10-11");
    expect(relativeLocalDateKey(-1, new Date("2026-10-11T02:00:00Z"))).toBe("2026-10-10");
  });
});
