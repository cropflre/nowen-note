const SQL_DATE_TIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/;

function isValidUtcSql(value: string): boolean {
  const match = value.match(SQL_DATE_TIME);
  if (!match) return false;
  const iso = `${match[1]}T${match[2]}:${match[3] || "00"}Z`;
  const date = new Date(iso);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 19) === iso.slice(0, 19);
}

/**
 * 把 API 时间输入规范化为 SQLite UTC 字符串。
 * 无时区的 SQL / ISO 字符串按 UTC 解释；带 Z 或 offset 的输入转换为 UTC。
 */
export function normalizeUtcInputToSql(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const value = raw.trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const normalized = `${value} 00:00:00`;
    return isValidUtcSql(normalized) ? normalized : null;
  }

  if (SQL_DATE_TIME.test(value)) {
    const match = value.match(SQL_DATE_TIME)!;
    const normalized = `${match[1]} ${match[2]}:${match[3] || "00"}`;
    return isValidUtcSql(normalized) ? normalized : null;
  }

  if (/Z$|[+-]\d{2}:?\d{2}$/.test(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? null
      : date.toISOString().slice(0, 19).replace("T", " ");
  }

  return null;
}

/** 规范化时间筛选边界；date-only 仍按 UTC 日期兼容旧客户端。 */
export function normalizeUtcDateBound(
  raw: string | undefined,
  kind: "from" | "to",
): string | null {
  if (!raw?.trim()) return null;
  const value = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const normalized = `${value} ${kind === "from" ? "00:00:00" : "23:59:59"}`;
    return isValidUtcSql(normalized) ? normalized : null;
  }
  return normalizeUtcInputToSql(value);
}

/** 把数据库 UTC SQL 时间输出为带 Z 的 ISO 8601，避免导出软件按本地时间误读。 */
export function formatSqlUtcAsIso(value: string): string {
  const normalized = normalizeUtcInputToSql(value);
  if (!normalized) return value;
  return new Date(`${normalized.replace(" ", "T")}Z`).toISOString();
}
