import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const component = (name: string) => readFileSync(path.resolve(__dirname, `../${name}`), "utf8");

describe("new note lock-on-open contract", () => {
  it("consumes the one-time opening in EditorPane without bypassing persisted locks", () => {
    const editor = component("EditorPane.tsx");
    expect(editor).toContain("lastOpenedNoteIdRef.current === id");
    expect(editor).toContain("shouldApplyDefaultViewLock(id, userPrefs.lockOnOpen)");
    expect(editor).toContain("!!activeNote?.isLocked || isViewLocked || isTrashed || noteSwitchPending");
  });

  it("marks quick create, note list create, and tab create before opening", () => {
    expect(component("../App.tsx")).toContain("markNewNoteForImmediateEdit(note.id);\n      actions.setActiveNote(note)");
    expect(component("NoteList.tsx")).toContain("markNewNoteForImmediateEdit(note.id);\n      actions.setActiveNote(note)");
    expect(component("NoteTabsBar.tsx")).toContain("markNewNoteForImmediateEdit(note.id);\n      actions.setActiveNote(note)");
  });

  it("marks inline and template creation in both knowledge tree views", () => {
    for (const name of ["KnowledgeTreePanel.tsx", "MobileKnowledgeTreePanel.tsx"]) {
      const tree = component(name);
      expect(tree).toContain("if (newlyCreated) markNewNoteForImmediateEdit(note.id)");
      expect(tree).toContain("activateNote(await api.getNote(created.resourceId), snapshot.parentId, true)");
      expect(tree).toMatch(/activateNote\(await api\.getNote\(result\.noteId\), [^,]+, true\)/);
    }
  });
});
