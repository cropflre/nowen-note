import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_OUTLINE_WIDTH,
  MAX_OUTLINE_WIDTH,
  MIN_OUTLINE_WIDTH,
  OUTLINE_WIDTH_STORAGE_KEY,
  clampOutlineWidth,
  getSavedOutlineWidth,
  persistOutlineWidth,
} from "@/lib/outlinePanelWidth";

const editorPaneSource = readFileSync(
  path.resolve(__dirname, "../EditorPane.tsx"),
  "utf8",
);

beforeEach(() => {
  localStorage.clear();
});

describe("大纲栏宽度", () => {
  it("使用与现有界面一致的默认宽度，并限制拖动范围", () => {
    expect(DEFAULT_OUTLINE_WIDTH).toBe(224);
    expect(clampOutlineWidth(MIN_OUTLINE_WIDTH - 100)).toBe(MIN_OUTLINE_WIDTH);
    expect(clampOutlineWidth(MAX_OUTLINE_WIDTH + 100)).toBe(MAX_OUTLINE_WIDTH);
  });

  it("保存合法宽度，非法缓存回退默认值", () => {
    persistOutlineWidth(360);
    expect(localStorage.getItem(OUTLINE_WIDTH_STORAGE_KEY)).toBe("360");
    expect(getSavedOutlineWidth()).toBe(360);

    localStorage.setItem(OUTLINE_WIDTH_STORAGE_KEY, "invalid");
    expect(getSavedOutlineWidth()).toBe(DEFAULT_OUTLINE_WIDTH);
  });

  it("桌面大纲提供左边缘拖动和双击恢复默认交互", () => {
    expect(editorPaneSource).toContain("handleOutlineResizeStart");
    expect(editorPaneSource).toContain("onResetWidth={handleOutlineWidthReset}");
    expect(editorPaneSource).toContain("onDoubleClick={onResetWidth}");
    expect(editorPaneSource).toContain("拖拽调整大纲宽度 / 双击恢复默认");
    expect(editorPaneSource).toContain('style={{ width: `${width}px` }}');
  });
});
