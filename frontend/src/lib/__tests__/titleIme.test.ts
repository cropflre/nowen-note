import { describe, expect, it } from "vitest";

import { shouldEmitTitleUpdate, shouldSkipTitleChange, shouldSyncTitleValue } from "../titleIme";

describe("titleIme", () => {
  it("中文输入法组合态期间跳过标题保存", () => {
    expect(shouldSkipTitleChange({ eventIsComposing: true, isComposing: false })).toBe(true);
    expect(shouldSkipTitleChange({ eventIsComposing: false, isComposing: true })).toBe(true);
    expect(shouldSkipTitleChange({ eventIsComposing: false, isComposing: false })).toBe(false);
  });

  it("中文输入法组合态期间不回填 note.title 到输入框", () => {
    expect(shouldSyncTitleValue({ inputValue: "7yue", noteTitle: "7月", isComposing: true })).toBe(false);
    expect(shouldSyncTitleValue({ inputValue: "旧标题", noteTitle: "新标题", isComposing: false })).toBe(true);
    expect(shouldSyncTitleValue({ inputValue: "同标题", noteTitle: "同标题", isComposing: false })).toBe(false);
  });

  it("标题没有变化时不触发更新", () => {
    expect(shouldEmitTitleUpdate({ title: "标题", noteTitle: "标题", lastEmittedTitle: "标题" })).toBe(false);
    expect(shouldEmitTitleUpdate({ title: "标题", noteTitle: "旧标题", lastEmittedTitle: "标题" })).toBe(false);
    expect(shouldEmitTitleUpdate({ title: "新标题", noteTitle: "旧标题", lastEmittedTitle: "旧标题" })).toBe(true);
  });
});
