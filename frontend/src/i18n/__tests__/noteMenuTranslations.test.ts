import { describe, expect, it } from "vitest";
import i18n from "../index";
import { NOTE_COLOR_MARK_OPTIONS } from "@/lib/noteColorMark";

describe("note menu translations", () => {
  it.each([
    { language: "zh-CN", action: "颜色标记", colors: ["无标记", "红色", "橙色", "黄色", "绿色", "蓝色", "紫色", "灰色"], print: "打印" },
    { language: "en", action: "Color mark", colors: ["No mark", "Red", "Orange", "Yellow", "Green", "Blue", "Purple", "Gray"], print: "Print" },
  ])("loads color marks alongside the other note translations in $language", ({ language, action, colors, print }) => {
    const t = i18n.getFixedT(language);
    expect(t("note.colorMark.action")).toBe(action);
    expect(NOTE_COLOR_MARK_OPTIONS.map((option) => t(option.labelKey))).toEqual(colors);
    expect(t("note.print")).toBe(print);
  });
});
