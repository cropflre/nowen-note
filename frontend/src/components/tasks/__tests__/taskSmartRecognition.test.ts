import { describe, expect, it } from "vitest";
import { parseTaskQuickAdd } from "../taskSmartRecognition";

function dt(value: string): Date {
    return new Date(value);
}

describe("taskSmartRecognition - date/time", () => {
    it("parses 今天 明天 后天", () => {
        const now = dt("2026-07-08T10:00:00");
        expect(parseTaskQuickAdd("今天 开会", now).taskPatch.dueDate).toBe("2026-07-08");
        expect(parseTaskQuickAdd("明天 开会", now).taskPatch.dueDate).toBe("2026-07-09");
        expect(parseTaskQuickAdd("后天 开会", now).taskPatch.dueDate).toBe("2026-07-10");
    });

    it("parses 周一 as nearest valid Monday", () => {
        const now = dt("2026-07-08T10:00:00"); // Wednesday
        const parsed = parseTaskQuickAdd("周一 例会", now);
        expect(parsed.taskPatch.dueDate).toBe("2026-07-13");
        expect(parsed.cleanTitle).toBe("例会");
    });

    it("parses 3月 as nearest valid March first day", () => {
        const now = dt("2026-07-08T10:00:00");
        const parsed = parseTaskQuickAdd("3月 做计划", now);
        expect(parsed.taskPatch.dueDate).toBe("2027-03-01");
        expect(parsed.cleanTitle).toBe("做计划");
    });

    it("parses month-day in multiple formats", () => {
        const now = dt("2026-07-08T10:00:00");
        expect(parseTaskQuickAdd("3月6日 体检", now).taskPatch.dueDate).toBe("2027-03-06");
        expect(parseTaskQuickAdd("3/6 体检", now).taskPatch.dueDate).toBe("2027-03-06");
        expect(parseTaskQuickAdd("03/06 体检", now).taskPatch.dueDate).toBe("2027-03-06");
        expect(parseTaskQuickAdd("3-6 体检", now).taskPatch.dueDate).toBe("2027-03-06");
        expect(parseTaskQuickAdd("1.20 体检", now).taskPatch.dueDate).toBe("2027-01-20");
    });

    it("does not parse version-like dotted numbers as dates", () => {
        const now = dt("2026-07-08T10:00:00");
        expect(parseTaskQuickAdd("发布 v1.20", now).taskPatch.dueDate).toBeUndefined();
        expect(parseTaskQuickAdd("升级 1.20.3", now).taskPatch.dueDate).toBeUndefined();
    });

    it("requires separators after standalone Chinese date and period tokens", () => {
        const now = dt("2026-07-08T10:00:00");

        expect(parseTaskQuickAdd("下午茶", now)).toMatchObject({
            cleanTitle: "下午茶",
            taskPatch: {},
        });
        expect(parseTaskQuickAdd("3月报", now)).toMatchObject({
            cleanTitle: "3月报",
            taskPatch: {},
        });
        expect(parseTaskQuickAdd("周一报", now)).toMatchObject({
            cleanTitle: "周一报",
            taskPatch: {},
        });

        expect(parseTaskQuickAdd("下午 茶", now).taskPatch.dueAt).toBe("2026-07-08T13:00");
        expect(parseTaskQuickAdd("3月 报", now).taskPatch.dueDate).toBe("2027-03-01");
        expect(parseTaskQuickAdd("周一 报", now).taskPatch.dueDate).toBe("2026-07-13");
    });

    it("parses 星期天 as nearest valid Sunday", () => {
        const now = dt("2026-07-08T10:00:00"); // Wednesday
        const parsed = parseTaskQuickAdd("星期天 聚餐", now);
        expect(parsed.taskPatch.dueDate).toBe("2026-07-12");
        expect(parsed.cleanTitle).toBe("聚餐");
    });

    it("parses 9点 and 9点半 as nearest valid time", () => {
        const nowPastNine = dt("2026-07-08T10:00:00");
        const nowBeforeNine = dt("2026-07-08T08:00:00");

        const nine = parseTaskQuickAdd("9点 早会", nowPastNine);
        expect(nine.taskPatch.dueDate).toBe("2026-07-09");
        expect(nine.taskPatch.dueAt).toBe("2026-07-09T09:00");

        const nineHalf = parseTaskQuickAdd("9点半 早会", nowBeforeNine);
        expect(nineHalf.taskPatch.dueDate).toBe("2026-07-08");
        expect(nineHalf.taskPatch.dueAt).toBe("2026-07-08T09:30");
    });

    it("parses 3月6日9点 with combined date+time", () => {
        const now = dt("2026-07-08T10:00:00");
        const parsed = parseTaskQuickAdd("3月6日9点 面试", now);
        expect(parsed.taskPatch.dueDate).toBe("2027-03-06");
        expect(parsed.taskPatch.dueAt).toBe("2027-03-06T09:00");
        expect(parsed.cleanTitle).toBe("面试");
    });

    it("maps period words to default times", () => {
        const now = dt("2026-07-08T06:00:00");
        expect(parseTaskQuickAdd("早上 跑步", now).taskPatch.dueAt).toBe("2026-07-08T07:00");
        expect(parseTaskQuickAdd("上午 开会", now).taskPatch.dueAt).toBe("2026-07-08T09:00");
        expect(parseTaskQuickAdd("中午 吃饭", now).taskPatch.dueAt).toBe("2026-07-08T12:00");
        expect(parseTaskQuickAdd("下午 学习", now).taskPatch.dueAt).toBe("2026-07-08T13:00");
        expect(parseTaskQuickAdd("傍晚 散步", now).taskPatch.dueAt).toBe("2026-07-08T17:00");
        expect(parseTaskQuickAdd("晚上 追剧", now).taskPatch.dueAt).toBe("2026-07-08T20:00");
    });

    it("maps 下午3点 to 15:00", () => {
        const now = dt("2026-07-08T08:00:00");
        const parsed = parseTaskQuickAdd("今天下午3点 开会", now);
        expect(parsed.taskPatch.dueDate).toBe("2026-07-08");
        expect(parsed.taskPatch.dueAt).toBe("2026-07-08T15:00");
        expect(parsed.cleanTitle).toBe("开会");
    });

    it("parses colon time with reminder command", () => {
        const now = dt("2026-07-08T10:00:00");
        const parsed = parseTaskQuickAdd("明天12:50提醒我上班", now);
        expect(parsed.taskPatch.dueDate).toBe("2026-07-09");
        expect(parsed.taskPatch.dueAt).toBe("2026-07-09T12:50");
        expect(parsed.reminderOffsets).toEqual([0]);
        expect(parsed.cleanTitle).toBe("上班");
        expect(parsed.recognizedRanges.map((range) => "明天12:50提醒我上班".slice(range.start, range.end))).toEqual([
            "明天12:50提醒我",
        ]);
    });

    it("parses full hh:mm:ss token without leaving trailing seconds", () => {
        const now = dt("2026-07-08T10:00:00");
        const parsed = parseTaskQuickAdd("5:30:40 上班", now);
        expect(parsed.taskPatch.dueDate).toBe("2026-07-09");
        expect(parsed.taskPatch.dueAt).toBe("2026-07-09T05:30");
        expect(parsed.cleanTitle).toBe("上班");
        expect(parsed.recognizedRanges.map((range) => "5:30:40 上班".slice(range.start, range.end))).toEqual([
            "5:30:40",
        ]);
    });

    it("parses English relative date, time, and reminder command", () => {
        const now = dt("2026-07-08T10:00:00");
        const parsed = parseTaskQuickAdd("tomorrow 12:50 remind me to work", now);
        expect(parsed.taskPatch.dueDate).toBe("2026-07-09");
        expect(parsed.taskPatch.dueAt).toBe("2026-07-09T12:50");
        expect(parsed.reminderOffsets).toEqual([0]);
        expect(parsed.cleanTitle).toBe("work");
        expect(parsed.recognizedRanges.map((range) => "tomorrow 12:50 remind me to work".slice(range.start, range.end))).toEqual([
            "tomorrow",
            "12:50",
            "remind me to",
        ]);
    });

    it("parses English weekdays and am/pm times", () => {
        const now = dt("2026-07-08T10:00:00"); // Wednesday

        const nextMonday = parseTaskQuickAdd("next Monday 9am sync", now);
        expect(nextMonday.taskPatch.dueDate).toBe("2026-07-13");
        expect(nextMonday.taskPatch.dueAt).toBe("2026-07-13T09:00");
        expect(nextMonday.cleanTitle).toBe("sync");

        const tonight = parseTaskQuickAdd("tonight deployment", now);
        expect(tonight.taskPatch.dueDate).toBe("2026-07-08");
        expect(tonight.taskPatch.dueAt).toBe("2026-07-08T20:00");
        expect(tonight.cleanTitle).toBe("deployment");
    });

    it("parses English weekday abbreviations", () => {
        const now = dt("2026-07-08T10:00:00"); // Wednesday
        const parsed = parseTaskQuickAdd("Fri. 5pm demo", now);
        expect(parsed.taskPatch.dueDate).toBe("2026-07-10");
        expect(parsed.taskPatch.dueAt).toBe("2026-07-10T17:00");
        expect(parsed.cleanTitle).toBe("demo");
        expect(parsed.recognizedRanges.map((range) => "Fri. 5pm demo".slice(range.start, range.end))).toEqual([
            "Fri.",
            "5pm",
        ]);
    });

    it("parses English month names and abbreviations", () => {
        const now = dt("2026-07-08T10:00:00");

        const monthFirst = parseTaskQuickAdd("Mar. 6 9am physical exam", now);
        expect(monthFirst.taskPatch.dueDate).toBe("2027-03-06");
        expect(monthFirst.taskPatch.dueAt).toBe("2027-03-06T09:00");
        expect(monthFirst.cleanTitle).toBe("physical exam");

        const dayFirst = parseTaskQuickAdd("6 Sept review", now);
        expect(dayFirst.taskPatch.dueDate).toBe("2026-09-06");
        expect(dayFirst.cleanTitle).toBe("review");

        const monthOnly = parseTaskQuickAdd("in Oct planning", now);
        expect(monthOnly.taskPatch.dueDate).toBe("2026-10-01");
        expect(monthOnly.cleanTitle).toBe("planning");
    });

    it("honors expired explicit English dates", () => {
        const now = dt("2026-07-08T10:00:00");
        const parsed = parseTaskQuickAdd("Mar. 6, 2026 9am exam", now);

        expect(parsed.taskPatch.dueDate).toBe("2026-03-06");
        expect(parsed.taskPatch.dueAt).toBe("2026-03-06T09:00");
        expect(parsed.reminderOffsets).toEqual([]);
        expect(parsed.cleanTitle).toBe("exam");
        expect(parsed.recognizedRanges.map((range) => "Mar. 6, 2026 9am exam".slice(range.start, range.end))).toEqual([
            "Mar. 6, 2026",
            "9am",
        ]);
    });
});

describe("taskSmartRecognition - repeat", () => {
    it("parses 每天 / 每2天 / 每2周 / 每2月", () => {
        const now = dt("2026-07-08T10:00:00");

        const daily = parseTaskQuickAdd("每天 写日记", now);
        expect(daily.taskPatch.repeatRule).toBe("daily");
        expect(daily.taskPatch.repeatInterval).toBe(1);
        expect(daily.taskPatch.dueDate).toBe("2026-07-08");

        const every2Days = parseTaskQuickAdd("每2天 运动", now);
        expect(every2Days.taskPatch.repeatRule).toBe("daily");
        expect(every2Days.taskPatch.repeatInterval).toBe(2);

        const every2Weeks = parseTaskQuickAdd("每2周 复盘", now);
        expect(every2Weeks.taskPatch.repeatRule).toBe("weekly");
        expect(every2Weeks.taskPatch.repeatInterval).toBe(2);

        const every2Months = parseTaskQuickAdd("每2月 归档", now);
        expect(every2Months.taskPatch.repeatRule).toBe("monthly");
        expect(every2Months.taskPatch.repeatInterval).toBe(2);
        expect(every2Months.taskPatch.dueDate).toBe("2026-07-08");
    });

    it("parses 每周 from nearest Monday", () => {
        const now = dt("2026-07-08T10:00:00");
        const parsed = parseTaskQuickAdd("每周 周会", now);
        expect(parsed.taskPatch.repeatRule).toBe("weekly");
        expect(parsed.taskPatch.repeatInterval).toBe(1);
        expect(parsed.taskPatch.dueDate).toBe("2026-07-13");
    });

    it("parses 每周四 from nearest Thursday", () => {
        const now = dt("2026-07-08T10:00:00"); // Wednesday
        const parsed = parseTaskQuickAdd("每周四 例会", now);
        expect(parsed.taskPatch.repeatRule).toBe("weekly");
        expect(parsed.taskPatch.repeatInterval).toBe(1);
        expect(parsed.taskPatch.dueDate).toBe("2026-07-09");
        expect(parsed.cleanTitle).toBe("例会");

        const longForm = parseTaskQuickAdd("每星期四 例会", now);
        expect(longForm.taskPatch.repeatRule).toBe("weekly");
        expect(longForm.taskPatch.repeatInterval).toBe(1);
        expect(longForm.taskPatch.dueDate).toBe("2026-07-09");
        expect(longForm.cleanTitle).toBe("例会");
    });

    it("requires separators after standalone Chinese weekly repeat tokens", () => {
        const now = dt("2026-07-08T10:00:00");

        expect(parseTaskQuickAdd("每周报", now)).toMatchObject({
            cleanTitle: "每周报",
            taskPatch: {},
        });
        expect(parseTaskQuickAdd("每年3月报", now)).toMatchObject({
            cleanTitle: "每年3月报",
            taskPatch: {},
        });
        expect(parseTaskQuickAdd("每周 报", now)).toMatchObject({
            cleanTitle: "报",
            taskPatch: { repeatRule: "weekly", repeatInterval: 1, dueDate: "2026-07-13" },
        });
        expect(parseTaskQuickAdd("每年3月 报", now)).toMatchObject({
            cleanTitle: "报",
            taskPatch: { repeatRule: "yearly", repeatInterval: 1, dueDate: "2027-03-01" },
        });
    });

    it("parses 每年3月 and 每年3月6日", () => {
        const now = dt("2026-07-08T10:00:00");

        const yMonth = parseTaskQuickAdd("每年3月 做预算", now);
        expect(yMonth.taskPatch.repeatRule).toBe("yearly");
        expect(yMonth.taskPatch.repeatInterval).toBe(1);
        expect(yMonth.taskPatch.dueDate).toBe("2027-03-01");

        const yDay = parseTaskQuickAdd("每年3月6日 纪念日", now);
        expect(yDay.taskPatch.repeatRule).toBe("yearly");
        expect(yDay.taskPatch.repeatInterval).toBe(1);
        expect(yDay.taskPatch.dueDate).toBe("2027-03-06");
    });

    it("parses 每个工作日 and 每周末重复 as custom weekly", () => {
        const now = dt("2026-07-10T10:00:00"); // Friday

        const weekday = parseTaskQuickAdd("每个工作日 写日报", now);
        expect(weekday.taskPatch.repeatRule).toBe("custom");
        expect(weekday.taskPatch.dueDate).toBe("2026-07-10");
        expect(weekday.taskPatch.repeatRuleJson).toBe(
            JSON.stringify({ frequency: "week", interval: 1, weekdays: [1, 2, 3, 4, 5] }),
        );

        const weekend = parseTaskQuickAdd("每周末重复 打球", now);
        expect(weekend.taskPatch.repeatRule).toBe("custom");
        expect(weekend.taskPatch.dueDate).toBe("2026-07-11");
        expect(weekend.taskPatch.repeatRuleJson).toBe(
            JSON.stringify({ frequency: "week", interval: 1, weekdays: [0, 6] }),
        );
    });

    it("parses English repeat phrases", () => {
        const now = dt("2026-07-10T10:00:00"); // Friday

        const weekday = parseTaskQuickAdd("every weekday write report", now);
        expect(weekday.taskPatch.repeatRule).toBe("custom");
        expect(weekday.taskPatch.dueDate).toBe("2026-07-10");
        expect(weekday.taskPatch.repeatRuleJson).toBe(
            JSON.stringify({ frequency: "week", interval: 1, weekdays: [1, 2, 3, 4, 5] }),
        );
        expect(weekday.cleanTitle).toBe("write report");

        const every2Weeks = parseTaskQuickAdd("every 2 weeks review", now);
        expect(every2Weeks.taskPatch.repeatRule).toBe("weekly");
        expect(every2Weeks.taskPatch.repeatInterval).toBe(2);
        expect(every2Weeks.cleanTitle).toBe("review");
    });

    it("parses 每月第1天 from nearest valid month day 1", () => {
        const now = dt("2026-07-08T10:00:00");
        const parsed = parseTaskQuickAdd("每月第1天 对账", now);
        expect(parsed.taskPatch.repeatRule).toBe("monthly");
        expect(parsed.taskPatch.repeatInterval).toBe(1);
        expect(parsed.taskPatch.dueDate).toBe("2026-08-01");
    });

    it("parses 每月10日 from nearest valid month day 10", () => {
        const now = dt("2026-07-08T10:00:00");
        const parsed = parseTaskQuickAdd("每月10日 记账", now);
        expect(parsed.taskPatch.repeatRule).toBe("monthly");
        expect(parsed.taskPatch.repeatInterval).toBe(1);
        expect(parsed.taskPatch.dueDate).toBe("2026-07-10");
        expect(parsed.cleanTitle).toBe("记账");
    });

    it("parses 每月最后1天 as custom monthly last day", () => {
        const now = dt("2026-07-08T10:00:00");
        const parsed = parseTaskQuickAdd("每月最后1天提交月报", now);

        expect(parsed.taskPatch.repeatRule).toBe("custom");
        expect(parsed.taskPatch.repeatInterval).toBe(1);
        expect(parsed.taskPatch.dueDate).toBe("2026-07-31");
        expect(parsed.taskPatch.repeatRuleJson).toBe(
            JSON.stringify({ frequency: "month", interval: 1, monthDay: 31 }),
        );
        expect(parsed.cleanTitle).toBe("提交月报");

        const alt = parseTaskQuickAdd("每月最后一天 提交月报", now);
        expect(alt.taskPatch.repeatRule).toBe("custom");
        expect(alt.taskPatch.dueDate).toBe("2026-07-31");
        expect(alt.cleanTitle).toBe("提交月报");
    });

    it("caps oversized 每N月 interval", () => {
        const now = dt("2026-07-08T10:00:00");
        const parsed = parseTaskQuickAdd("每100000月 归档", now);
        expect(parsed.taskPatch.repeatRule).toBe("monthly");
        expect(parsed.taskPatch.repeatInterval).toBe(999);
        expect(parsed.taskPatch.dueDate).toBe("2026-07-08");
    });

    it("does not create the first repeating dueAt in the past", () => {
        const now = dt("2026-07-08T10:00:00");

        const daily = parseTaskQuickAdd("每天9点 写日报", now);
        expect(daily.taskPatch.repeatRule).toBe("daily");
        expect(daily.taskPatch.dueDate).toBe("2026-07-09");
        expect(daily.taskPatch.dueAt).toBe("2026-07-09T09:00");

        const every2Days = parseTaskQuickAdd("每2天9点 运动", now);
        expect(every2Days.taskPatch.repeatRule).toBe("daily");
        expect(every2Days.taskPatch.repeatInterval).toBe(2);
        expect(every2Days.taskPatch.dueDate).toBe("2026-07-10");
        expect(every2Days.taskPatch.dueAt).toBe("2026-07-10T09:00");
    });
});

describe("taskSmartRecognition - reminders and cleanup", () => {
    it("creates an at-due reminder only for recognized time deadlines", () => {
        const now = dt("2026-07-08T10:00:00");

        const dateOnly = parseTaskQuickAdd("明天 提交报告", now);
        expect(dateOnly.taskPatch.dueDate).toBe("2026-07-09");
        expect(dateOnly.reminderOffsets).toEqual([]);

        const dateOnlyWithReminder = parseTaskQuickAdd("明天 提醒我 提交报告", now);
        expect(dateOnlyWithReminder.taskPatch.dueDate).toBe("2026-07-09");
        expect(dateOnlyWithReminder.taskPatch.dueAt).toBeUndefined();
        expect(dateOnlyWithReminder.reminderOffsets).toEqual([930]);

        const dateAndTime = parseTaskQuickAdd("明天下午3点 开会", now);
        expect(dateAndTime.taskPatch.dueAt).toBe("2026-07-09T15:00");
        expect(dateAndTime.reminderOffsets).toEqual([0]);
    });

    it("creates due reminder + advance reminder", () => {
        const now = dt("2026-07-08T10:00:00");
        const parsed = parseTaskQuickAdd("今天下午3点 开会，提前3小时", now);
        expect(parsed.taskPatch.dueAt).toBe("2026-07-08T15:00");
        expect(parsed.reminderOffsets).toEqual([0, 180]);
        expect(parsed.cleanTitle).toBe("开会");
        expect(parsed.recognizedRanges.map((range) => "今天下午3点 开会，提前3小时".slice(range.start, range.end))).toEqual([
            "今天下午3点",
            "提前3小时",
        ]);
    });

    it("uses default 5 minutes for 提前提醒我", () => {
        const now = dt("2026-07-08T10:00:00");
        const parsed = parseTaskQuickAdd("今天下午3点 开会 提前提醒我", now);
        expect(parsed.reminderOffsets).toEqual([0, 5]);
        expect(parsed.cleanTitle).toBe("开会");
    });

    it("parses English advance reminder", () => {
        const now = dt("2026-07-08T10:00:00");
        const parsed = parseTaskQuickAdd("tomorrow 3pm meeting 2 hours before", now);
        expect(parsed.taskPatch.dueAt).toBe("2026-07-09T15:00");
        expect(parsed.reminderOffsets).toEqual([0, 120]);
        expect(parsed.cleanTitle).toBe("meeting");
    });

    it("removes due reminder command when paired with advance reminder", () => {
        const now = dt("2026-07-08T10:00:00");

        const zh = parseTaskQuickAdd("明天3点提醒我开会 提前3小时", now);
        expect(zh.reminderOffsets).toEqual([0, 180]);
        expect(zh.cleanTitle).toBe("开会");

        const en = parseTaskQuickAdd("tomorrow 3pm remind me to meet 2 hours before", now);
        expect(en.reminderOffsets).toEqual([0, 120]);
        expect(en.cleanTitle).toBe("meet");
    });

    it("does not consume advance phrase without target time", () => {
        const now = dt("2026-07-08T10:00:00");
        const parsed = parseTaskQuickAdd("写报告 提前提醒我", now);
        expect(parsed.reminderOffsets).toEqual([]);
        expect(parsed.cleanTitle).toBe("写报告 提前提醒我");
    });

    it("parses delayed reminders in minutes/hours/days/weeks/months/years", () => {
        const now = dt("2026-07-08T10:00:00");
        const minutes = parseTaskQuickAdd("5分钟后喝水", now);

        expect(minutes).toMatchObject({
            cleanTitle: "喝水",
            reminderOffsets: [0],
            taskPatch: {
                dueDate: "2026-07-08",
                dueAt: "2026-07-08T10:05",
            },
        });
        expect(minutes.recognizedRanges.map((range) => "5分钟后喝水".slice(range.start, range.end))).toEqual([
            "5分钟后",
        ]);

        expect(parseTaskQuickAdd("1小时后 开会", now).taskPatch.dueAt).toBe("2026-07-08T11:00");
        expect(parseTaskQuickAdd("1天后 交材料", now).taskPatch.dueDate).toBe("2026-07-09");
        expect(parseTaskQuickAdd("1周后 复查", now).taskPatch.dueDate).toBe("2026-07-15");
        expect(parseTaskQuickAdd("1月后 续费", now).taskPatch.dueDate).toBe("2026-08-08");
        expect(parseTaskQuickAdd("1年后 年检", now).taskPatch.dueDate).toBe("2027-07-08");
    });

    it("parses combined delayed reminder 1小时30分钟后", () => {
        const now = dt("2026-07-08T10:00:00");
        const parsed = parseTaskQuickAdd("1小时30分钟后提醒我开会", now);

        expect(parsed.taskPatch.dueDate).toBe("2026-07-08");
        expect(parsed.taskPatch.dueAt).toBe("2026-07-08T11:30");
        expect(parsed.reminderOffsets).toEqual([0]);
        expect(parsed.cleanTitle).toBe("开会");
        expect(parsed.recognizedRanges.map((range) => "1小时30分钟后提醒我开会".slice(range.start, range.end))).toEqual([
            "1小时30分钟后提醒我",
        ]);
    });

    it("uses calendar month/year math for delayed reminders", () => {
        const leapDay = dt("2024-02-29T10:00:00");

        expect(parseTaskQuickAdd("1月后 续费", leapDay).taskPatch.dueAt).toBe("2024-03-29T10:00");
        expect(parseTaskQuickAdd("1年后 年检", leapDay).taskPatch.dueAt).toBe("2025-02-28T10:00");
    });

    it("ignores date-like tokens inside raw URL", () => {
        const now = dt("2026-07-08T10:00:00");
        const parsed = parseTaskQuickAdd("看文档 https://a.example.com/3/6", now);
        expect(parsed.taskPatch.dueDate).toBeUndefined();
        expect(parsed.taskPatch.dueAt).toBeUndefined();
        expect(parsed.cleanTitle).toBe("看文档 https://a.example.com/3/6");
    });

    it("ignores scheduling phrases inside markdown link and image", () => {
        const now = dt("2026-07-08T10:00:00");
        const parsed = parseTaskQuickAdd("整理 [每2月计划](https://a.example.com/3/6) ![今天](https://a.example.com/1.png)", now);
        expect(parsed.taskPatch.repeatRule).toBeUndefined();
        expect(parsed.taskPatch.dueDate).toBeUndefined();
        expect(parsed.cleanTitle).toBe("整理 [每2月计划](https://a.example.com/3/6) ![今天](https://a.example.com/1.png)");
    });

    it("does not parse delayed phrases inside protected ranges", () => {
        const now = dt("2026-07-08T10:00:00");

        expect(parseTaskQuickAdd("看 https://a.example.com/5分钟后", now).taskPatch.dueAt).toBeUndefined();
        expect(parseTaskQuickAdd("看 [5分钟后](https://a.example.com)", now).taskPatch.dueAt).toBeUndefined();
        expect(parseTaskQuickAdd("看 ![5分钟后](https://a.example.com/a.png)", now).taskPatch.dueAt).toBeUndefined();
    });

    it("caps oversized advance reminder", () => {
        const now = dt("2026-07-08T10:00:00");
        const parsed = parseTaskQuickAdd("今天下午3点 开会 提前100000周", now);
        expect(parsed.taskPatch.dueAt).toBe("2026-07-08T15:00");
        expect(parsed.reminderOffsets).toEqual([0, 525600]);
    });
});
