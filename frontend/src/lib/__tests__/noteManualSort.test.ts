import { describe, expect, it } from "vitest";
import {
  getNoteListDragHint,
  reorderNotesWithinNotebook,
  shouldUseHtmlNoteDragging,
} from "@/lib/noteManualSort";

const note = (id: string, notebookId = "nb", isLocked = 0) => ({
  id,
  notebookId,
  isLocked,
});

describe("reorderNotesWithinNotebook", () => {
  it("在同一笔记本内把笔记移到目标笔记之前", () => {
    const result = reorderNotesWithinNotebook(
      [note("a"), note("b"), note("c")],
      "c",
      "a",
      "before",
    );

    expect(result?.notes.map((n) => n.id)).toEqual(["c", "a", "b"]);
    expect(result?.items).toEqual([
      { id: "c", sortOrder: 0 },
      { id: "a", sortOrder: 1 },
      { id: "b", sortOrder: 2 },
    ]);
  });

  it("在同一笔记本内把笔记移到目标笔记之后", () => {
    const result = reorderNotesWithinNotebook(
      [note("a"), note("b"), note("c")],
      "a",
      "c",
      "after",
    );

    expect(result?.notes.map((n) => n.id)).toEqual(["b", "c", "a"]);
  });

  it("不同笔记本或锁定笔记不排序", () => {
    expect(reorderNotesWithinNotebook([note("a"), note("b", "other")], "a", "b", "before")).toBeNull();
    expect(reorderNotesWithinNotebook([note("a", "nb", 1), note("b")], "a", "b", "before")).toBeNull();
  });

  it("混合列表中只持久化同一笔记本的 sortOrder", () => {
    const result = reorderNotesWithinNotebook(
      [note("a"), note("x", "other"), note("b"), note("c")],
      "c",
      "a",
      "before",
    );

    expect(result?.notes.map((n) => n.id)).toEqual(["c", "a", "x", "b"]);
    expect(result?.items).toEqual([
      { id: "c", sortOrder: 0 },
      { id: "a", sortOrder: 1 },
      { id: "b", sortOrder: 2 },
    ]);
  });

  it("置顶分组存在时只持久化当前分组的手动顺序", () => {
    const result = reorderNotesWithinNotebook(
      [
        { ...note("pinned"), isPinned: 1, sortOrder: 9 },
        { ...note("a"), isPinned: 0, sortOrder: 0 },
        { ...note("b"), isPinned: 0, sortOrder: 1 },
        { ...note("c"), isPinned: 0, sortOrder: 2 },
      ],
      "c",
      "a",
      "before",
    );

    expect(result?.notes.map((n) => n.id)).toEqual(["pinned", "c", "a", "b"]);
    expect(result?.notes.map((n) => n.sortOrder)).toEqual([9, 0, 1, 2]);
    expect(result?.items).toEqual([
      { id: "c", sortOrder: 0 },
      { id: "a", sortOrder: 1 },
      { id: "b", sortOrder: 2 },
    ]);
  });

  it("不允许把笔记拖到另一个置顶分组", () => {
    expect(reorderNotesWithinNotebook(
      [{ ...note("pinned"), isPinned: 1 }, { ...note("normal"), isPinned: 0 }],
      "pinned",
      "normal",
      "before",
    )).toBeNull();
  });
});

describe("getNoteListDragHint", () => {
  it("非手动排序时提示切换到手动排序", () => {
    expect(getNoteListDragHint(false)).toBe("切换到手动排序后可拖动调整顺序");
  });

  it("手动排序时提示可拖动", () => {
    expect(getNoteListDragHint(true)).toBe("拖动调整笔记顺序");
  });
});

describe("shouldUseHtmlNoteDragging", () => {
  it("在粗指针触摸设备上禁用 HTML 拖拽", () => {
    expect(shouldUseHtmlNoteDragging(true, true)).toBe(false);
    expect(shouldUseHtmlNoteDragging(true, false)).toBe(true);
    expect(shouldUseHtmlNoteDragging(false, false)).toBe(false);
  });
});
