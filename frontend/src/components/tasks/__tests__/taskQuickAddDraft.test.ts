import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTaskQuickAddDraft } from "../taskQuickAddDraft";

describe("任务快速创建属性合并", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-08T10:00:00"));
  });
  afterEach(() => { vi.useRealTimers(); });

  it("按筛选默认值、智能识别、手动设置的顺序合并", () => {
    const draft = resolveTaskQuickAddDraft("明天晚上8点 开会 提前3小时", { dueDate: "2026-07-08" }, {
      dueDate: "2026-07-10", dueTime: "21:00", reminderOffsets: [30],
    });
    expect(draft.cleanTitle).toBe("开会");
    expect(draft.taskPatch).toMatchObject({ dueDate: "2026-07-10", dueAt: "2026-07-10T21:00" });
    expect(draft.reminderOffsets).toEqual([30]);
  });

  it("手动只改日期时保留识别的时间，并同步 dueAt", () => {
    expect(resolveTaskQuickAddDraft("明天晚上8点 开会", {}, { dueDate: "2026-07-10" }).taskPatch)
      .toMatchObject({ dueDate: "2026-07-10", dueAt: "2026-07-10T20:00" });
  });

  it("手动清除时间后保留日期", () => {
    expect(resolveTaskQuickAddDraft("明天晚上8点 开会", {}, { dueTime: null }).taskPatch)
      .toMatchObject({ dueDate: "2026-07-09", dueAt: null });
  });

  it("手动清除日期后同时清除时间和提醒", () => {
    const draft = resolveTaskQuickAddDraft("明天晚上8点 开会 提前3小时", {}, { dueDate: null });
    expect(draft.taskPatch).toMatchObject({ dueDate: null, dueAt: null });
    expect(draft.reminderOffsets).toEqual([]);
  });

  it("不提醒可以覆盖智能识别的自动提醒", () => {
    expect(resolveTaskQuickAddDraft("明天晚上8点 开会", {}, { reminderOffsets: [] }).reminderOffsets).toEqual([]);
  });

  it("无截止日期时不会创建手动提醒", () => {
    expect(resolveTaskQuickAddDraft("开会", {}, { reminderOffsets: [30] }).reminderOffsets).toEqual([]);
  });

  it("未手动修改时保留筛选默认日期和原有识别规则", () => {
    expect(resolveTaskQuickAddDraft("开会", { dueDate: "2026-07-08" }).taskPatch).toEqual({ dueDate: "2026-07-08" });
    const draft = resolveTaskQuickAddDraft("今天下午3点 开会 提前3小时");
    expect(draft.taskPatch).toMatchObject({ dueDate: "2026-07-08", dueAt: "2026-07-08T15:00" });
    expect(draft.reminderOffsets).toEqual([0, 180]);
  });
});
