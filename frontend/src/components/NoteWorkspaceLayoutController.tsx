import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  Maximize2,
  PanelLeft,
  PanelLeftClose,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { useApp, useAppActions } from "@/store/AppContext";
import {
  detectNoteWorkspaceSurface,
  getAutomaticCollapseReason,
  loadNoteWorkspaceLayoutMode,
  persistNoteWorkspaceLayoutMode,
  supportsWideNoteWorkspaceLayout,
  type NoteWorkspaceLayoutMode,
} from "@/lib/noteWorkspaceLayout";
import { usesFunctionalNoteList } from "@/lib/unifiedTreeOnlyLayout";
import { cn } from "@/lib/utils";
import { useRailMode, type RailMode } from "@/hooks/useRailMode";
import { toast } from "@/lib/toast";

type DisplayLayoutMode = NoteWorkspaceLayoutMode | "focus";

interface LayoutChoice {
  id: DisplayLayoutMode;
  title: string;
  description: string;
  icon: React.ReactNode;
  previewColumns: number;
}

const LAYOUT_ANCHOR_SELECTOR = "[data-note-workspace-layout-anchor]";
const FOCUS_HINT_STORAGE_KEY = "nowen-note-focus-mode-hint-shown";
const NON_NOTE_WORKSPACE_VIEWS = new Set([
  "tasks",
  "mindmaps",
  "ai-chat",
  "diary",
  "files",
  "shares",
]);

function findLayoutAnchor(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLElement>(LAYOUT_ANCHOR_SELECTOR);
}

export default function NoteWorkspaceLayoutController() {
  const { state } = useApp();
  const actions = useAppActions();
  const { t } = useTranslation();
  const [surface] = useState(() => detectNoteWorkspaceSurface());
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1920 : window.innerWidth,
  );
  const wideLayoutSupported = supportsWideNoteWorkspaceLayout(surface, viewportWidth);
  const noteWorkspaceActive = wideLayoutSupported
    && !NON_NOTE_WORKSPACE_VIEWS.has(state.viewMode);
  const showLayoutControl = noteWorkspaceActive;
  const functionalListView = usesFunctionalNoteList(state.viewMode);
  const [preferredMode, setPreferredMode] = useState<NoteWorkspaceLayoutMode>(() =>
    loadNoteWorkspaceLayoutMode(state.noteListCollapsed),
  );
  const [railMode, setRailMode] = useRailMode();
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(() =>
    wideLayoutSupported ? findLayoutAnchor() : null,
  );
  const activePortalTarget = !portalTarget?.isConnected ? null : portalTarget;
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ left: 8, top: 44 });
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const observedCollapsedRef = useRef(state.noteListCollapsed);
  const expectedCollapsedRef = useRef<boolean | null>(null);

  // Favorites, tags, search and Trash are result-set surfaces. They require the
  // middle list even when the saved everyday workspace mode is "standard".
  // Leaving those views restores the user's standard/three-column preference.
  const automaticCollapseReason = noteWorkspaceActive && !functionalListView
    ? getAutomaticCollapseReason({
      editorFullscreen: state.editorFullscreen,
      viewportWidth,
      splitDirection: state.editorSplit?.direction || null,
    })
    : null;
  const currentMode: DisplayLayoutMode = state.editorFullscreen ? "focus" : preferredMode;

  const choices = useMemo<LayoutChoice[]>(() => [
    {
      id: "standard",
      title: t("workspaceLayout.standard", { defaultValue: "标准模式" }),
      description: t("workspaceLayout.standardDescription", {
        defaultValue: "知识结构与编辑器，保留更宽的写作区域",
      }),
      icon: <PanelLeftClose size={16} />,
      previewColumns: 2,
    },
    {
      id: "three-column",
      title: t("workspaceLayout.threeColumn", { defaultValue: "三栏模式" }),
      description: t("workspaceLayout.threeColumnDescription", {
        defaultValue: "知识结构、笔记列表和编辑器；窄窗口自动降级",
      }),
      icon: <PanelLeft size={16} />,
      previewColumns: 3,
    },
    {
      id: "focus",
      title: t("workspaceLayout.focus", { defaultValue: "专注模式" }),
      description: t("workspaceLayout.focusDescription", {
        defaultValue: "只显示编辑器，隐藏外侧导航",
      }),
      icon: <Maximize2 size={16} />,
      previewColumns: 1,
    },
  ], [t]);

  useEffect(() => {
    if (!wideLayoutSupported) return;
    const update = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [wideLayoutSupported]);

  useEffect(() => {
    if (!wideLayoutSupported) return;
    const updateTarget = () => setPortalTarget(findLayoutAnchor());
    updateTarget();
    const observer = new MutationObserver(updateTarget);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [wideLayoutSupported]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (triggerRef.current?.contains(event.target as Node)) return;
      if (menuRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!noteWorkspaceActive) return;
    const automatic = automaticCollapseReason !== null;
    const forceExpanded = functionalListView;
    const collapsedChanged = observedCollapsedRef.current !== state.noteListCollapsed;

    if (collapsedChanged) {
      observedCollapsedRef.current = state.noteListCollapsed;
      if (expectedCollapsedRef.current === state.noteListCollapsed) {
        expectedCollapsedRef.current = null;
      } else if (!automatic && !forceExpanded) {
        // A change not requested by this controller is treated as the user's
        // legacy expand/collapse action and becomes the new saved base mode.
        const inferredMode: NoteWorkspaceLayoutMode = state.noteListCollapsed
          ? "standard"
          : "three-column";
        if (inferredMode !== preferredMode) {
          setPreferredMode(inferredMode);
          persistNoteWorkspaceLayoutMode(inferredMode);
        }
        return;
      }
    }

    const desiredCollapsed = forceExpanded
      ? false
      : automatic || preferredMode === "standard";
    if (
      state.noteListCollapsed !== desiredCollapsed
      && expectedCollapsedRef.current !== desiredCollapsed
    ) {
      expectedCollapsedRef.current = desiredCollapsed;
      actions.toggleNoteListCollapsed();
    }
  }, [
    actions,
    automaticCollapseReason,
    functionalListView,
    noteWorkspaceActive,
    preferredMode,
    state.noteListCollapsed,
  ]);

  useEffect(() => {
    if (!showLayoutControl && open) setOpen(false);
  }, [open, showLayoutControl]);

  useEffect(() => {
    if (!noteWorkspaceActive || !state.editorFullscreen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      actions.setEditorFullscreen(false);
    };

    document.addEventListener("keydown", onKeyDown);
    try {
      if (localStorage.getItem(FOCUS_HINT_STORAGE_KEY) !== "1") {
        toast.info(t("workspaceLayout.focusHint", {
          defaultValue: "已进入专注模式，按 Esc 退出",
        }), 3200);
        localStorage.setItem(FOCUS_HINT_STORAGE_KEY, "1");
      }
    } catch {
      // Restricted storage should not prevent focus mode or its keyboard exit.
    }

    return () => document.removeEventListener("keydown", onKeyDown);
  }, [actions, noteWorkspaceActive, state.editorFullscreen, t]);

  const toggleMenu = () => {
    if (!open) {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) {
        const menuWidth = 304;
        setMenuPosition({
          left: Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8)),
          top: Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - 366)),
        });
      }
    }
    setOpen((value) => !value);
  };

  const selectMode = (mode: DisplayLayoutMode) => {
    if (mode === "focus") {
      actions.setEditorFullscreen(true);
      setOpen(false);
      return;
    }

    setPreferredMode(mode);
    persistNoteWorkspaceLayoutMode(mode);
    if (state.sidebarCollapsed) actions.toggleSidebar();
    actions.setEditorFullscreen(false);
    setOpen(false);
  };

  if (!showLayoutControl || state.editorFullscreen) return null;

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      onClick={toggleMenu}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary",
        activePortalTarget
          ? "h-full w-full"
          : "h-9 gap-2 border border-app-border bg-app-elevated px-3 text-sm shadow-lg",
      )}
      title={t("workspaceLayout.trigger", { defaultValue: "布局与侧栏" })}
      aria-label={t("workspaceLayout.trigger", { defaultValue: "布局与侧栏" })}
      aria-haspopup="menu"
      aria-expanded={open}
      data-testid="note-workspace-layout-trigger"
      data-note-workspace-surface={surface}
    >
      {currentMode === "three-column" ? (
        <PanelLeft size={15} />
      ) : (
        <PanelLeftClose size={15} />
      )}
      {!activePortalTarget && (
        <span>{t("workspaceLayout.trigger", { defaultValue: "布局与侧栏" })}</span>
      )}
    </button>
  );

  return (
    <>
      {activePortalTarget
        ? createPortal(trigger, activePortalTarget)
        : createPortal(
          <div className="fixed left-3 top-2 z-[70] hidden md:block">{trigger}</div>,
          document.body,
        )}
      {open && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={t("workspaceLayout.title", { defaultValue: "布局模式" })}
          className="fixed z-[100] w-[304px] overflow-hidden rounded-xl border border-app-border bg-app-elevated p-1.5 shadow-2xl"
          style={menuPosition}
          data-testid="note-workspace-layout-menu"
          data-note-workspace-surface={surface}
        >
          <div className="px-2.5 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-tx-tertiary">
            {t("workspaceLayout.title", { defaultValue: "布局模式" })}
          </div>
          {choices.map((choice) => {
            const selected = currentMode === choice.id;
            const disabled = choice.id === "focus" && !state.activeNote;
            return (
              <button
                key={choice.id}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                aria-disabled={disabled}
                disabled={disabled}
                title={disabled
                  ? t("workspaceLayout.focusRequiresNote", {
                    defaultValue: "选择一篇笔记后可进入专注模式",
                  })
                  : undefined}
                onClick={() => selectMode(choice.id)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left transition-colors",
                  disabled
                    ? "cursor-not-allowed text-tx-tertiary opacity-50"
                    : selected
                    ? "bg-accent-primary/10 text-tx-primary"
                    : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
                )}
              >
                <span className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border",
                  selected
                    ? "border-accent-primary/30 bg-accent-primary/10 text-accent-primary"
                    : "border-app-border bg-app-bg text-tx-tertiary",
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
                          className={cn(
                            "h-full flex-1",
                            index > 0 && "border-l border-app-border",
                            index === choice.previewColumns - 1 && "bg-accent-primary/10",
                          )}
                        />
                      ))}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-xs leading-5 text-tx-tertiary">
                    {disabled
                      ? t("workspaceLayout.focusRequiresNote", {
                        defaultValue: "选择一篇笔记后可进入专注模式",
                      })
                      : choice.description}
                  </span>
                </span>
                <span className="flex h-5 w-5 shrink-0 items-center justify-center text-accent-primary">
                  {selected && <Check size={15} />}
                </span>
              </button>
            );
          })}
          {automaticCollapseReason && preferredMode === "three-column" && (
            <div className="mx-2 mt-1 rounded-lg bg-amber-500/10 px-2.5 py-2 text-xs leading-5 text-amber-600 dark:text-amber-400">
              {automaticCollapseReason === "viewport"
                ? t("workspaceLayout.narrowFallback", { defaultValue: "当前窗口较窄，笔记列表已暂时收起；扩大窗口后会自动恢复。" })
                : automaticCollapseReason === "right-split"
                  ? t("workspaceLayout.splitFallback", { defaultValue: "左右分屏期间笔记列表会暂时收起，关闭分屏后自动恢复。" })
                  : t("workspaceLayout.focusFallback", { defaultValue: "退出专注模式后会恢复之前的布局。" })}
            </div>
          )}
          <div className="mx-2 mt-1 border-t border-app-border/70 pt-2">
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-tx-tertiary">
              {t("workspaceLayout.railTitle", { defaultValue: "快捷栏显示" })}
            </div>
            <div className="grid grid-cols-3 gap-1 rounded-lg bg-app-bg p-1" role="radiogroup">
              {(["icon", "label", "hidden"] as RailMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={railMode === mode}
                  onClick={() => {
                    setRailMode(mode);
                    setOpen(false);
                  }}
                  className={cn(
                    "rounded-md px-2 py-1.5 text-xs transition-colors",
                    railMode === mode
                      ? "bg-app-elevated font-medium text-tx-primary shadow-sm"
                      : "text-tx-tertiary hover:text-tx-primary",
                  )}
                >
                  {t(`workspaceLayout.rail.${mode}`, {
                    defaultValue: mode === "icon" ? "仅图标" : mode === "label" ? "图标与文字" : "隐藏",
                  })}
                </button>
              ))}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
