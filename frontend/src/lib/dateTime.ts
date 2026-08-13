import i18n from "../i18n";

/**
 * 统一时间解析与本地输入转换工具。
 *
 * 数据契约：
 * - 后端数据库中的无时区 `YYYY-MM-DD HH:mm:ss` 一律表示 UTC；
 * - `datetime-local` 一律表示用户设备的本地墙上时间；
 * - 发送到后端前必须转换为带 `Z` 的 ISO 8601；
 * - 展示或回填输入框时再由 UTC 转回设备本地时间。
 */

interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function parseLocalDateTimeInput(value: string): LocalDateTimeParts | null {
  const match = value.trim().match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (!match) return null;
  const parts: LocalDateTimeParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] || "0"),
  };
  const probe = new Date(Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  ));
  if (
    probe.getUTCFullYear() !== parts.year ||
    probe.getUTCMonth() !== parts.month - 1 ||
    probe.getUTCDate() !== parts.day ||
    probe.getUTCHours() !== parts.hour ||
    probe.getUTCMinutes() !== parts.minute ||
    probe.getUTCSeconds() !== parts.second
  ) return null;
  return parts;
}

function resolveLocalOffsetMinutes(
  parts: LocalDateTimeParts,
  timezoneOffsetMinutes?: number,
): number {
  if (typeof timezoneOffsetMinutes === "number" && Number.isFinite(timezoneOffsetMinutes)) {
    return timezoneOffsetMinutes;
  }
  return new Date(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  ).getTimezoneOffset();
}

function getAppLocale(): string | undefined {
  return i18n.resolvedLanguage || i18n.language || undefined;
}

/**
 * 解析后端返回的 UTC 时间字符串。
 * - 已带时区后缀（Z / +08:00）→ 直接解析；
 * - SQLite `YYYY-MM-DD HH:mm:ss` → 追加 Z，按 UTC 解析；
 * - null / undefined / 非法值 → null。
 */
export function parseServerTime(ts: string | undefined | null): Date | null {
  if (!ts || typeof ts !== "string") return null;
  const trimmed = ts.trim();
  if (!trimmed) return null;

  const source = /Z$|[+-]\d{2}:?\d{2}$/.test(trimmed)
    ? trimmed
    : `${trimmed.replace(" ", "T")}Z`;
  const date = new Date(source);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 把浏览器 datetime-local 值转换为明确的 UTC ISO 字符串。 */
export function localDateTimeInputToUtcIso(
  value: string,
  timezoneOffsetMinutes?: number,
): string | null {
  const parts = parseLocalDateTimeInput(value);
  if (!parts) return null;
  const offset = resolveLocalOffsetMinutes(parts, timezoneOffsetMinutes);
  const utcMillis = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  ) + offset * 60_000;
  return new Date(utcMillis).toISOString();
}

/** 把数据库 UTC 时间回填成 datetime-local 需要的本地格式。 */
export function utcSqlToLocalDateTimeInput(
  value: string | undefined | null,
  timezoneOffsetMinutes?: number,
): string {
  const date = parseServerTime(value);
  if (!date) return "";

  if (typeof timezoneOffsetMinutes === "number" && Number.isFinite(timezoneOffsetMinutes)) {
    const local = new Date(date.getTime() - timezoneOffsetMinutes * 60_000);
    return `${local.getUTCFullYear()}-${pad2(local.getUTCMonth() + 1)}-${pad2(local.getUTCDate())}` +
      `T${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}`;
  }

  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function isoToUtcSql(value: string | null): string | undefined {
  return value ? value.slice(0, 19).replace("T", " ") : undefined;
}

export interface LocalDateRange {
  from?: string;
  to?: string;
}

/**
 * 把本地日期筛选边界转换成 UTC SQL 字符串。
 * 例如上海 2026-07-31 对应 UTC 2026-07-30 16:00:00 ~ 2026-07-31 15:59:59。
 */
export function localDateRangeToUtcSqlBounds(
  range: LocalDateRange,
  timezoneOffsetMinutes?: number,
): LocalDateRange {
  return {
    from: range.from
      ? isoToUtcSql(localDateTimeInputToUtcIso(`${range.from}T00:00:00`, timezoneOffsetMinutes))
      : undefined,
    to: range.to
      ? isoToUtcSql(localDateTimeInputToUtcIso(`${range.to}T23:59:59`, timezoneOffsetMinutes))
      : undefined,
  };
}

/** 解析后端时间并按当前应用语言格式化为本地时间字符串。 */
export function formatServerTime(
  ts: string | undefined | null,
  options?: Intl.DateTimeFormatOptions,
  fallback?: string,
): string {
  const date = parseServerTime(ts);
  if (!date) return fallback ?? ts ?? "";
  const locale = getAppLocale();
  return options ? date.toLocaleString(locale, options) : date.toLocaleString(locale);
}

/** 解析后端时间并按当前应用语言格式化为本地日期字符串。 */
export function formatServerDate(
  ts: string | undefined | null,
  options?: Intl.DateTimeFormatOptions,
): string {
  const date = parseServerTime(ts);
  if (!date) return ts ?? "";
  return date.toLocaleDateString(getAppLocale(), options);
}
