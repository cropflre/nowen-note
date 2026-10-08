import { describe, expect, it } from "vitest";
import { groupCalendarDaysByWeek } from "../taskCalendarLayout";
import fs from "node:fs";
import path from "node:path";

const calendarSource = fs.readFileSync(path.resolve(__dirname, "../TaskCalendarView.tsx"), "utf8");

describe("task calendar adaptive layout", () => {
  it("keeps seven aligned dates per week across four-, five- and six-week months", () => {
    for (const weeks of [4, 5, 6]) {
      const days = Array.from({ length: weeks * 7 }, (_, index) => new Date(2026, 1, index + 1));
      const rows = groupCalendarDaysByWeek(days);
      expect(rows).toHaveLength(weeks);
      expect(rows.every((row) => row.length === 7)).toBe(true);
      expect(rows.flat()).toEqual(days);
    }
  });

  it("does not stretch an empty calendar row to equal busy rows", () => {
    expect(calendarSource).toContain('calendarWeeks.map((week)');
    expect(calendarSource).toContain('className="grid grid-cols-7"');
    expect(calendarSource).toContain('min-h-[54px] md:min-h-[64px]');
    expect(calendarSource).not.toContain('className="grid grid-cols-7 flex-1"');
  });

  it("keeps full task titles, larger desktop labels and a compact mobile count", () => {
    expect(calendarSource).toContain('{task.title}');
    expect(calendarSource).not.toContain("task.title.slice(0, 12)");
    expect(calendarSource).toContain('md:text-[clamp(11px,11cqw,14px)]');
    expect(calendarSource).toContain('[container-type:inline-size]');
    expect(calendarSource).toContain('aria-label={t("tasks.taskCount"');
    expect(calendarSource).toContain('const MAX_VISIBLE = 3;');
  });

  it("preserves task selection and drag/drop date changes", () => {
    expect(calendarSource).toContain('onSelect(task);');
    expect(calendarSource).toContain('onMoveTaskDate(taskId, targetDateKey)');
    expect(calendarSource).toContain('onDrop={isMobile ? undefined');
  });
});
