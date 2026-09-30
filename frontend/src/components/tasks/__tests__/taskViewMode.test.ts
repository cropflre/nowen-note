import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTaskViewMode, saveTaskViewMode, TASK_VIEW_MODE_KEY } from "../taskViewMode";

describe("任务视图记忆", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it.each(["list", "board", "calendar", "timeline"] as const)("保存并恢复 %s", (mode) => {
    saveTaskViewMode(mode);
    expect(loadTaskViewMode()).toBe(mode);
  });

  it("缺少或无效值时回到列表", () => {
    expect(loadTaskViewMode()).toBe("list");
    localStorage.setItem(TASK_VIEW_MODE_KEY, "invalid");
    expect(loadTaskViewMode()).toBe("list");
  });

  it("存储受限时读取和切换不抛异常", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    expect(loadTaskViewMode()).toBe("list");
    expect(() => saveTaskViewMode("board")).not.toThrow();
  });
});
