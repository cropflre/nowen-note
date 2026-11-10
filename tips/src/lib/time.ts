/**
 * 服务端时间解析 —— **全 App 只有这一份**。
 *
 * ⚠️ 服务端返回的时间是 **UTC**，格式 `"YYYY-MM-DD HH:MM:SS"`，**不带任何时区标记**。
 *    实测 `/api/notes` 新建后返回的 `createdAt` 就等于当下的 UTC 时间。
 *
 *    而 JS 的 `new Date("2026-10-07 08:31:30")` 会按**本地时间**解析
 *    （规范规定：无时区的 date-time 形式按本地时间处理）——
 *    东八区下所有时间都会偏 8 小时：**刚建好的笔记显示成「8 小时前」**。
 *    所以必须先补 `Z` 再交给 Date。
 *
 * 这个坑之所以能藏很久，是因为 mock 早期返回的是 `toISOString()`（带 Z），
 * 客户端不补 Z 也解析得对；换成真实后端才暴露。mock 现在已改成与真实一致的裸 UTC。
 *
 * 所有需要「服务端时间 → 展示」的地方都必须走这里，不要再各自 `new Date(...)`：
 * 同一份数据两套解析，必然错一套（说说那边补了 Z、笔记列表那边没补，就是实例）。
 */

const HAS_TZ = /Z$|[+-]\d{2}:?\d{2}$/;

/** 解析服务端时间；无法解析返回 null */
export function parseServerTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const normalized = HAS_TZ.test(raw) ? raw : `${raw.replace(" ", "T")}Z`;
  const d = new Date(normalized);
  return Number.isFinite(d.getTime()) ? d : null;
}

export const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * 相对时间：列表里最需要的信息是「多久以前」。
 *
 * ⚠️ 用 `Math.round` 而不是 `Math.floor` 算「天」：刚创建（now - then 可能因时钟
 * 微差为负）时会算出 -1 天，floor 会把「刚刚」显示成「-1 天前」。
 */
export function relativeTime(value: string): string {
  const d = parseServerTime(value);
  if (!d) return "";
  const diffMs = Date.now() - d.getTime();
  // 服务端与本机时钟可能有几秒偏差：未来 2 分钟内一律算「刚刚」
  if (diffMs < 120_000) return "刚刚";
  const min = Math.floor(diffMs / 60_000);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 分组键 = **本地**日期 "YYYY-MM-DD" */
export function localDateKey(value: string): string {
  const d = parseServerTime(value);
  if (!d) return value || "(未知时间)";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 分组标题：近三天说人话，更早给「月 日 周X」 */
export function dateGroupLabel(key: string): string {
  const d = parseServerTime(`${key} 00:00:00`);
  if (!d) return key;
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const thatStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((todayStart.getTime() - thatStart.getTime()) / 86_400_000);
  if (days === 0) return "今天";
  if (days === 1) return "昨天";
  if (days === 2) return "前天";
  if (days < 0) return `${d.getMonth() + 1} 月 ${d.getDate()} 日`; // 未来时间（补录填错）也别显示成负数
  const label = `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${WEEKDAYS[d.getDay()]}`;
  return d.getFullYear() === now.getFullYear() ? label : `${d.getFullYear()} 年 ${label}`;
}

/** 只要时分 —— 日期已经在分组标题上时用 */
export function timeOnly(value: string): string {
  const d = parseServerTime(value);
  if (!d) return value;
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 「M月D日」—— 任务截止日这种短标签用 */
export function shortDate(value: string): string {
  const d = parseServerTime(value);
  if (!d) return "";
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
