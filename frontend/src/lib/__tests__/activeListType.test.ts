import { describe, expect, it } from "vitest";
import { getActiveListType } from "@/lib/activeListType";

function editorWithPath(names: string[]) {
  return {
    state: {
      selection: {
        $from: {
          depth: names.length - 1,
          node: (depth: number) => ({ type: { name: names[depth] } }),
        },
      },
    },
  };
}

describe("getActiveListType", () => {
  it("returns the nearest list in mixed nested lists", () => {
    const editor = editorWithPath([
      "doc",
      "orderedList",
      "listItem",
      "bulletList",
      "listItem",
      "paragraph",
    ]);
    expect(getActiveListType(editor)).toBe("bulletList");
  });

  it("recognizes task lists and non-list selections", () => {
    expect(getActiveListType(editorWithPath(["doc", "taskList", "taskItem", "paragraph"]))).toBe("taskList");
    expect(getActiveListType(editorWithPath(["doc", "paragraph"]))).toBeNull();
    expect(getActiveListType(null)).toBeNull();
  });
});
