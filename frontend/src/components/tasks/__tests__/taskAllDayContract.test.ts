import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.resolve(__dirname, "../TaskDetailPanel.tsx"), "utf8");

describe("TaskDetailPanel all-day contract", () => {
  it("uses an accessible switch and keeps unscheduled tasks disabled", () => {
    expect(source).toContain('role="switch"');
    expect(source).toContain("aria-checked={allDay}");
    expect(source).toContain("disabled={!hasScheduledDate}");
  });

  it("keeps a session backup before clearing task times", () => {
    expect(source).toContain("timedValuesRef.current = { startAt, dueAt }");
    expect(source).toContain("const previous = timedValuesRef.current");
  });

  it("does not persist time fields while all-day is enabled", () => {
    expect(source).toContain("dueAt: allDay ? null");
    expect(source).toContain("startDate: allDay ? (startDate || null)");
    expect(source).toContain("dueDate: dueDate || null");
  });
});
