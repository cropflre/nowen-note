export type NoteWorkspaceLayoutMode = "standard" | "three-column";
export type NoteWorkspaceSurface = "web" | "desktop" | "native-mobile";

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

/**
 * The React workspace is shared by the browser Web app and Electron.
 * Keep the distinction explicit so future native-only checks cannot
 * accidentally hide wide-screen layout controls from Web users.
 */
export function detectNoteWorkspaceSurface(
  runtimeWindow: Window | undefined = typeof window === "undefined" ? undefined : window,
): NoteWorkspaceSurface {
  if (!runtimeWindow) return "web";

  const runtime = runtimeWindow as Window & {
    nowenDesktop?: { isDesktop?: boolean };
    Capacitor?: {
      isNativePlatform?: () => boolean;
      platform?: string;
      getPlatform?: () => string;
    };
  };

  const capacitorPlatform = runtime.Capacitor?.getPlatform?.()
    || runtime.Capacitor?.platform;
  const nativeMobile = runtime.Capacitor?.isNativePlatform?.()
    || (!!capacitorPlatform && capacitorPlatform !== "web");

  if (nativeMobile) return "native-mobile";
  if (runtime.nowenDesktop?.isDesktop) return "desktop";
  return "web";
}

export function supportsWideNoteWorkspaceLayout(surface: NoteWorkspaceSurface): boolean {
  return surface === "web" || surface === "desktop";
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
