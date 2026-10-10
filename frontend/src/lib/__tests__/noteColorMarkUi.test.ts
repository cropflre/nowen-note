import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NOTE_COLOR_MARK_OPTIONS, getNoteColorMarkHex, isNoteColorMark } from "../noteColorMark";
const source = (relativePath: string) => readFileSync(path.resolve(__dirname, relativePath), "utf8");

describe("note color marks (#749)", () => {
  it("keeps a fixed semantic palette independent from note themes", () => {
    expect(NOTE_COLOR_MARK_OPTIONS.map((item) => item.value)).toEqual([
      null, "red", "orange", "yellow", "green", "blue", "purple", "gray",
    ]);
    expect(getNoteColorMarkHex("blue")).toBe("#3b82f6");
    expect(getNoteColorMarkHex(null)).toBeNull();
    expect(isNoteColorMark("purple")).toBe(true);
    expect(isNoteColorMark("custom")).toBe(false);
  });

  it("renders marks in list, both knowledge-tree surfaces, tabs, and editor header", () => {
    expect(source("../../components/NoteList.tsx")).toContain("<NoteColorMarkDot value={note.colorMark}");
    expect(source("../../components/KnowledgeTreePanel.tsx")).toContain("<NoteColorMarkDot value={node.colorMark}");
    expect(source("../../components/MobileKnowledgeTreePanel.tsx")).toContain("<NoteColorMarkDot value={node.colorMark}");
    expect(source("../../components/NoteTabsBar.tsx")).toContain("<NoteColorMarkDot value={colorMark}");
    expect(source("../../components/EditorPane.tsx")).toContain("<NoteColorMarkPicker");
  });

  it("uses the canonical colorMark mutation path", () => {
    const list = source("../../components/NoteList.tsx");
    const editor = source("../../components/EditorPane.tsx");
    expect(list).toContain("api.updateNote(targetId, { colorMark: nextColor }");
    expect(editor).toContain("api.updateNote(activeNote.id, { colorMark }");
    expect(list).toContain('emitKnowledgeTreeRefresh("note-color-mark-changed")');
  });
});
