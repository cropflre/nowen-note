import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const noteListSource = readFileSync(
  path.resolve(__dirname, "../NoteList.tsx"),
  "utf8",
);

describe("NoteList Android touch interaction", () => {
  it("粗指针设备上的笔记卡片不启用 HTML draggable", () => {
    expect(noteListSource).toContain(
      "shouldUseHtmlNoteDragging(canDragSort, isCoarsePointer())",
    );
    expect(noteListSource.match(/draggable=\{useHtmlNoteDragging\}/g)).toHaveLength(2);
  });
});
