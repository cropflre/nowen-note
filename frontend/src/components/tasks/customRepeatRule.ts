export type CustomRepeatCalendar = "gregorian" | "lunar";
export type CustomRepeatFrequency = "day" | "week" | "month" | "year";

export interface CustomRepeatRule {
  calendar: CustomRepeatCalendar;
  frequency: CustomRepeatFrequency;
  interval: number;
  weekdays?: number[];
  monthDay?: number;
  yearMonth?: number;
  yearDay?: number;
  lunarMonth?: number;
  lunarDay?: number;
}

export interface CustomRepeatRuleDraft {
  calendar: CustomRepeatCalendar;
  frequency: CustomRepeatFrequency;
  interval: number;
  weekdays: number[];
  monthDay: number;
  yearMonth: number;
  yearDay: number;
  lunarMonth: number;
  lunarDay: number;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function normalizeWeekdays(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .map((item) => Number(item))
      .filter((item) => Number.isInteger(item) && item >= 0 && item <= 6),
  )].sort((a, b) => a - b);
}

function parseRawRule(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function parseStoredCustomRepeatRule(
  value: unknown,
  now = new Date(),
): CustomRepeatRuleDraft {
  const raw = parseRawRule(value);
  const calendar: CustomRepeatCalendar = raw.calendar === "lunar" ? "lunar" : "gregorian";
  const frequency: CustomRepeatFrequency =
    raw.frequency === "week" || raw.frequency === "month" || raw.frequency === "year"
      ? raw.frequency
      : "day";

  return {
    calendar,
    frequency: calendar === "lunar" ? "year" : frequency,
    interval: clampInteger(raw.interval, 1, 999, 2),
    weekdays: normalizeWeekdays(raw.weekdays),
    monthDay: clampInteger(raw.monthDay, 1, 31, now.getDate()),
    yearMonth: clampInteger(raw.yearMonth, 1, 12, now.getMonth() + 1),
    yearDay: clampInteger(raw.yearDay, 1, 31, now.getDate()),
    lunarMonth: clampInteger(raw.lunarMonth, 1, 12, 1),
    lunarDay: clampInteger(raw.lunarDay, 1, 30, 1),
  };
}

/**
 * Builds the exact request rule from the last rendered draft plus the value from
 * the current input event. Passing overrides is important: React state setters are
 * asynchronous, so reading state immediately after setState would submit the old value.
 */
export function buildCustomRepeatRule(
  draft: CustomRepeatRuleDraft,
  overrides: Partial<CustomRepeatRuleDraft> = {},
): CustomRepeatRule {
  const next: CustomRepeatRuleDraft = {
    ...draft,
    ...overrides,
    weekdays: overrides.weekdays !== undefined
      ? normalizeWeekdays(overrides.weekdays)
      : normalizeWeekdays(draft.weekdays),
  };
  const interval = clampInteger(next.interval, 1, 999, 1);

  if (next.calendar === "lunar") {
    return {
      calendar: "lunar",
      frequency: "year",
      interval,
      lunarMonth: clampInteger(next.lunarMonth, 1, 12, 1),
      lunarDay: clampInteger(next.lunarDay, 1, 30, 1),
    };
  }

  const base: CustomRepeatRule = {
    calendar: "gregorian",
    frequency: next.frequency,
    interval,
  };

  if (next.frequency === "week") {
    const weekdays = normalizeWeekdays(next.weekdays);
    if (weekdays.length > 0) base.weekdays = weekdays;
  } else if (next.frequency === "month") {
    base.monthDay = clampInteger(next.monthDay, 1, 31, 1);
  } else if (next.frequency === "year") {
    base.yearMonth = clampInteger(next.yearMonth, 1, 12, 1);
    base.yearDay = clampInteger(next.yearDay, 1, 31, 1);
  }

  return base;
}

export function serializeCustomRepeatRule(rule: CustomRepeatRule): string {
  return JSON.stringify(rule);
}

export function parseRepeatRuleRequestValue(value: unknown): CustomRepeatRule | null | unknown {
  if (value === null || value === undefined || typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}
