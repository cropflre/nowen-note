import i18n from "i18next";
import {
  DEFAULT_TIME_ZONE_PREFERENCE,
  getSystemTimeZone,
  getTimeZoneOffsetMinutesAt,
  normalizeTimeZonePreference,
} from "./timeZones";

/**
 * 统一时间解析、时区感知与本地输入转换工具。
 *
 * 数据契约：
 * - 后端数据库中的无时区 `YYYY-MM-DD HH:mm:ss` 一律表示 UTC；
 * - `datetime-local` 一律表示用户所选应用时区（默认跟随系统）的墙上时间；
 * - 发送到后端前必须转换为带 `Z` 的 ISO 8601；
 * - 展示或回填输入框时再由 UTC 转回应用时区下的墙上时间。
 */

export interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

let appTimeZonePreference: string = DEFAULT_TIME_ZONE_PREFERENCE;
const timeZoneListeners = new Set<() => void>();

export function setAppTimeZone(tz: string | null | undefined): string {
  const normalized = normalizeTimeZonePreference(tz, DEFAULT_TIME_ZONE_PREFERENCE);
  if (normalized !== appTimeZonePreference) {
    appTimeZonePreference = normalized;
    for (const listener of timeZoneListeners) {
      listener();
    }
  }
  return appTimeZonePreference;
}

export function getConfiguredTimeZone(): string {
  return appTimeZonePreference;
}

export function getEffectiveTimeZone(): string {
  return appTimeZonePreference === DEFAULT_TIME_ZONE_PREFERENCE
    ? getSystemTimeZone()
    : appTimeZonePreference;
}

export function subscribeAppTimeZone(listener: () => void): () => void {
  timeZoneListeners.add(listener);
  return () => {
    timeZoneListeners.delete(listener);
  };
}

function explicitConfiguredTimeZone(): string | undefined {
  return appTimeZonePreference === DEFAULT_TIME_ZONE_PREFERENCE
    ? undefined
    : appTimeZonePreference;
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
  const explicitTz = explicitConfiguredTimeZone();
  if (explicitTz) {
    const wallAsUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const initialOffset = getTimeZoneOffsetMinutesAt(wallAsUtc, explicitTz);
    return getTimeZoneOffsetMinutesAt(wallAsUtc + initialOffset * 60_000, explicitTz);
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

export function getAppTimeZoneParts(
  date: Date,
  timeZone?: string,
): LocalDateTimeParts {
  const targetZone = timeZone ?? explicitConfiguredTimeZone();
  if (!targetZone) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds(),
    };
  }
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: targetZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const map: Record<string, number> = {};
    for (const part of formatter.formatToParts(date)) {
      if (part.type !== "literal") map[part.type] = Number(part.value);
    }
    return {
      year: map.year,
      month: map.month,
      day: map.day,
      hour: map.hour === 24 ? 0 : map.hour,
      minute: map.minute,
      second: map.second,
    };
  } catch {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds(),
    };
  }
}

export function formatDateKeyInTimeZone(
  date: Date,
  timeZone?: string,
): string {
  const parts = getAppTimeZoneParts(date, timeZone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

/**
 * 返回 `Date.getTimezoneOffset()` 语义的偏移分钟数（`UTC - local`，东八区为 `-480`）。
 * 适用于 `task-reminders` 的 `timezoneOffsetMinutes` 参数。
 */
export function getEffectiveTimezoneOffsetMinutes(date = new Date()): number {
  const explicitTz = explicitConfiguredTimeZone();
  if (!explicitTz) {
    return date.getTimezoneOffset();
  }
  return getTimeZoneOffsetMinutesAt(date.getTime(), explicitTz);
}

/**
 * 返回 `-getTimezoneOffset()` 语义的偏移分钟数（`local - UTC`，东八区为 `+480`）。
 * 适用于 `journals` 的 `tzOffsetMinutes` 查询参数。
 */
export function getEffectiveTzOffsetForApi(date = new Date()): number {
  return -getEffectiveTimezoneOffsetMinutes(date) || 0;
}

function getAppLocale(): string | undefined {
  return i18n.resolvedLanguage || i18n.language || undefined;
}

function resolveDateInput(value: string | number | Date | undefined | null): Date | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return parseServerTime(value);
}

function mergeFormatOptions(options?: Intl.DateTimeFormatOptions): Intl.DateTimeFormatOptions | undefined {
  const tz = options?.timeZone ?? explicitConfiguredTimeZone();
  if (!tz) return options;
  return { ...options, timeZone: tz };
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

  const parts = getAppTimeZoneParts(date);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}` +
    `T${pad2(parts.hour)}:${pad2(parts.minute)}`;
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

/** 按当前应用语言与全局时区格式化时间字符串。 */
export function formatAppDateTime(
  value: string | number | Date | undefined | null,
  options?: Intl.DateTimeFormatOptions,
  fallback?: string,
  localeOverride?: Intl.LocalesArgument,
): string {
  const date = resolveDateInput(value);
  if (!date) return fallback ?? (typeof value === "string" ? value : "");
  const locale = localeOverride ?? getAppLocale();
  const merged = mergeFormatOptions(options);
  try {
    return merged ? date.toLocaleString(locale, merged) : date.toLocaleString(locale);
  } catch {
    return fallback ?? (typeof value === "string" ? value : date.toISOString());
  }
}

/** 按当前应用语言与全局时区格式化日期字符串。 */
export function formatAppDate(
  value: string | number | Date | undefined | null,
  options?: Intl.DateTimeFormatOptions,
  fallback?: string,
  localeOverride?: Intl.LocalesArgument,
): string {
  const date = resolveDateInput(value);
  if (!date) return fallback ?? (typeof value === "string" ? value : "");
  const locale = localeOverride ?? getAppLocale();
  const merged = mergeFormatOptions(options);
  try {
    return merged ? date.toLocaleDateString(locale, merged) : date.toLocaleDateString(locale);
  } catch {
    return fallback ?? (typeof value === "string" ? value : date.toISOString());
  }
}

/** 按当前应用语言与全局时区格式化时分秒字符串。 */
export function formatAppTime(
  value: string | number | Date | undefined | null,
  options?: Intl.DateTimeFormatOptions,
  fallback?: string,
  localeOverride?: Intl.LocalesArgument,
): string {
  const date = resolveDateInput(value);
  if (!date) return fallback ?? (typeof value === "string" ? value : "");
  const locale = localeOverride ?? getAppLocale();
  const merged = mergeFormatOptions(options);
  try {
    return merged ? date.toLocaleTimeString(locale, merged) : date.toLocaleTimeString(locale);
  } catch {
    return fallback ?? (typeof value === "string" ? value : date.toISOString());
  }
}

/** 解析后端时间并按当前应用语言与全局时区格式化为本地时间字符串。 */
export function formatServerTime(
  ts: string | undefined | null,
  options?: Intl.DateTimeFormatOptions,
  fallback?: string,
): string {
  return formatAppDateTime(ts, options, fallback);
}

/** 解析后端时间并按当前应用语言与全局时区格式化为本地日期字符串。 */
export function formatServerDate(
  ts: string | undefined | null,
  options?: Intl.DateTimeFormatOptions,
): string {
  return formatAppDate(ts, options);
}
