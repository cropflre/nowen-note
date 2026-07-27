import { describe, expect, it } from "vitest";

import {
  defaultInlineCreateTitle,
  normalizeInlineCreateTitle,
} from "@/lib/knowledgeTreeInlineCreate";

describe("knowledge tree inline create", () => {
  it("provides selected starter titles for every inline type", () => {
    expect(defaultInlineCreateTitle("note")).toBe("未命名文档");
    expect(defaultInlineCreateTitle("markdown")).toBe("未命名 Markdown");
    expect(defaultInlineCreateTitle("folder")).toBe("未命名文件夹");
  });

  it("normalizes valid titles and rejects whitespace-only drafts", () => {
    expect(normalizeInlineCreateTitle("  项目计划  ")).toBe("项目计划");
    expect(normalizeInlineCreateTitle("   ")).toBeNull();
  });
});
