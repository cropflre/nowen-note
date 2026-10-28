import bundled2026 from "../../public/holidays/cn-2026.json?raw";

const HOLIDAY_NAMES = ["newYear", "springFestival", "qingming", "labourDay", "dragonBoat", "midAutumn", "nationalDay"] as const;
export interface HolidayDay {
  type: "holiday" | "makeup-workday";
  name: typeof HOLIDAY_NAMES[number];
}
export interface HolidayYear {
  schemaVersion: 1;
  region: "CN";
  year: number;
  revision: number;
  sourceUrl: string;
  days: Record<string, HolidayDay>;
}

export const HOLIDAY_MAX_BYTES = 64 * 1024;
// Public data only. Never send the application's API token or accept arbitrary URLs.
export const HOLIDAY_UPDATE_BASE = "https://raw.githubusercontent.com/cropflre/nowen-note/main/frontend/public/holidays/";

export function isHolidayYear(year: number): boolean {
  return Number.isInteger(year) && year >= 2000 && year <= 2199;
}

/** Date-only keys stay independent of time zones and task scheduling. */
export function isHolidayDateKey(key: string, year: number): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || Number(key.slice(0, 4)) !== year) return false;
  const month = Number(key.slice(5, 7));
  const day = Number(key.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= lengths[month - 1];
}

export function parseHolidayYear(text: string, year: number): HolidayYear {
  if (!isHolidayYear(year) || new TextEncoder().encode(text).length > HOLIDAY_MAX_BYTES) throw new Error("Invalid holiday data");
  const data = JSON.parse(text);
  if (!data || data.schemaVersion !== 1 || data.region !== "CN" || data.year !== year
    || !Number.isSafeInteger(data.revision) || data.revision < 1
    || typeof data.sourceUrl !== "string" || data.sourceUrl.length > 2048
    || !data.days || typeof data.days !== "object" || Array.isArray(data.days)) throw new Error("Invalid holiday data");
  const source = new URL(data.sourceUrl);
  if (source.protocol !== "https:" || !source.hostname.endsWith(".gov.cn")
    || source.username || source.password || source.port) throw new Error("Invalid holiday source");
  const entries = Object.entries(data.days);
  if (!entries.length || entries.length > 366) throw new Error("Invalid holiday dates");
  for (const [key, value] of entries) {
    const day = value as HolidayDay | null;
    if (!isHolidayDateKey(key, year) || !day || typeof day !== "object"
      || !["holiday", "makeup-workday"].includes(day.type)
      || !HOLIDAY_NAMES.includes(day.name)) throw new Error("Invalid holiday date");
  }
  return data as HolidayYear;
}

export const BUNDLED_HOLIDAY_YEARS: Readonly<Record<number, HolidayYear>> = {
  2026: parseHolidayYear(bundled2026, 2026),
};

export function getHolidayDay(dateKey: string, years: Readonly<Record<number, HolidayYear>>): HolidayDay | undefined {
  const year = Number(dateKey.slice(0, 4));
  return isHolidayDateKey(dateKey, year) ? years[year]?.days[dateKey] : undefined;
}
