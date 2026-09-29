import { describe, expect, it } from "vitest";
import {
  isNavigationModuleVisible,
  isTaskCenterModuleVisible,
  normalizeHiddenNavigationModules,
  normalizeHiddenTaskCenterModules,
} from "../navigationVisibility";

describe("navigation visibility", () => {
  it("hides only known navigation modules", () => {
    const hidden = normalizeHiddenNavigationModules(["tasks", "diary", "tasks", "unknown"]);
    expect(hidden).toEqual(["tasks", "diary"]);
    expect(isNavigationModuleVisible("tasks", hidden)).toBe(false);
    expect(isNavigationModuleVisible("trash", hidden)).toBe(true);
  });

  it("shows notifications by default and supports hiding and restoring the entry", () => {
    expect(isNavigationModuleVisible("notifications", [])).toBe(true);
    const hidden = normalizeHiddenNavigationModules(["notifications", "notifications"]);
    expect(hidden).toEqual(["notifications"]);
    expect(isNavigationModuleVisible("notifications", hidden)).toBe(false);
    expect(isNavigationModuleVisible("notifications", hidden.filter((id) => id !== "notifications"))).toBe(true);
  });

  it("keeps core tasks available while optional task modules can be hidden", () => {
    const hidden = normalizeHiddenTaskCenterModules(["habits", "stats", "tasks"]);
    expect(hidden).toEqual(["habits", "stats"]);
    expect(isTaskCenterModuleVisible("habits", hidden)).toBe(false);
    expect(isTaskCenterModuleVisible("tasks", hidden)).toBe(true);
  });
});
