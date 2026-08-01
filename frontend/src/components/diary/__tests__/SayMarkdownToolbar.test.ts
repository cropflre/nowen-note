import { describe, expect, it } from "vitest";
import { applySayMarkdownAction } from "@/components/diary/SayMarkdownToolbar";

describe("applySayMarkdownAction", () => {
  it("wraps the selected text in bold markers", () => {
    const result = applySayMarkdownAction("hello world", 6, 11, "bold");
    expect(result.text).toBe("hello **world**");
    expect(result.text.slice(result.selectionStart, result.selectionEnd)).toBe("world");
  });

  it("prefixes all selected lines as a task list", () => {
    const result = applySayMarkdownAction("one\ntwo", 0, 7, "taskList");
    expect(result.text).toBe("- [ ] one\n- [ ] two");
  });

  it("creates numbered list prefixes", () => {
    const result = applySayMarkdownAction("one\ntwo", 0, 7, "orderedList");
    expect(result.text).toBe("1. one\n2. two");
  });
});
