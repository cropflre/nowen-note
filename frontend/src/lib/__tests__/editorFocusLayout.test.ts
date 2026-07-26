import { describe, expect, it } from "vitest";
import { resolveEditorFocusLayout } from "@/lib/editorFocusLayout";

describe("editorFocusLayout", () => {
  it("keeps navigation and the note list when no panel is explicitly collapsed", () => {
    expect(resolveEditorFocusLayout({
      editorFullscreen: false,
      railVisible: true,
      sidebarCollapsed: false,
      noteListCollapsed: false,
    })).toEqual({
      showRail: true,
      showSidebar: true,
      showNoteList: true,
    });
  });

  it("hides the middle note list only when noteListCollapsed is enabled", () => {
    expect(resolveEditorFocusLayout({
      editorFullscreen: false,
      railVisible: true,
      sidebarCollapsed: false,
      noteListCollapsed: true,
    })).toEqual({
      showRail: true,
      showSidebar: true,
      showNoteList: false,
    });
  });

  it("hides every outer panel while editor fullscreen is on", () => {
    expect(resolveEditorFocusLayout({
      editorFullscreen: true,
      railVisible: true,
      sidebarCollapsed: false,
      noteListCollapsed: false,
    })).toEqual({
      showRail: false,
      showSidebar: false,
      showNoteList: false,
    });
  });
});
