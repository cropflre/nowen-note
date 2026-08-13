import type { Task } from "@/types";

type DayPeriod = "早上" | "上午" | "中午" | "下午" | "傍晚" | "晚上" | "morning" | "afternoon" | "evening" | "tonight" | "noon";

type MatchRange = {
    start: number;
    end: number;
};

export type TaskQuickAddRecognizedRange = MatchRange;

type TimeSpec = {
    hour: number;
    minute: number;
    range: MatchRange;
};

type TimeRuleCandidate = TimeSpec & { priority: number };

type TimeRuleContext = {
    text: string;
    protectedRanges: MatchRange[];
};

type TimeRuleDefinition = {
    name: string;
    collect: (ctx: TimeRuleContext) => TimeRuleCandidate[];
};

type DateSpec = {
    date: Date;
    range: MatchRange;
};

type DateRuleContext = {
    text: string;
    now: Date;
    timeSpec: TimeSpec | null;
    protectedRanges: MatchRange[];
};

type DateRuleDefinition = {
    name: string;
    collect: (ctx: DateRuleContext) => DateSpec[];
};

type RepeatSpec = {
    patch: Partial<Task>;
    anchorDate: Date;
    range: MatchRange;
};

type RepeatRuleCandidate = RepeatSpec & { priority: number };

type RepeatRuleContext = {
    text: string;
    now: Date;
    timeSpec: TimeSpec | null;
    protectedRanges: MatchRange[];
};

type RepeatRuleDefinition = {
    name: string;
    collect: (ctx: RepeatRuleContext) => RepeatRuleCandidate[];
};

type ReminderRuleContext = {
    text: string;
    protectedRanges: MatchRange[];
};

type AdvanceSpec = {
    offsetMinutes: number;
    range: MatchRange;
};

type AdvanceRuleCandidate = AdvanceSpec & { priority: number };

type AdvanceRuleDefinition = {
    name: string;
    collect: (ctx: ReminderRuleContext) => AdvanceRuleCandidate[];
};

type DueReminderSpec = {
    range: MatchRange;
};

type DueReminderRuleDefinition = {
    name: string;
    collect: (ctx: ReminderRuleContext) => DueReminderSpec[];
};

type DelayedReminderSpec = {
    dueAt: Date;
    range: MatchRange;
};

type DelayedDurationParts = {
    years?: number;
    months?: number;
    weeks?: number;
    days?: number;
    hours?: number;
    minutes?: number;
};

export type TaskQuickAddParseResult = {
    cleanTitle: string;
    taskPatch: Partial<Task>;
    reminderOffsets: number[];
    recognizedRanges: TaskQuickAddRecognizedRange[];
};

const DAY_PERIOD_TIME: Record<DayPeriod, [number, number]> = {
    早上: [7, 0],
    上午: [9, 0],
    中午: [12, 0],
    下午: [13, 0],
    傍晚: [17, 0],
    晚上: [20, 0],
    morning: [9, 0],
    afternoon: [13, 0],
    evening: [18, 0],
    tonight: [20, 0],
    noon: [12, 0],
};

const WEEKDAY_MAP: Record<string, number> = {
    日: 0,
    天: 0,
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
};

const EN_WEEKDAY_MAP: Record<string, number> = {
    sunday: 0,
    sun: 0,
    monday: 1,
    mon: 1,
    tuesday: 2,
    tue: 2,
    tues: 2,
    wednesday: 3,
    wed: 3,
    thursday: 4,
    thu: 4,
    thur: 4,
    thurs: 4,
    friday: 5,
    fri: 5,
    saturday: 6,
    sat: 6,
};

const EN_MONTH_MAP: Record<string, number> = {
    january: 1,
    jan: 1,
    february: 2,
    feb: 2,
    march: 3,
    mar: 3,
    april: 4,
    apr: 4,
    may: 5,
    june: 6,
    jun: 6,
    july: 7,
    jul: 7,
    august: 8,
    aug: 8,
    september: 9,
    sept: 9,
    sep: 9,
    october: 10,
    oct: 10,
    november: 11,
    nov: 11,
    december: 12,
    dec: 12,
};

const EN_MONTH_NAME_PATTERN = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

const MAX_REPEAT_INTERVAL = 999;
const MAX_ADVANCE_MINUTES = 60 * 24 * 365;
// Date-only tasks keep their all-day deadline semantics. "提醒我" uses an
// offset from next local midnight instead of fabricating a dueAt at 08:30.
const DEFAULT_DATE_ONLY_REMINDER_OFFSET_MINUTES = 15 * 60 + 30;

export function parseTaskQuickAdd(input: string, now = new Date()): TaskQuickAddParseResult {
    const raw = input || "";
    if (!raw.trim()) {
        return { cleanTitle: "", taskPatch: {}, reminderOffsets: [], recognizedRanges: [] };
    }

    const protectedRanges = findProtectedRanges(raw);
    const consumedRanges: MatchRange[] = [];
    const timeSpec = parseTimeSpec(raw, protectedRanges);
    let parsedDateSpec = parseDateSpec(raw, now, timeSpec || null, protectedRanges);

    const repeatSpec = parseRepeatSpec(raw, now, timeSpec || null, protectedRanges);
    if (repeatSpec) consumedRanges.push(repeatSpec.range);
    if (parsedDateSpec && repeatSpec && rangesOverlap(parsedDateSpec.range, repeatSpec.range)) {
        parsedDateSpec = null;
    }

    let scheduledDate: Date | null = null;
    if (parsedDateSpec) {
        scheduledDate = parsedDateSpec.date;
        consumedRanges.push(parsedDateSpec.range);
    } else if (repeatSpec) {
        scheduledDate = repeatSpec.anchorDate;
    }

    let dueDate: string | null = null;
    let dueAt: string | null = null;

    if (timeSpec && scheduledDate) {
        const dt = new Date(
            scheduledDate.getFullYear(),
            scheduledDate.getMonth(),
            scheduledDate.getDate(),
            timeSpec.hour,
            timeSpec.minute,
            0,
            0,
        );
        dueDate = formatDateKey(dt);
        dueAt = formatDueAt(dt);
        consumedRanges.push(timeSpec.range);
    } else if (scheduledDate) {
        dueDate = formatDateKey(scheduledDate);
    } else if (timeSpec) {
        const dt = resolveTimeOnly(now, timeSpec.hour, timeSpec.minute);
        dueDate = formatDateKey(dt);
        dueAt = formatDueAt(dt);
        consumedRanges.push(timeSpec.range);
    }

    const taskPatch: Partial<Task> = {};
    if (dueDate) taskPatch.dueDate = dueDate;
    if (dueAt) taskPatch.dueAt = dueAt;

    if (repeatSpec) {
        Object.assign(taskPatch, repeatSpec.patch);
        if (!taskPatch.dueDate) {
            taskPatch.dueDate = formatDateKey(repeatSpec.anchorDate);
            if (!taskPatch.dueAt && timeSpec) {
                const dt = new Date(
                    repeatSpec.anchorDate.getFullYear(),
                    repeatSpec.anchorDate.getMonth(),
                    repeatSpec.anchorDate.getDate(),
                    timeSpec.hour,
                    timeSpec.minute,
                    0,
                    0,
                );
                taskPatch.dueAt = formatDueAt(dt);
            }
        }
    }

    const advanceSpec = parseAdvanceSpec(raw, protectedRanges);
    const dueReminderSpec = parseDueReminderSpec(raw, protectedRanges);
    const delayedReminderSpec = parseDelayedReminderSpec(raw, now, protectedRanges);
    const reminderOffsets: number[] = [];
    if (delayedReminderSpec && !taskPatch.dueDate && !taskPatch.dueAt && !repeatSpec && !parsedDateSpec && !timeSpec) {
        taskPatch.dueDate = formatDateKey(delayedReminderSpec.dueAt);
        taskPatch.dueAt = formatDueAt(delayedReminderSpec.dueAt);
        reminderOffsets.push(0);
        consumedRanges.push(delayedReminderSpec.range);
        if (dueReminderSpec) consumedRanges.push(dueReminderSpec.range);
    } else if (advanceSpec && taskPatch.dueAt) {
        reminderOffsets.push(0, advanceSpec.offsetMinutes);
        consumedRanges.push(advanceSpec.range);
        if (dueReminderSpec) consumedRanges.push(dueReminderSpec.range);
    } else if (dueReminderSpec && (taskPatch.dueDate || taskPatch.dueAt)) {
        reminderOffsets.push(taskPatch.dueAt ? 0 : DEFAULT_DATE_ONLY_REMINDER_OFFSET_MINUTES);
        consumedRanges.push(dueReminderSpec.range);
    }
    if (hasFutureDueAt(taskPatch, now) && reminderOffsets.length === 0) {
        reminderOffsets.push(0);
    }

    const cleanTitle = cleanupTitle(removeRanges(raw, consumedRanges));

    return {
        cleanTitle,
        taskPatch,
        reminderOffsets: sortUniqueOffsets(reminderOffsets),
        recognizedRanges: mergeRanges(consumedRanges),
    };
}

function hasFutureDueAt(taskPatch: Partial<Task>, now: Date): boolean {
    return !!taskPatch.dueAt && new Date(taskPatch.dueAt).getTime() > now.getTime();
}

function parseTimeSpec(text: string, protectedRanges: MatchRange[]): TimeSpec | null {
    const selected = selectTimeCandidate(TIME_RULES.flatMap((rule) => rule.collect({ text, protectedRanges })));
    if (!selected) return null;
    const { priority: _priority, ...result } = selected;
    return result;
}

const TIME_RULES: TimeRuleDefinition[] = [
    timeRule("meridiem", /\b(?:at\s*)?(\d{1,2})(?:\s*[:：]\s*([0-5]\d)(?:\s*[:：]\s*([0-5]\d))?)?\s*(a\.?m\.?|p\.?m\.?)\b/gi, 1, (m, _ctx, range) => {
        const rawHour = Number(m[1]);
        const minute = m[2] ? Number(m[2]) : 0;
        if (!Number.isInteger(rawHour) || rawHour < 1 || rawHour > 12) return null;
        let hour = rawHour % 12;
        if (m[4].toLowerCase().startsWith("p")) hour += 12;
        return { hour, minute, range };
    }),
    timeRule("clock", /(?:(早上|上午|中午|下午|傍晚|晚上)\s*)?(\d{1,2})\s*[:：]\s*([0-5]\d)(?:\s*[:：]\s*([0-5]\d))?/g, 1, (m, ctx, range) => {
        const prevChar = m.index > 0 ? ctx.text[m.index - 1] : "";
        const nextChar = range.end < ctx.text.length ? ctx.text[range.end] : "";
        if (/[\d/:：-]/.test(prevChar) || /\d/.test(nextChar)) return null;
        const rawHour = Number(m[2]);
        const minute = Number(m[3]);
        if (!Number.isInteger(rawHour) || rawHour < 0 || rawHour > 23) return null;
        const hour = applyPeriodToHour(rawHour, (m[1] || null) as DayPeriod | null);
        return hour < 0 || hour > 23 ? null : { hour, minute, range };
    }),
    timeRule("zhPoint", /(?:(早上|上午|中午|下午|傍晚|晚上)\s*)?(\d{1,2})\s*点(?:\s*(半))?/g, 1, (m, _ctx, range) => {
        const rawHour = Number(m[2]);
        if (!Number.isInteger(rawHour) || rawHour < 0 || rawHour > 23) return null;
        const hour = applyPeriodToHour(rawHour, (m[1] || null) as DayPeriod | null);
        return hour < 0 || hour > 23 ? null : { hour, minute: m[3] ? 30 : 0, range };
    }),
    timeRule("period", /(早上|上午|中午|下午|傍晚|晚上)|\b(?:in the\s+)?(morning|afternoon|evening|tonight|noon)\b/gi, 20, (m, ctx, range) => {
        if (m[1] && !hasZhRightBoundary(ctx.text, range.end, { allowDigit: true })) return null;
        const period = (m[1] || m[2].toLowerCase()) as DayPeriod;
        const [hour, minute] = DAY_PERIOD_TIME[period];
        return { hour, minute, range };
    }),
];

function timeRule(
    name: string,
    pattern: RegExp,
    priority: number,
    build: (match: RegExpExecArray, ctx: TimeRuleContext, range: MatchRange) => TimeSpec | null,
): TimeRuleDefinition {
    return {
        name,
        collect: (ctx) => {
            const candidates: TimeRuleCandidate[] = [];
            pattern.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(ctx.text)) !== null) {
                const range = { start: match.index, end: match.index + match[0].length };
                if (!isProtectedRange(range, ctx.protectedRanges)) {
                    const spec = build(match, ctx, range);
                    if (spec) candidates.push({ ...spec, priority });
                }
                if (!pattern.global) break;
            }
            return candidates;
        },
    };
}

function selectTimeCandidate(candidates: TimeRuleCandidate[]): TimeRuleCandidate | null {
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        if (a.range.start !== b.range.start) return a.range.start - b.range.start;
        return (b.range.end - b.range.start) - (a.range.end - a.range.start);
    });
    return candidates[0];
}

function parseDateSpec(text: string, now: Date, timeSpec: TimeSpec | null, protectedRanges: MatchRange[]): DateSpec | null {
    return selectDateCandidate(DATE_RULES.flatMap((rule) => rule.collect({ text, now, timeSpec, protectedRanges })));
}

const DATE_RULES: DateRuleDefinition[] = [
    dateRule("monthDayZh", /(\d{1,2})月(\d{1,2})日/g, (m, ctx) => resolveNearestMonthDay(ctx.now, Number(m[1]), Number(m[2]), ctx.timeSpec)),
    dateRule("monthDayCompact", /(\d{1,2})[\.\/-](\d{1,2})(?!\d)/g, (m, ctx, range) => {
        const prevChar = m.index > 0 ? ctx.text[m.index - 1] : "";
        const nextChar = range.end < ctx.text.length ? ctx.text[range.end] : "";
        if (/[\dA-Za-z_.:/-]/.test(prevChar) || /[\d.\/:：-]/.test(nextChar)) return null;
        return resolveNearestMonthDay(ctx.now, Number(m[1]), Number(m[2]), ctx.timeSpec);
    }),
    dateRule("monthNameDayEn", new RegExp(`\\b(${EN_MONTH_NAME_PATTERN})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?(?=\\s|$|[,，。.;；])`, "gi"), (m, ctx) => {
        const year = m[3] ? Number(m[3]) : null;
        return resolveEnglishMonthDay(ctx.now, parseEnglishMonth(m[1]), Number(m[2]), year, ctx.timeSpec);
    }),
    dateRule("dayMonthNameEn", new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${EN_MONTH_NAME_PATTERN})\\.?(?:,?\\s+(\\d{4}))?(?=\\s|$|[,，。.;；])`, "gi"), (m, ctx) => {
        const year = m[3] ? Number(m[3]) : null;
        return resolveEnglishMonthDay(ctx.now, parseEnglishMonth(m[2]), Number(m[1]), year, ctx.timeSpec);
    }),
    dateRule("relativeZh", /(今天|明天|后天)/g, (m, ctx, range) => {
        if (!hasZhRightBoundary(ctx.text, range.end, { allowDigit: true, allowPeriodWord: true })) return null;
        let offset = 0;
        if (m[1] === "明天") offset = 1;
        if (m[1] === "后天") offset = 2;
        return addDays(startOfDay(ctx.now), offset);
    }),
    dateRule("relativeEn", /\b(day\s+after\s+tomorrow|tomorrow|today)\b/gi, (m, ctx) => {
        const key = m[1].toLowerCase().replace(/\s+/g, " ");
        let offset = 0;
        if (key === "tomorrow") offset = 1;
        if (key === "day after tomorrow") offset = 2;
        return addDays(startOfDay(ctx.now), offset);
    }),
    dateRule("weekdayZh", /(?:周|星期)([一二三四五六日天])/g, (m, ctx, range) => {
        if (!hasZhRightBoundary(ctx.text, range.end, { allowDigit: true, allowPeriodWord: true })) return null;
        const day = WEEKDAY_MAP[m[1]];
        return day === undefined ? null : resolveNearestWeekday(ctx.now, day, ctx.timeSpec);
    }),
    dateRule("weekdayEn", /\b(?:(next|this)\s+)?(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday|rday)?|fri(?:day)?|sat(?:urday)?)\.?(?=\s|$|[,，。.;；])/gi, (m, ctx) => {
        const day = EN_WEEKDAY_MAP[m[2].toLowerCase()];
        if (day === undefined) return null;
        return (m[1] || "").toLowerCase() === "next"
            ? resolveNextWeekday(ctx.now, day, ctx.timeSpec)
            : resolveNearestWeekday(ctx.now, day, ctx.timeSpec);
    }),
    dateRule("monthOnlyZh", /(\d{1,2})月(?!\s*\d{1,2}日)/g, (m, ctx, range) => {
        if (/每\s*$/.test(ctx.text.slice(0, m.index))) return null;
        if (!hasZhRightBoundary(ctx.text, range.end)) return null;
        return resolveNearestMonthDay(ctx.now, Number(m[1]), 1, ctx.timeSpec);
    }),
    dateRule("monthOnlyEn", new RegExp(`\\bin\\s+(${EN_MONTH_NAME_PATTERN})\\.?(?=\\s|$|[,，。.;；])`, "gi"), (m, ctx) => resolveNearestMonthDay(ctx.now, parseEnglishMonth(m[1]), 1, ctx.timeSpec)),
];

function dateRule(
    name: string,
    pattern: RegExp,
    resolveDate: (match: RegExpExecArray, ctx: DateRuleContext, range: MatchRange) => Date | null,
): DateRuleDefinition {
    return {
        name,
        collect: (ctx) => {
            const candidates: DateSpec[] = [];
            pattern.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(ctx.text)) !== null) {
                const range = { start: match.index, end: match.index + match[0].length };
                if (!isProtectedRange(range, ctx.protectedRanges)) {
                    const date = resolveDate(match, ctx, range);
                    if (date) candidates.push({ date, range });
                }
                if (!pattern.global) break;
            }
            return candidates;
        },
    };
}

function selectDateCandidate(candidates: DateSpec[]): DateSpec | null {
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
        if (a.range.start !== b.range.start) return a.range.start - b.range.start;
        return (b.range.end - b.range.start) - (a.range.end - a.range.start);
    });
    return candidates[0];
}

function parseRepeatSpec(text: string, now: Date, timeSpec: TimeSpec | null, protectedRanges: MatchRange[]): RepeatSpec | null {
    const ctx: RepeatRuleContext = { text, now, timeSpec, protectedRanges };
    const selected = selectRepeatCandidate(REPEAT_RULES.flatMap((rule) => rule.collect(ctx)));
    if (!selected) return null;
    const { priority: _priority, ...result } = selected;
    return result;
}

const REPEAT_RULES: RepeatRuleDefinition[] = [
    repeatRule("workdayZh", /每个工作日/g, 1, (m, ctx) => repeatCandidate(
        m,
        ctx,
        1,
        "custom",
        1,
        weeklyCustomJson([1, 2, 3, 4, 5]),
        resolveNearestFromSet(ctx.now, [1, 2, 3, 4, 5], ctx.timeSpec),
    )),
    repeatRule("workdayEn", /\bevery\s+weekday\b/gi, 1, (m, ctx) => repeatCandidate(
        m,
        ctx,
        1,
        "custom",
        1,
        weeklyCustomJson([1, 2, 3, 4, 5]),
        resolveNearestFromSet(ctx.now, [1, 2, 3, 4, 5], ctx.timeSpec),
    )),
    repeatRule("weekendZh", /每周末重复/g, 2, (m, ctx) => repeatCandidate(
        m,
        ctx,
        2,
        "custom",
        1,
        weeklyCustomJson([0, 6]),
        resolveNearestFromSet(ctx.now, [0, 6], ctx.timeSpec),
    )),
    repeatRule("weekendEn", /\bevery\s+weekend\b/gi, 2, (m, ctx) => repeatCandidate(
        m,
        ctx,
        2,
        "custom",
        1,
        weeklyCustomJson([0, 6]),
        resolveNearestFromSet(ctx.now, [0, 6], ctx.timeSpec),
    )),
    repeatRule("yearlyMonthDayZh", /每年\s*(\d{1,2})月\s*(\d{1,2})日/g, 3, (m, ctx) => {
        if (!hasZhRightBoundary(ctx.text, m.index + m[0].length, { allowDigit: true, allowPeriodWord: true })) return null;
        const anchorDate = resolveNearestMonthDay(ctx.now, Number(m[1]), Number(m[2]), ctx.timeSpec);
        return anchorDate ? repeatCandidate(m, ctx, 3, "yearly", 1, null, anchorDate) : null;
    }),
    repeatRule("yearlyMonthZh", /每年\s*(\d{1,2})月/g, 4, (m, ctx) => {
        if (!hasZhRightBoundary(ctx.text, m.index + m[0].length, { allowDigit: true, allowPeriodWord: true })) return null;
        const anchorDate = resolveNearestMonthDay(ctx.now, Number(m[1]), 1, ctx.timeSpec);
        return anchorDate ? repeatCandidate(m, ctx, 4, "yearly", 1, null, anchorDate) : null;
    }),
    repeatRule("monthlyNthDayZh", /每月第\s*(\d{1,2})\s*天/g, 5, (m, ctx) => {
        if (!hasZhRightBoundary(ctx.text, m.index + m[0].length, { allowDigit: true, allowPeriodWord: true })) return null;
        const anchorDate = resolveNearestMonthlyDay(ctx.now, Number(m[1]));
        return anchorDate ? repeatCandidate(m, ctx, 5, "monthly", 1, null, anchorDate) : null;
    }),
    repeatRule("monthlyDayZh", /每月\s*(\d{1,2})\s*日/g, 5, (m, ctx) => {
        if (!hasZhRightBoundary(ctx.text, m.index + m[0].length, { allowDigit: true, allowPeriodWord: true })) return null;
        const anchorDate = resolveNearestMonthlyDay(ctx.now, Number(m[1]));
        return anchorDate ? repeatCandidate(m, ctx, 5, "monthly", 1, null, anchorDate) : null;
    }),
    repeatRule("monthlyLastDayZh", /每月最后\s*(?:1|一)?天/g, 5, (m, ctx) => repeatCandidate(
        m,
        ctx,
        5,
        "custom",
        1,
        monthlyLastDayCustomJson(),
        resolveNearestMonthLastDay(ctx.now, ctx.timeSpec),
    )),
    intervalRepeatRule("everyNDaysZh", /每\s*(\d+)\s*天/g, 6, "daily", "day"),
    intervalRepeatRule("everyNDaysEn", /\bevery\s+(\d+)\s+days?\b/gi, 6, "daily", "day"),
    intervalRepeatRule("everyNWeeksZh", /每\s*(\d+)\s*周/g, 7, "weekly", "week"),
    intervalRepeatRule("everyNWeeksEn", /\bevery\s+(\d+)\s+weeks?\b/gi, 7, "weekly", "week"),
    intervalRepeatRule("everyNMonthsZh", /每\s*(\d+)\s*月/g, 8, "monthly", "month"),
    intervalRepeatRule("everyNMonthsEn", /\bevery\s+(\d+)\s+months?\b/gi, 8, "monthly", "month"),
    repeatRule("dailyZh", /每天/g, 9, (m, ctx) => repeatCandidate(
        m,
        ctx,
        9,
        "daily",
        1,
        null,
        resolveIntervalAnchorDate(ctx.now, ctx.timeSpec, 1, "day"),
    )),
    repeatRule("dailyEn", /\b(?:daily|every\s+day)\b/gi, 9, (m, ctx) => repeatCandidate(
        m,
        ctx,
        9,
        "daily",
        1,
        null,
        resolveIntervalAnchorDate(ctx.now, ctx.timeSpec, 1, "day"),
    )),
    repeatRule("weeklyWeekdayZh", /每(?:周|星期)([一二三四五六日天])/g, 10, (m, ctx) => {
        if (!hasZhRightBoundary(ctx.text, m.index + m[0].length, { allowDigit: true, allowPeriodWord: true })) return null;
        const day = WEEKDAY_MAP[m[1]];
        return day === undefined ? null : repeatCandidate(m, ctx, 10, "weekly", 1, null, resolveNearestWeekday(ctx.now, day, ctx.timeSpec));
    }),
    repeatRule("weeklyZh", /每周(?!末)/g, 10, (m, ctx) => {
        if (!hasZhRightBoundary(ctx.text, m.index + m[0].length, { allowDigit: true, allowPeriodWord: true })) return null;
        return repeatCandidate(
            m,
            ctx,
            10,
            "weekly",
            1,
            null,
            resolveNearestWeekday(ctx.now, 1, ctx.timeSpec),
        );
    }),
    repeatRule("weeklyEn", /\b(?:weekly|every\s+week)\b/gi, 10, (m, ctx) => repeatCandidate(
        m,
        ctx,
        10,
        "weekly",
        1,
        null,
        resolveNearestWeekday(ctx.now, 1, ctx.timeSpec),
    )),
];

function repeatRule(
    name: string,
    pattern: RegExp,
    priority: number,
    build: (match: RegExpExecArray, ctx: RepeatRuleContext) => RepeatRuleCandidate | null,
): RepeatRuleDefinition {
    return {
        name,
        collect: (ctx) => {
            const candidates: RepeatRuleCandidate[] = [];
            pattern.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(ctx.text)) !== null) {
                const candidate = build(match, ctx);
                if (candidate) candidates.push(candidate);
                if (!pattern.global) break;
            }
            return candidates.map((candidate) => ({ ...candidate, priority: candidate.priority ?? priority }));
        },
    };
}

function intervalRepeatRule(
    name: string,
    pattern: RegExp,
    priority: number,
    repeatRuleName: Extract<NonNullable<Task["repeatRule"]>, "daily" | "weekly" | "monthly">,
    unit: "day" | "week" | "month",
): RepeatRuleDefinition {
    return repeatRule(name, pattern, priority, (m, ctx) => {
        if (name.endsWith("Zh") && !hasZhRightBoundary(ctx.text, m.index + m[0].length, { allowDigit: true, allowPeriodWord: true })) return null;
        const interval = clampInterval(Number(m[1]));
        return repeatCandidate(
            m,
            ctx,
            priority,
            repeatRuleName,
            interval,
            null,
            resolveIntervalAnchorDate(ctx.now, ctx.timeSpec, interval, unit),
        );
    });
}

function repeatCandidate(
    match: RegExpExecArray,
    ctx: RepeatRuleContext,
    priority: number,
    repeatRuleName: Exclude<NonNullable<Task["repeatRule"]>, "none">,
    repeatInterval: number,
    repeatRuleJson: string | null,
    anchorDate: Date,
): RepeatRuleCandidate | null {
    const range = { start: match.index, end: match.index + match[0].length };
    if (isProtectedRange(range, ctx.protectedRanges)) return null;
    return {
        patch: { repeatRule: repeatRuleName, repeatInterval, repeatRuleJson },
        anchorDate,
        range,
        priority,
    };
}

function selectRepeatCandidate(candidates: RepeatRuleCandidate[]): RepeatRuleCandidate | null {
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
        if (a.range.start !== b.range.start) return a.range.start - b.range.start;
        if (a.priority !== b.priority) return a.priority - b.priority;
        return (b.range.end - b.range.start) - (a.range.end - a.range.start);
    });
    return candidates[0];
}

function weeklyCustomJson(weekdays: number[]): string {
    return JSON.stringify({ frequency: "week", interval: 1, weekdays });
}

function monthlyLastDayCustomJson(): string {
    return JSON.stringify({ frequency: "month", interval: 1, monthDay: 31 });
}

function parseAdvanceSpec(text: string, protectedRanges: MatchRange[]): AdvanceSpec | null {
    const selected = selectAdvanceCandidate(ADVANCE_RULES.flatMap((rule) => rule.collect({ text, protectedRanges })));
    if (!selected) return null;
    const { priority: _priority, ...result } = selected;
    return result;
}

const ADVANCE_RULES: AdvanceRuleDefinition[] = [
    advanceRule("explicitZh", /提前\s*(\d+)\s*(分钟|小时|天|周)/g, 1, (m, range) => {
        const n = Number(m[1]);
        if (!Number.isFinite(n) || n <= 0) return null;
        const unit = m[2];
        let mul = 1;
        if (unit === "小时") mul = 60;
        else if (unit === "天") mul = 60 * 24;
        else if (unit === "周") mul = 60 * 24 * 7;
        return { offsetMinutes: clampAdvanceMinutes(n * mul), range };
    }),
    advanceRule("explicitEn", /\b(\d+)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?)\s+before\b/gi, 1, (m, range) => {
        const n = Number(m[1]);
        if (!Number.isFinite(n) || n <= 0) return null;
        const unit = m[2].toLowerCase();
        let mul = 1;
        if (unit.startsWith("hour") || unit.startsWith("hr")) mul = 60;
        else if (unit.startsWith("day")) mul = 60 * 24;
        else if (unit.startsWith("week")) mul = 60 * 24 * 7;
        return { offsetMinutes: clampAdvanceMinutes(n * mul), range };
    }),
    advanceRule("fallbackZh", /提前提醒我/g, 20, (_m, range) => ({ offsetMinutes: 5, range })),
];

function advanceRule(
    name: string,
    pattern: RegExp,
    priority: number,
    build: (match: RegExpExecArray, range: MatchRange) => AdvanceSpec | null,
): AdvanceRuleDefinition {
    return {
        name,
        collect: (ctx) => {
            const candidates: AdvanceRuleCandidate[] = [];
            pattern.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(ctx.text)) !== null) {
                const range = { start: match.index, end: match.index + match[0].length };
                if (!isProtectedRange(range, ctx.protectedRanges)) {
                    const spec = build(match, range);
                    if (spec) candidates.push({ ...spec, priority });
                }
                if (!pattern.global) break;
            }
            return candidates;
        },
    };
}

function selectAdvanceCandidate(candidates: AdvanceRuleCandidate[]): AdvanceRuleCandidate | null {
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        if (a.range.start !== b.range.start) return a.range.start - b.range.start;
        return (b.range.end - b.range.start) - (a.range.end - a.range.start);
    });
    return candidates[0];
}

function parseDueReminderSpec(text: string, protectedRanges: MatchRange[]): DueReminderSpec | null {
    return selectDueReminderCandidate(DUE_REMINDER_RULES.flatMap((rule) => rule.collect({ text, protectedRanges })));
}

const DUE_REMINDER_RULES: DueReminderRuleDefinition[] = [
    dueReminderRule("reminder", /提醒我|\bremind\s+me(?:\s+to)?\b/gi),
];

function dueReminderRule(name: string, pattern: RegExp): DueReminderRuleDefinition {
    return {
        name,
        collect: (ctx) => {
            const candidates: DueReminderSpec[] = [];
            pattern.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(ctx.text)) !== null) {
                const range = { start: match.index, end: match.index + match[0].length };
                if (!isProtectedRange(range, ctx.protectedRanges)) candidates.push({ range });
                if (!pattern.global) break;
            }
            return candidates;
        },
    };
}

function selectDueReminderCandidate(candidates: DueReminderSpec[]): DueReminderSpec | null {
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.range.start - b.range.start);
    return candidates[0];
}

function parseDelayedReminderSpec(text: string, now: Date, protectedRanges: MatchRange[]): DelayedReminderSpec | null {
    const candidates: Array<DelayedReminderSpec & { priority: number }> = [];
    collectDelayedReminderCandidates(
        text,
        protectedRanges,
        /(\d+)\s*小时\s*(\d+)\s*分钟后/g,
        1,
        (m) => {
            const hours = Number(m[1]);
            const minutes = Number(m[2]);
            return isPositiveInteger(hours) && isPositiveInteger(minutes) ? { hours, minutes } : null;
        },
        candidates,
        now,
    );
    collectDelayedReminderCandidates(
        text,
        protectedRanges,
        /(\d+)\s*(分钟|小时|天|周|月|年)后/g,
        2,
        (m) => delayedDurationPart(Number(m[1]), m[2]),
        candidates,
        now,
    );

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
        if (a.range.start !== b.range.start) return a.range.start - b.range.start;
        if (a.priority !== b.priority) return a.priority - b.priority;
        return (b.range.end - b.range.start) - (a.range.end - a.range.start);
    });
    const { priority: _priority, ...result } = candidates[0];
    return result;
}

function collectDelayedReminderCandidates(
    text: string,
    protectedRanges: MatchRange[],
    pattern: RegExp,
    priority: number,
    buildParts: (match: RegExpExecArray) => DelayedDurationParts | null,
    candidates: Array<DelayedReminderSpec & { priority: number }>,
    now: Date,
): void {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
        const range = { start: match.index, end: match.index + match[0].length };
        if (!isProtectedRange(range, protectedRanges)) {
            const parts = buildParts(match);
            if (parts) candidates.push({ dueAt: addDelayedDuration(now, parts), range, priority });
        }
    }
}

function delayedDurationPart(value: number, unit: string): DelayedDurationParts | null {
    if (!isPositiveInteger(value)) return null;
    if (unit === "分钟") return { minutes: value };
    if (unit === "小时") return { hours: value };
    if (unit === "天") return { days: value };
    if (unit === "周") return { weeks: value };
    if (unit === "月") return { months: value };
    if (unit === "年") return { years: value };
    return null;
}

function findProtectedRanges(text: string): MatchRange[] {
    const ranges: MatchRange[] = [];
    const tokenRe = /!\[[^\]]*\]\([^)]+\)|\[[^\]]+\]\([^)]+\)|(https?:\/\/[^\s)]+)/g;
    let m: RegExpExecArray | null;
    while ((m = tokenRe.exec(text)) !== null) {
        ranges.push({ start: m.index, end: m.index + m[0].length });
    }
    return mergeRanges(ranges);
}

function isProtectedRange(range: MatchRange, protectedRanges: MatchRange[]): boolean {
    for (const p of protectedRanges) {
        if (rangesOverlap(range, p)) return true;
    }
    return false;
}

function rangesOverlap(a: MatchRange, b: MatchRange): boolean {
    return a.start < b.end && b.start < a.end;
}

function cleanupTitle(title: string): string {
    return title
        .replace(/[，,。；;]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function removeRanges(text: string, ranges: MatchRange[]): string {
    if (ranges.length === 0) return text;
    const merged = mergeRanges(ranges);
    let out = "";
    let cursor = 0;
    for (const range of merged) {
        if (range.start > cursor) out += text.slice(cursor, range.start);
        cursor = Math.max(cursor, range.end);
    }
    if (cursor < text.length) out += text.slice(cursor);
    return out;
}

function mergeRanges(ranges: MatchRange[]): MatchRange[] {
    const sorted = [...ranges].sort((a, b) => a.start - b.start);
    const merged: MatchRange[] = [];
    for (const range of sorted) {
        if (!merged.length) {
            merged.push({ ...range });
            continue;
        }
        const last = merged[merged.length - 1];
        if (range.start <= last.end) {
            last.end = Math.max(last.end, range.end);
        } else {
            merged.push({ ...range });
        }
    }
    return merged;
}

function sortUniqueOffsets(offsets: number[]): number[] {
    return [...new Set(offsets.filter((v) => Number.isFinite(v) && v >= 0))].sort((a, b) => a - b);
}

function hasZhRightBoundary(text: string, end: number, opts: { allowDigit?: boolean; allowPeriodWord?: boolean } = {}): boolean {
    if (end >= text.length) return true;
    const rest = text.slice(end);
    if (/^[\s,，。.;；!！?？、]/.test(rest)) return true;
    if (opts.allowDigit && /^\d/.test(rest)) return true;
    if (opts.allowPeriodWord && /^(早上|上午|中午|下午|傍晚|晚上)/.test(rest)) return true;
    return false;
}

function startOfDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function addDays(base: Date, days: number): Date {
    const d = new Date(base);
    d.setDate(d.getDate() + days);
    return d;
}

function addDelayedDuration(now: Date, parts: DelayedDurationParts): Date {
    let next = new Date(now);
    next.setSeconds(0, 0);
    if (parts.years) next = addYearsClamped(next, parts.years);
    if (parts.months) next = addMonthsClamped(next, parts.months);
    if (parts.weeks) next.setDate(next.getDate() + parts.weeks * 7);
    if (parts.days) next.setDate(next.getDate() + parts.days);
    if (parts.hours) next.setHours(next.getHours() + parts.hours);
    if (parts.minutes) next.setMinutes(next.getMinutes() + parts.minutes);
    return next;
}

function formatDateKey(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

function formatDueAt(date: Date): string {
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    return `${formatDateKey(date)}T${hh}:${mm}`;
}

function isValidMonthDay(year: number, month: number, day: number): boolean {
    if (month < 1 || month > 12 || day < 1 || day > 31) return false;
    const d = new Date(year, month - 1, day);
    return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day;
}

function parseEnglishMonth(value: string): number {
    return EN_MONTH_MAP[value.toLowerCase().replace(/\.$/, "")] || 0;
}

function resolveEnglishMonthDay(now: Date, month: number, day: number, year: number | null, timeSpec: TimeSpec | null): Date | null {
    if (year !== null) {
        if (!Number.isInteger(year) || year < 1000 || year > 9999 || !isValidMonthDay(year, month, day)) return null;
        return new Date(year, month - 1, day, 0, 0, 0, 0);
    }
    return resolveNearestMonthDay(now, month, day, timeSpec);
}

function resolveNearestMonthDay(now: Date, month: number, day: number, timeSpec: TimeSpec | null): Date | null {
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const today = startOfDay(now);
    for (let y = now.getFullYear(); y <= now.getFullYear() + 6; y += 1) {
        if (!isValidMonthDay(y, month, day)) continue;
        const candidate = new Date(y, month - 1, day, 0, 0, 0, 0);
        if (timeSpec) {
            const candidateDt = new Date(y, month - 1, day, timeSpec.hour, timeSpec.minute, 0, 0);
            if (candidateDt.getTime() >= now.getTime()) return candidate;
            continue;
        }
        if (candidate.getTime() >= today.getTime()) return candidate;
    }
    return null;
}

function resolveNearestWeekday(now: Date, targetDay: number, timeSpec: TimeSpec | null): Date {
    const currentDay = now.getDay();
    let delta = (targetDay - currentDay + 7) % 7;
    let candidate = addDays(startOfDay(now), delta);

    if (delta === 0 && timeSpec) {
        const candidateDt = new Date(
            candidate.getFullYear(),
            candidate.getMonth(),
            candidate.getDate(),
            timeSpec.hour,
            timeSpec.minute,
            0,
            0,
        );
        if (candidateDt.getTime() < now.getTime()) {
            delta = 7;
            candidate = addDays(candidate, delta);
        }
    }
    return candidate;
}

function resolveNextWeekday(now: Date, targetDay: number, timeSpec: TimeSpec | null): Date {
    const nearest = resolveNearestWeekday(now, targetDay, timeSpec);
    if (nearest.getTime() === startOfDay(now).getTime()) return addDays(nearest, 7);
    return nearest;
}

function resolveNearestFromSet(now: Date, weekdays: number[], timeSpec: TimeSpec | null): Date {
    const today = startOfDay(now);
    for (let i = 0; i < 14; i += 1) {
        const candidate = addDays(today, i);
        if (timeSpec && i === 0 && isScheduledTimePast(now, candidate, timeSpec)) continue;
        if (weekdays.includes(candidate.getDay())) return candidate;
    }
    return today;
}

function resolveIntervalAnchorDate(now: Date, timeSpec: TimeSpec | null, interval: number, unit: "day" | "week" | "month"): Date {
    const today = startOfDay(now);
    if (!timeSpec || !isScheduledTimePast(now, today, timeSpec)) return today;
    if (unit === "day") return addDays(today, interval);
    if (unit === "week") return addDays(today, interval * 7);
    return addMonthsClamped(today, interval);
}

function isScheduledTimePast(now: Date, date: Date, timeSpec: TimeSpec): boolean {
    const dt = new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
        timeSpec.hour,
        timeSpec.minute,
        0,
        0,
    );
    return dt.getTime() < now.getTime();
}

function addMonthsClamped(base: Date, months: number): Date {
    const next = new Date(base);
    const day = next.getDate();
    next.setDate(1);
    next.setMonth(next.getMonth() + months);
    const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(day, lastDay));
    return next;
}

function addYearsClamped(base: Date, years: number): Date {
    const next = new Date(base);
    const month = next.getMonth();
    const day = next.getDate();
    next.setDate(1);
    next.setFullYear(next.getFullYear() + years);
    next.setMonth(month);
    const lastDay = new Date(next.getFullYear(), month + 1, 0).getDate();
    next.setDate(Math.min(day, lastDay));
    return next;
}

function resolveNearestMonthlyDay(now: Date, day: number): Date | null {
    if (day < 1 || day > 31) return null;
    const baseYear = now.getFullYear();
    const baseMonth = now.getMonth();
    const today = startOfDay(now);

    for (let i = 0; i < 24; i += 1) {
        const y = baseYear + Math.floor((baseMonth + i) / 12);
        const m = ((baseMonth + i) % 12) + 1;
        if (!isValidMonthDay(y, m, day)) continue;
        const candidate = new Date(y, m - 1, day, 0, 0, 0, 0);
        if (candidate.getTime() >= today.getTime()) return candidate;
    }
    return null;
}

function resolveNearestMonthLastDay(now: Date, timeSpec: TimeSpec | null): Date {
    const today = startOfDay(now);
    for (let i = 0; i < 24; i += 1) {
        const y = today.getFullYear() + Math.floor((today.getMonth() + i) / 12);
        const m = (today.getMonth() + i) % 12;
        const lastDay = new Date(y, m + 1, 0).getDate();
        const candidate = new Date(y, m, lastDay, 0, 0, 0, 0);
        if (timeSpec) {
            if (!isScheduledTimePast(now, candidate, timeSpec)) return candidate;
            continue;
        }
        if (candidate.getTime() >= today.getTime()) return candidate;
    }
    return today;
}

function resolveTimeOnly(now: Date, hour: number, minute: number): Date {
    const candidate = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        hour,
        minute,
        0,
        0,
    );
    if (candidate.getTime() >= now.getTime()) return candidate;
    return addDays(candidate, 1);
}

function applyPeriodToHour(hour: number, period: DayPeriod | null): number {
    if (!period) return hour;
    if (period === "下午" || period === "傍晚" || period === "晚上" || period === "afternoon" || period === "evening" || period === "tonight") {
        return hour < 12 ? hour + 12 : hour;
    }
    if (period === "中午" || period === "noon") {
        if (hour < 11) return hour + 12;
        return hour;
    }
    return hour;
}

function clampInterval(v: number): number {
    if (!Number.isFinite(v) || v < 1) return 1;
    return Math.min(MAX_REPEAT_INTERVAL, Math.floor(v));
}

function isPositiveInteger(v: number): boolean {
    return Number.isFinite(v) && Number.isInteger(v) && v > 0;
}

function clampAdvanceMinutes(v: number): number {
    if (!Number.isFinite(v) || v < 0) return 0;
    return Math.min(MAX_ADVANCE_MINUTES, Math.floor(v));
}
