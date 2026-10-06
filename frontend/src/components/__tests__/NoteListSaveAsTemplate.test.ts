import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const noteListSource = readFileSync(
  path.resolve(__dirname, "../NoteList.tsx"),
  "utf8",
);

describe("NoteList 保存为模板", () => {
  it("在单笔记右键菜单中复用笔记模板保存能力", () => {
    expect(noteListSource).toContain('import { noteTemplatesApi } from "@/lib/noteTemplatesApi";');
    expect(noteListSource).toContain('id: "save_as_template"');
    expect(noteListSource).toContain('label: t("note.contextMenu.saveAsTemplate")');
    expect(noteListSource).toContain('case "save_as_template"');
    expect(noteListSource).toContain('title: "保存为模板"');
    expect(noteListSource).toContain("await noteTemplatesApi.createFromNote(targetId, name.trim())");
    expect(noteListSource).toContain('toast.success("已保存为模板")');
  });

  it("锁定笔记和不支持的内容格式不可保存为模板", () => {
    expect(noteListSource).toContain("targetNote.isLocked === 1");
    expect(noteListSource).toContain('targetNote.contentFormat !== "markdown"');
    expect(noteListSource).toContain('targetNote.contentFormat !== "tiptap-json"');
  });
});
