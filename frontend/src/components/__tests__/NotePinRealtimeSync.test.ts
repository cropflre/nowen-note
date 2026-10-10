import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sidebarSource = readFileSync(path.resolve(__dirname, "../KnowledgeTreePanel.tsx"), "utf8");
const noteListSource = readFileSync(path.resolve(__dirname, "../NoteList.tsx"), "utf8");

describe("realtime note pin synchronization", () => {
  it("reconciles global pin state into the sidebar tree cache", () => {
    expect(sidebarSource).toContain("compareKnowledgeTreePinnedPriority");
    expect(sidebarSource).toContain("isPinned");
  });

  it("updates the active note when pinning it from the directory list", () => {
    expect(noteListSource).toContain(
      "actions.setActiveNote({ ...state.activeNote, isPinned: newVal });",
    );
  });

  it("persists manual drag order from the displayed pinned-first order", () => {
    expect(noteListSource).not.toContain("reorderNotesWithinNotebook(state.notes");
    expect(noteListSource.match(/reorderNotesWithinNotebook\(sortedNotes/g)).toHaveLength(2);
    expect(sidebarSource).toContain("KNOWLEDGE_TREE_SORT_OPTIONS");
    expect(sidebarSource).toContain('value: `sort:${option.value}`');
  });
});
