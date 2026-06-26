/**
 * 统一时间解析工具
 *
 * 后端 SQLite datetime('now') 返回 UTC 时间，格式 "YYYY-MM-DD HH:MM:SS"，
 * 无时区后缀。JavaScript new Date() 会将其解析为本地时间，导致时区偏移。
 *
 * 本模块统一处理：追加时区标记 → 按 UTC 解析 → 由 toLocaleString() 转本地显示。
 */

/**
 * 解析后端返回的时间字符串为 Date 对象。
 * - 已带时区后缀（Z / +08:00）→ 直接解析
 * - SQLite datetime 格式 "YYYY-MM-DD HH:MM:SS" → 转 ISO 格式追加 Z
 * - null / undefined / 非法值 → 返回 null
 */
export function parseServerTime(ts: string | undefined | null): Date | null {
  if (!ts || typeof ts !== "string") return null;
  const trimmed = ts.trim();
  if (!trimmed) return null;

  // 已带时区后缀，直接解析
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    const d = new Date(trimmed);
    return isNaN(d.getTime()) ? null : d;
  }

  // SQLite datetime 格式 "YYYY-MM-DD HH:MM:SS" → ISO 格式
  const iso = trimmed.replace(" ", "T") + "Z";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * 解析后端时间并格式化为本地时间字符串。
 * 失败时返回 fallback（默认原字符串）。
 */
export function formatServerTime(
  ts: string | undefined | null,
  options?: Intl.DateTimeFormatOptions,
  fallback?: string,
): string {
  const d = parseServerTime(ts);
  if (!d) return fallback ?? ts ?? "";
  return options ? d.toLocaleString(undefined, options) : d.toLocaleString();
}

/**
 * 解析后端时间并格式化为本地日期字符串（仅日期部分）。
 */
export function formatServerDate(
  ts: string | undefined | null,
  options?: Intl.DateTimeFormatOptions,
): string {
  const d = parseServerTime(ts);
  if (!d) return ts ?? "";
  return d.toLocaleDateString(undefined, options);
}
