export type NoteWorkspaceLayoutMode = "standard" | "three-column";

export const NOTE_WORKSPACE_LAYOUT_STORAGE_KEY = "nowen-note-workspace-layout";
export const THREE_COLUMN_MIN_VIEWPORT_WIDTH = 1120;

export type NoteWorkspaceAutoCollapseReason = "viewport" | "right-split" | "focus" | null;

export interface NoteWorkspaceVisibilityInput {
  mode: NoteWorkspaceLayoutMode;
  noteListCollapsed: boolean;
  editorFullscreen: boolean;
  viewportWidth: number;
  splitDirection?: "right" | "down" | null;
}

export interface NoteWorkspaceVisibility {
  showNoteList: boolean;
  autoCollapseReason: NoteWorkspaceAutoCollapseReason;
}

export function loadNoteWorkspaceLayoutMode(
  legacyNoteListCollapsed = false,
): NoteWorkspaceLayoutMode {
  try {
    const saved = localStorage.getItem(NOTE_WORKSPACE_LAYOUT_STORAGE_KEY);
    if (saved === "standard" || saved === "three-column") return saved;
  } catch {
    // The preference is device-local and must never block app startup.
  }
  return legacyNoteListCollapsed ? "standard" : "three-column";
}

export function persistNoteWorkspaceLayoutMode(mode: NoteWorkspaceLayoutMode): void {
  try {
    localStorage.setItem(NOTE_WORKSPACE_LAYOUT_STORAGE_KEY, mode);
  } catch {
    // Ignore unavailable or full storage.
  }
}

export function resolveNoteWorkspaceVisibility(
  input: NoteWorkspaceVisibilityInput,
): NoteWorkspaceVisibility {
  if (input.editorFullscreen) {
    return { showNoteList: false, autoCollapseReason: "focus" };
  }
  if (input.mode !== "three-column" || input.noteListCollapsed) {
    return { showNoteList: false, autoCollapseReason: null };
  }
  if (input.splitDirection === "right") {
    return { showNoteList: false, autoCollapseReason: "right-split" };
  }
  if (input.viewportWidth < THREE_COLUMN_MIN_VIEWPORT_WIDTH) {
    return { showNoteList: false, autoCollapseReason: "viewport" };
  }
  return { showNoteList: true, autoCollapseReason: null };
}

export function getAutomaticCollapseReason(input: {
  editorFullscreen: boolean;
  viewportWidth: number;
  splitDirection?: "right" | "down" | null;
}): NoteWorkspaceAutoCollapseReason {
  if (input.editorFullscreen) return "focus";
  if (input.splitDirection === "right") return "right-split";
  if (input.viewportWidth < THREE_COLUMN_MIN_VIEWPORT_WIDTH) return "viewport";
  return null;
}
