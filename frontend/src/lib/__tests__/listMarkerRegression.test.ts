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

  it("limits completion decoration to own paragraphs across share and exports", () => {
    const main = read("src/index.css");
    const markers = read("src/editor-list-markers.css");
    const htmlExport = read("src/lib/exportServiceCore.ts");
    const imageExport = read("src/lib/noteImageExportCore.ts");
    const shared = read("src/components/SharedNoteView.tsx");
    expect(main).toContain('li.task-list-item[data-checked="true"] > p > .nowen-task-item-text');
    expect(main).toContain('li[data-type="taskItem"][data-checked="true"] > div > p');
    expect(markers).toContain('li.task-item[data-checked="true"] > div > p');
    expect(markers).not.toContain('li.task-item[data-checked="true"] > div,');
    expect(shared).toContain('class="task-item" data-checked=');
    for (const source of [htmlExport, imageExport]) {
      expect(source).toContain('li[data-type="taskItem"][data-checked="true"] > p');
      expect(source).toContain('li[data-type="taskItem"][data-checked="true"] > div > p');
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
