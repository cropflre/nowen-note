import { describe, expect, it } from "vitest";
import { resolveExternalDropNotebookId } from "@/lib/notebookExternalDropTarget";

describe("resolveExternalDropNotebookId", () => {
  it("优先使用已选笔记本", () => {
    expect(resolveExternalDropNotebookId("selected", [{ id: "first" }])).toBe("selected");
  });

  it("未选笔记本时使用当前空间的第一个笔记本", () => {
    expect(resolveExternalDropNotebookId(null, [{ id: "first" }, { id: "second" }])).toBe("first");
  });

  it("当前空间没有笔记本时不返回目标", () => {
    expect(resolveExternalDropNotebookId(null, [])).toBeNull();
  });
});
