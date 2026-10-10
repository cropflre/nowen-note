import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const noteListSource = readFileSync(
  path.resolve(__dirname, "../NoteList.tsx"),
  "utf8",
);

describe("VirtualNoteList scroll viewport", () => {
  const start = noteListSource.indexOf("function VirtualNoteList");
  const end = noteListSource.indexOf("function NoteList", start);
  const virtualListSource = noteListSource.slice(start, end);

  it("给虚拟列表滚动容器标记专用 viewport", () => {
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(virtualListSource).toContain('data-note-list-scroll-viewport="virtual"');
  });

  it("同一列表刷新不因 notes 引用变化回顶部，只在语义 scope 变化时复位", () => {
    expect(virtualListSource).toContain("scrollScopeKey: string;");
    expect(virtualListSource).toContain("}, [scrollScopeKey]);");
    expect(virtualListSource).not.toContain("}, [notes]);");
    expect(noteListSource).toContain("scrollScopeKey={notesQueryKey}");
  });

  it("普通列表与虚拟列表共用 notesQueryKey 滚动复位语义", () => {
    expect(noteListSource).toContain("}, [notesQueryKey]);");
    expect(noteListSource).toContain('folderScope: currentFolderOnly ? "current" : "recursive"');
    expect(noteListSource).toContain("selectedKnowledgeTreeParentId,");
  });
});
