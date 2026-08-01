from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8-sig")


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def replace_once(content: str, old: str, new: str, label: str) -> str:
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, got {count}")
    return content.replace(old, new, 1)


layout_lib = '''export type NoteWorkspaceLayoutMode = "standard" | "three-column";

export const NOTE_WORKSPACE_LAYOUT_STORAGE_KEY = "nowen-note-workspace-layout";
export const THREE_COLUMN_MIN_VIEWPORT_WIDTH = 1120;

export type NoteWorkspaceAutoCollapseReason = "viewport" | "right-split" | null;

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

export function loadNoteWorkspaceLayoutMode(legacyNoteListCollapsed = false): NoteWorkspaceLayoutMode {
  try {
    const saved = localStorage.getItem(NOTE_WORKSPACE_LAYOUT_STORAGE_KEY);
    if (saved === "standard" || saved === "three-column") return saved;
  } catch {
    // Ignore unavailable localStorage and preserve the previous layout semantics.
  }
  return legacyNoteListCollapsed ? "standard" : "three-column";
}

export function persistNoteWorkspaceLayoutMode(mode: NoteWorkspaceLayoutMode): void {
  try {
    localStorage.setItem(NOTE_WORKSPACE_LAYOUT_STORAGE_KEY, mode);
  } catch {
    // Local-only preference; failure must not block the editor.
  }
}

export function resolveNoteWorkspaceVisibility(
  input: NoteWorkspaceVisibilityInput,
): NoteWorkspaceVisibility {
  if (input.editorFullscreen || input.mode !== "three-column" || input.noteListCollapsed) {
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
'''
write("frontend/src/lib/noteWorkspaceLayout.ts", layout_lib)

layout_menu = '''import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Maximize2, PanelLeft, PanelLeftClose } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useApp, useAppActions } from "@/store/AppContext";
import type { NoteWorkspaceLayoutMode } from "@/lib/noteWorkspaceLayout";
import { cn } from "@/lib/utils";

interface LayoutChoice {
  id: NoteWorkspaceLayoutMode | "focus";
  title: string;
  description: string;
  icon: React.ReactNode;
  previewColumns: number;
}

export default function NoteWorkspaceLayoutMenu({ compact = false }: { compact?: boolean }) {
  const { state } = useApp();
  const actions = useAppActions();
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 44 });

  const current = state.editorFullscreen ? "focus" : state.noteWorkspaceLayoutMode;
  const choices = useMemo<LayoutChoice[]>(() => [
    {
      id: "standard",
      title: t("workspaceLayout.standard", { defaultValue: "标准模式" }),
      description: t("workspaceLayout.standardDescription", { defaultValue: "知识结构与编辑器，保留更宽的写作区域" }),
      icon: <PanelLeftClose size={16} />,
      previewColumns: 2,
    },
    {
      id: "three-column",
      title: t("workspaceLayout.threeColumn", { defaultValue: "三栏模式" }),
      description: t("workspaceLayout.threeColumnDescription", { defaultValue: "知识结构、笔记列表和编辑器；窄窗口会自动降级" }),
      icon: <PanelLeft size={16} />,
      previewColumns: 3,
    },
    {
      id: "focus",
      title: t("workspaceLayout.focus", { defaultValue: "专注模式" }),
      description: t("workspaceLayout.focusDescription", { defaultValue: "只显示编辑器，隐藏外侧导航" }),
      icon: <Maximize2 size={16} />,
      previewColumns: 1,
    },
  ], [t]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (triggerRef.current?.contains(event.target as Node)) return;
      if (menuRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        window.requestAnimationFrame(() => triggerRef.current?.focus());
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const toggle = () => {
    if (!open) {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) {
        const width = 304;
        setPosition({
          left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
          top: Math.min(rect.bottom + 8, window.innerHeight - 250),
        });
      }
    }
    setOpen((value) => !value);
  };

  const select = (mode: NoteWorkspaceLayoutMode | "focus") => {
    if (mode === "focus") {
      actions.setEditorFullscreen(true);
    } else {
      actions.setEditorFullscreen(false);
      actions.setNoteWorkspaceLayoutMode(mode);
    }
    setOpen(false);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        className={cn(
          "flex shrink-0 items-center justify-center rounded-md text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary",
          compact ? "h-7 gap-1 px-1.5" : "h-8 w-8",
        )}
        title={t("workspaceLayout.title", { defaultValue: "布局模式" })}
        aria-label={t("workspaceLayout.title", { defaultValue: "布局模式" })}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="note-workspace-layout-trigger"
      >
        {current === "focus" ? <Maximize2 size={15} /> : current === "three-column" ? <PanelLeft size={15} /> : <PanelLeftClose size={15} />}
        {compact && <ChevronDown size={12} />}
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={t("workspaceLayout.title", { defaultValue: "布局模式" })}
          className="fixed z-[100] w-[304px] overflow-hidden rounded-xl border border-app-border bg-app-elevated p-1.5 shadow-2xl"
          style={position}
          data-testid="note-workspace-layout-menu"
        >
          <div className="px-2.5 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-tx-tertiary">
            {t("workspaceLayout.title", { defaultValue: "布局模式" })}
          </div>
          {choices.map((choice) => {
            const selected = current === choice.id;
            return (
              <button
                key={choice.id}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => select(choice.id)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left transition-colors",
                  selected ? "bg-accent-primary/10 text-tx-primary" : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
                )}
              >
                <span className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border",
                  selected ? "border-accent-primary/30 bg-accent-primary/10 text-accent-primary" : "border-app-border bg-app-bg text-tx-tertiary",
                )}>
                  {choice.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {choice.title}
                    <span className="flex h-3.5 w-12 overflow-hidden rounded-[3px] border border-app-border bg-app-bg">
                      {Array.from({ length: choice.previewColumns }).map((_, index) => (
                        <span
                          key={index}
                          className={cn("h-full flex-1", index > 0 && "border-l border-app-border", index === choice.previewColumns - 1 && "bg-accent-primary/10")}
                        />
                      ))}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-xs leading-5 text-tx-tertiary">{choice.description}</span>
                </span>
                <span className="flex h-5 w-5 shrink-0 items-center justify-center text-accent-primary">
                  {selected && <Check size={15} />}
                </span>
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
'''
write("frontend/src/components/NoteWorkspaceLayoutMenu.tsx", layout_menu)

layout_tests = '''import { beforeEach, describe, expect, it } from "vitest";
import {
  NOTE_WORKSPACE_LAYOUT_STORAGE_KEY,
  THREE_COLUMN_MIN_VIEWPORT_WIDTH,
  loadNoteWorkspaceLayoutMode,
  persistNoteWorkspaceLayoutMode,
  resolveNoteWorkspaceVisibility,
} from "@/lib/noteWorkspaceLayout";

describe("note workspace layout", () => {
  beforeEach(() => localStorage.clear());

  it("migrates the previous note-list collapsed preference", () => {
    expect(loadNoteWorkspaceLayoutMode(true)).toBe("standard");
    expect(loadNoteWorkspaceLayoutMode(false)).toBe("three-column");
  });

  it("persists an explicit layout preference", () => {
    persistNoteWorkspaceLayoutMode("standard");
    expect(localStorage.getItem(NOTE_WORKSPACE_LAYOUT_STORAGE_KEY)).toBe("standard");
    expect(loadNoteWorkspaceLayoutMode(false)).toBe("standard");
  });

  it("shows the middle list only when three-column mode has enough width", () => {
    expect(resolveNoteWorkspaceVisibility({
      mode: "three-column",
      noteListCollapsed: false,
      editorFullscreen: false,
      viewportWidth: THREE_COLUMN_MIN_VIEWPORT_WIDTH,
      splitDirection: null,
    })).toEqual({ showNoteList: true, autoCollapseReason: null });
  });

  it("automatically falls back on narrow windows without changing the preference", () => {
    expect(resolveNoteWorkspaceVisibility({
      mode: "three-column",
      noteListCollapsed: false,
      editorFullscreen: false,
      viewportWidth: THREE_COLUMN_MIN_VIEWPORT_WIDTH - 1,
      splitDirection: null,
    })).toEqual({ showNoteList: false, autoCollapseReason: "viewport" });
  });

  it("hides the middle list for right editor split and focus mode", () => {
    expect(resolveNoteWorkspaceVisibility({
      mode: "three-column",
      noteListCollapsed: false,
      editorFullscreen: false,
      viewportWidth: 1920,
      splitDirection: "right",
    }).autoCollapseReason).toBe("right-split");

    expect(resolveNoteWorkspaceVisibility({
      mode: "three-column",
      noteListCollapsed: false,
      editorFullscreen: true,
      viewportWidth: 1920,
      splitDirection: null,
    }).showNoteList).toBe(false);
  });
});
'''
write("frontend/src/lib/__tests__/noteWorkspaceLayout.test.ts", layout_tests)

menu_tests = '''import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({
  setEditorFullscreen: vi.fn(),
  setNoteWorkspaceLayoutMode: vi.fn(),
}));
const state = vi.hoisted(() => ({
  editorFullscreen: false,
  noteWorkspaceLayoutMode: "standard" as "standard" | "three-column",
}));

vi.mock("@/store/AppContext", () => ({
  useApp: () => ({ state }),
  useAppActions: () => actions,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue || _key,
  }),
}));

import NoteWorkspaceLayoutMenu from "@/components/NoteWorkspaceLayoutMenu";

describe("NoteWorkspaceLayoutMenu", () => {
  beforeEach(() => {
    actions.setEditorFullscreen.mockReset();
    actions.setNoteWorkspaceLayoutMode.mockReset();
    state.editorFullscreen = false;
    state.noteWorkspaceLayoutMode = "standard";
  });

  it("switches to three-column mode and exits focus mode", () => {
    render(<NoteWorkspaceLayoutMenu />);
    fireEvent.click(screen.getByRole("button", { name: "布局模式" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /三栏模式/ }));

    expect(actions.setEditorFullscreen).toHaveBeenCalledWith(false);
    expect(actions.setNoteWorkspaceLayoutMode).toHaveBeenCalledWith("three-column");
  });

  it("enters focus mode without overwriting the saved base layout", () => {
    render(<NoteWorkspaceLayoutMenu />);
    fireEvent.click(screen.getByRole("button", { name: "布局模式" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /专注模式/ }));

    expect(actions.setEditorFullscreen).toHaveBeenCalledWith(true);
    expect(actions.setNoteWorkspaceLayoutMode).not.toHaveBeenCalled();
  });
});
'''
write("frontend/src/components/__tests__/NoteWorkspaceLayoutMenu.test.tsx", menu_tests)

# AppContext: add explicit layout state while preserving legacy collapse preference.
path = "frontend/src/store/AppContext.tsx"
content = read(path)
content = replace_once(
    content,
    'import { prepareEditorSplitClose } from "@/lib/editorSplitMirror";\n',
    'import { prepareEditorSplitClose } from "@/lib/editorSplitMirror";\nimport {\n  loadNoteWorkspaceLayoutMode,\n  persistNoteWorkspaceLayoutMode,\n  type NoteWorkspaceLayoutMode,\n} from "@/lib/noteWorkspaceLayout";\n',
    "AppContext layout import",
)
content = replace_once(
    content,
    '  noteListCollapsed: boolean;\n  /** 桌面端：编辑器专注全屏。仅临时隐藏外侧导航，不改写各面板折叠偏好。 */',
    '  noteListCollapsed: boolean;\n  /** 桌面端笔记工作区基础布局；专注态继续由 editorFullscreen 临时控制。 */\n  noteWorkspaceLayoutMode: NoteWorkspaceLayoutMode;\n  /** 桌面端：编辑器专注全屏。仅临时隐藏外侧导航，不改写各面板折叠偏好。 */',
    "AppContext state field",
)
content = replace_once(
    content,
    '  | { type: "TOGGLE_NOTELIST_COLLAPSED" }\n  | { type: "SET_EDITOR_FULLSCREEN"; payload: boolean }',
    '  | { type: "TOGGLE_NOTELIST_COLLAPSED" }\n  | { type: "SET_NOTELIST_COLLAPSED"; payload: boolean }\n  | { type: "SET_NOTE_WORKSPACE_LAYOUT_MODE"; payload: NoteWorkspaceLayoutMode }\n  | { type: "SET_EDITOR_FULLSCREEN"; payload: boolean }',
    "AppContext action types",
)
content = replace_once(
    content,
    'const initialState: AppState = {',
    'const initialNoteWorkspaceLayoutMode = loadNoteWorkspaceLayoutMode(getSavedNoteListCollapsed());\n\nconst initialState: AppState = {',
    "AppContext initial layout",
)
content = replace_once(
    content,
    '  noteListCollapsed: getSavedNoteListCollapsed(),\n  editorFullscreen: false,',
    '  noteListCollapsed: initialNoteWorkspaceLayoutMode === "standard",\n  noteWorkspaceLayoutMode: initialNoteWorkspaceLayoutMode,\n  editorFullscreen: false,',
    "AppContext initial state fields",
)
old_toggle = '''    case "TOGGLE_NOTELIST_COLLAPSED": {
      const next = !state.noteListCollapsed;
      try { localStorage.setItem("nowen-notelist-collapsed", next ? "1" : "0"); } catch {}
      return { ...state, noteListCollapsed: next };
    }
'''
new_toggle = '''    case "TOGGLE_NOTELIST_COLLAPSED": {
      const next = !state.noteListCollapsed;
      const mode: NoteWorkspaceLayoutMode = next ? "standard" : "three-column";
      try { localStorage.setItem("nowen-notelist-collapsed", next ? "1" : "0"); } catch {}
      persistNoteWorkspaceLayoutMode(mode);
      return { ...state, noteListCollapsed: next, noteWorkspaceLayoutMode: mode };
    }
    case "SET_NOTELIST_COLLAPSED": {
      const next = action.payload;
      const mode: NoteWorkspaceLayoutMode = next ? "standard" : "three-column";
      try { localStorage.setItem("nowen-notelist-collapsed", next ? "1" : "0"); } catch {}
      persistNoteWorkspaceLayoutMode(mode);
      return { ...state, noteListCollapsed: next, noteWorkspaceLayoutMode: mode };
    }
    case "SET_NOTE_WORKSPACE_LAYOUT_MODE": {
      const mode = action.payload;
      const noteListCollapsed = mode === "standard";
      try { localStorage.setItem("nowen-notelist-collapsed", noteListCollapsed ? "1" : "0"); } catch {}
      persistNoteWorkspaceLayoutMode(mode);
      return { ...state, noteWorkspaceLayoutMode: mode, noteListCollapsed };
    }
'''
content = replace_once(content, old_toggle, new_toggle, "AppContext reducers")
content = replace_once(
    content,
    '    toggleNoteListCollapsed: () => dispatch({ type: "TOGGLE_NOTELIST_COLLAPSED" }),\n    setEditorFullscreen:',
    '    toggleNoteListCollapsed: () => dispatch({ type: "TOGGLE_NOTELIST_COLLAPSED" }),\n    setNoteListCollapsed: (v: boolean) => dispatch({ type: "SET_NOTELIST_COLLAPSED", payload: v }),\n    setNoteWorkspaceLayoutMode: (v: NoteWorkspaceLayoutMode) => dispatch({ type: "SET_NOTE_WORKSPACE_LAYOUT_MODE", payload: v }),\n    setEditorFullscreen:',
    "AppContext actions",
)
write(path, content)

# App: responsive degradation and right-split protection.
path = "frontend/src/App.tsx"
content = read(path)
content = replace_once(
    content,
    'import { resolveEditorFocusLayout } from "@/lib/editorFocusLayout";\n',
    'import { resolveEditorFocusLayout } from "@/lib/editorFocusLayout";\nimport { resolveNoteWorkspaceVisibility } from "@/lib/noteWorkspaceLayout";\n',
    "App layout import",
)
content = replace_once(
    content,
    '  const { prefs: userPrefs } = useUserPreferences();\n',
    '  const { prefs: userPrefs } = useUserPreferences();\n  const [viewportWidth, setViewportWidth] = useState(() => typeof window === "undefined" ? 1920 : window.innerWidth);\n  useEffect(() => {\n    const updateViewportWidth = () => setViewportWidth(window.innerWidth);\n    window.addEventListener("resize", updateViewportWidth);\n    return () => window.removeEventListener("resize", updateViewportWidth);\n  }, []);\n',
    "App viewport state",
)
old_focus = '''  const editorFocusLayout = resolveEditorFocusLayout({
    editorFullscreen: state.editorFullscreen,
    railVisible,
    sidebarCollapsed: state.sidebarCollapsed,
    noteListCollapsed: state.noteListCollapsed,
  });
'''
new_focus = '''  const noteWorkspaceVisibility = resolveNoteWorkspaceVisibility({
    mode: state.noteWorkspaceLayoutMode,
    noteListCollapsed: state.noteListCollapsed,
    editorFullscreen: state.editorFullscreen,
    viewportWidth,
    splitDirection: state.editorSplit?.direction || null,
  });
  const editorFocusLayout = resolveEditorFocusLayout({
    editorFullscreen: state.editorFullscreen,
    railVisible,
    sidebarCollapsed: state.sidebarCollapsed,
    noteListCollapsed: !noteWorkspaceVisibility.showNoteList,
  });
'''
content = replace_once(content, old_focus, new_focus, "App layout resolution")
content = replace_once(
    content,
    '<div className="flex h-[100dvh] w-screen bg-app-bg overflow-hidden transition-colors duration-200">',
    '<div\n      className="flex h-[100dvh] w-screen bg-app-bg overflow-hidden transition-colors duration-200"\n      data-note-workspace-layout={state.editorFullscreen ? "focus" : state.noteWorkspaceLayoutMode}\n      data-note-list-auto-collapse={noteWorkspaceVisibility.autoCollapseReason || undefined}\n    >',
    "App root data attributes",
)
write(path, content)

# Sidebar: expose the layout selector in the persistent desktop header.
path = "frontend/src/components/Sidebar.tsx"
content = read(path)
content = replace_once(
    content,
    'import WorkspaceSwitcher from "@/components/WorkspaceSwitcher";\n',
    'import WorkspaceSwitcher from "@/components/WorkspaceSwitcher";\nimport NoteWorkspaceLayoutMenu from "@/components/NoteWorkspaceLayoutMenu";\n',
    "Sidebar menu import",
)
content = replace_once(
    content,
    '        {variant === "desktop" && (\n          <button\n',
    '        {variant === "desktop" && (\n          <div className="flex shrink-0 items-center gap-1">\n            <NoteWorkspaceLayoutMenu />\n            <button\n',
    "Sidebar header wrapper start",
)
content = replace_once(
    content,
    '          </button>\n        )}\n      </header>',
    '            </button>\n          </div>\n        )}\n      </header>',
    "Sidebar header wrapper end",
)
write(path, content)

# Note tabs: keep layout switching reachable when the main sidebar is collapsed.
path = "frontend/src/components/NoteTabsBar.tsx"
content = read(path)
content = replace_once(
    content,
    'import { useNoteLoader } from "@/hooks/useNoteLoader";\n',
    'import { useNoteLoader } from "@/hooks/useNoteLoader";\nimport NoteWorkspaceLayoutMenu from "@/components/NoteWorkspaceLayoutMenu";\n',
    "NoteTabsBar menu import",
)
content = replace_once(
    content,
    '      <div className="flex shrink-0 items-center border-l border-app-border/70 px-1">\n        <button\n',
    '      <div className="flex shrink-0 items-center gap-0.5 border-l border-app-border/70 px-1">\n        <NoteWorkspaceLayoutMenu compact />\n        <button\n',
    "NoteTabsBar menu render",
)
write(path, content)

print("Applied desktop three-column mode implementation")
