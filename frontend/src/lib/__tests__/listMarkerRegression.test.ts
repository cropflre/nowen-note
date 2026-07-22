import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf-8");

describe("list marker regressions", () => {
  it("excludes both Tiptap and GFM task items from custom markers", () => {
    for (const path of [
      "src/index.css",
      "src/lib/exportServiceCore.ts",
      "src/lib/noteImageExportCore.ts",
    ]) {
      const source = read(path);
      expect(source).toContain(':not([data-type="taskItem"]):not(.task-list-item)::before');
      expect(source).toContain("ul.contains-task-list > li.task-list-item::before");
    }
  });

  it("keeps ordered markers scoped to direct children", () => {
    const source = read("src/index.css");
    expect(source).toContain(".ProseMirror ol > li");
    expect(source).not.toContain(".ProseMirror ol li {");
  });

  it("updates toolbar state only when the nearest list type changes", () => {
    const source = read("src/components/TiptapEditor.tsx");
    expect(source).not.toContain("selectionTick");
    expect(source).toContain("activeListTypeRef.current === next");
  });
});
