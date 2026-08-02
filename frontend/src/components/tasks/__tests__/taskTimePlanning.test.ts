import { describe, expect, it } from "vitest";
import type { TaskTimeBlock } from "@/lib/taskTimePlanningApi";
import {
  addMinutesIso,
  findConflictingBlockIds,
  formatMinutes,
  minutesBetween,
  occupiedMinutes,
} from "../taskTimePlanning";

function block(id: string, startAt: string, endAt: string): TaskTimeBlock {
  return {
    id,
    taskId: `task-${id}`,
    userId: "user-1",
    workspaceId: "personal",
    startAt,
    endAt,
    timeZone: "UTC",
    createdAt: startAt,
    updatedAt: startAt,
    taskTitle: id,
    priority: 2,
    projectId: null,
    isCompleted: 0,
    estimatedMinutes: null,
  };
}

describe("task time planning helpers", () => {
  it("detects overlapping blocks without marking adjacent blocks", () => {
    const blocks = [
      block("a", "2026-08-03T01:00:00.000Z", "2026-08-03T02:00:00.000Z"),
      block("b", "2026-08-03T01:30:00.000Z", "2026-08-03T02:30:00.000Z"),
      block("c", "2026-08-03T02:30:00.000Z", "2026-08-03T03:00:00.000Z"),
    ];

    expect([...findConflictingBlockIds(blocks)].sort()).toEqual(["a", "b"]);
  });

  it("calculates occupied time as the union of overlapping ranges", () => {
    const blocks = [
      block("a", "2026-08-03T01:00:00.000Z", "2026-08-03T02:00:00.000Z"),
      block("b", "2026-08-03T01:30:00.000Z", "2026-08-03T02:30:00.000Z"),
      block("c", "2026-08-03T03:00:00.000Z", "2026-08-03T03:30:00.000Z"),
    ];

    expect(occupiedMinutes(blocks)).toBe(120);
  });

  it("adds and formats durations consistently", () => {
    const start = "2026-08-03T01:00:00.000Z";
    const end = addMinutesIso(start, 90);
    expect(end).toBe("2026-08-03T02:30:00.000Z");
    expect(minutesBetween(start, end)).toBe(90);
    expect(formatMinutes(90, true)).toBe("1 小时 30 分钟");
    expect(formatMinutes(90, false)).toBe("1h 30m");
  });
});
