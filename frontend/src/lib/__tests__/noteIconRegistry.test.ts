import { describe, expect, it } from "vitest";
import { ALL_EMOJIS } from "@/data/emojiData";
import { ALL_NOTE_ICONS, searchNoteIcons } from "../noteIconRegistry";

describe("笔记图标搜索", () => {
  it("提供已有离线 emoji 库并去重", () => {
    expect(ALL_EMOJIS.every((emoji) => ALL_NOTE_ICONS.includes(emoji))).toBe(true);
    expect(new Set(ALL_NOTE_ICONS).size).toBe(ALL_NOTE_ICONS.length);
    expect(searchNoteIcons("  ")).toEqual(ALL_NOTE_ICONS);
  });

  it.each(["猫", " CAT "])("支持具体图标名称 %s", (query) => {
    expect(searchNoteIcons(query)).toContain("🐱");
    expect(searchNoteIcons(query)).not.toContain("💻");
  });

  it("保留分类搜索、直接 emoji 搜索，并为无结果返回空列表", () => {
    expect(searchNoteIcons("开发")).toContain("💻");
    expect(searchNoteIcons("闹钟")).toContain("⏰");
    expect(searchNoteIcons("🐱")).toEqual(["🐱"]);
    expect(searchNoteIcons("不存在的图标词条")).toEqual([]);
  });
});
