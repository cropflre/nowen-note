import { beforeEach, describe, expect, it } from "vitest";
import {
  NOTE_WORKSPACE_LAYOUT_CHANGED_EVENT,
  NOTE_WORKSPACE_LAYOUT_STORAGE_KEY,
  THREE_COLUMN_MIN_VIEWPORT_WIDTH,
  detectNoteWorkspaceSurface,
  getAutomaticCollapseReason,
  loadNoteWorkspaceLayoutMode,
  persistNoteWorkspaceLayoutMode,
  resolveNoteWorkspaceVisibility,
  supportsWideNoteWorkspaceLayout,
  usesThreeColumnFolderNavigation,
  type NoteWorkspaceLayoutMode,
} from "@/lib/noteWorkspaceLayout";

describe("note workspace layout", () => {
  beforeEach(() => localStorage.clear());

  it("supports wide layouts in Web and Electron but not native mobile", () => {
    const webWindow = {} as Window;
    const desktopWindow = {
      nowenDesktop: { isDesktop: true },
    } as unknown as Window;
    const nativeWindow = {
      Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => "android",
      },
    } as unknown as Window;

    expect(detectNoteWorkspaceSurface(webWindow)).toBe("web");
    expect(detectNoteWorkspaceSurface(desktopWindow)).toBe("desktop");
    expect(detectNoteWorkspaceSurface(nativeWindow)).toBe("native-mobile");
    expect(supportsWideNoteWorkspaceLayout("web")).toBe(true);
    expect(supportsWideNoteWorkspaceLayout("desktop")).toBe(true);
    expect(supportsWideNoteWorkspaceLayout("native-mobile")).toBe(false);
  });

  it("limits direct folder navigation to desktop three-column mode", () => {
      expect(usesThreeColumnFolderNavigation({ mode: "three-column", noteListCollapsed: false, desktopSurface: true })).toBe(true);
      expect(usesThreeColumnFolderNavigation({ mode: "standard", noteListCollapsed: false, desktopSurface: true })).toBe(false);
      expect(usesThreeColumnFolderNavigation({ mode: "three-column", noteListCollapsed: true, desktopSurface: true })).toBe(false);
      expect(usesThreeColumnFolderNavigation({ mode: "three-column", noteListCollapsed: false, desktopSurface: false })).toBe(false);
    });

    it("migrates the previous note-list collapsed preference", () => {
    expect(loadNoteWorkspaceLayoutMode(true)).toBe("standard");
    expect(loadNoteWorkspaceLayoutMode(false)).toBe("three-column");
  });

  it("persists an explicit device-local preference", () => {
    const changed = new Promise<NoteWorkspaceLayoutMode>((resolve) => {
      window.addEventListener(NOTE_WORKSPACE_LAYOUT_CHANGED_EVENT, (event) => {
        resolve((event as CustomEvent<NoteWorkspaceLayoutMode>).detail);
      }, { once: true });
    });
    persistNoteWorkspaceLayoutMode("standard");
    expect(localStorage.getItem(NOTE_WORKSPACE_LAYOUT_STORAGE_KEY)).toBe("standard");
    expect(loadNoteWorkspaceLayoutMode(false)).toBe("standard");
    return expect(changed).resolves.toBe("standard");
  });

  it("shows the middle list when three-column mode has enough room", () => {
    expect(resolveNoteWorkspaceVisibility({
      mode: "three-column",
      noteListCollapsed: false,
      editorFullscreen: false,
      viewportWidth: THREE_COLUMN_MIN_VIEWPORT_WIDTH,
      splitDirection: null,
    })).toEqual({ showNoteList: true, autoCollapseReason: null });
  });

  it("falls back on narrow windows without changing the preferred mode", () => {
    expect(resolveNoteWorkspaceVisibility({
      mode: "three-column",
      noteListCollapsed: false,
      editorFullscreen: false,
      viewportWidth: THREE_COLUMN_MIN_VIEWPORT_WIDTH - 1,
      splitDirection: null,
    })).toEqual({ showNoteList: false, autoCollapseReason: "viewport" });
  });

  it("temporarily collapses for right split but not down split", () => {
    expect(getAutomaticCollapseReason({
      editorFullscreen: false,
      viewportWidth: 1920,
      splitDirection: "right",
    })).toBe("right-split");
    expect(getAutomaticCollapseReason({
      editorFullscreen: false,
      viewportWidth: 1920,
      splitDirection: "down",
    })).toBeNull();
  });

  it("uses focus mode as a temporary automatic collapse", () => {
    expect(getAutomaticCollapseReason({
      editorFullscreen: true,
      viewportWidth: 1920,
      splitDirection: null,
    })).toBe("focus");
  });
});
