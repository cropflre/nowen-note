import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronDown,
  Maximize2,
  PanelLeft,
  PanelLeftClose,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { useApp, useAppActions } from "@/store/AppContext";
import {
  getAutomaticCollapseReason,
  loadNoteWorkspaceLayoutMode,
  persistNoteWorkspaceLayoutMode,
  type NoteWorkspaceLayoutMode,
} from "@/lib/noteWorkspaceLayout";
import { cn } from "@/lib/utils";

type DisplayLayoutMode = NoteWorkspaceLayoutMode | "focus";

interface LayoutChoice {
  id: DisplayLayoutMode;
  title: string;
  description: string;
  icon: React.ReactNode;
  previewColumns: number;
}

const DESKTOP_SIDEBAR_HEADER_SELECTOR =
  '[data-unified-sidebar][data-sidebar-variant="desktop"] > header';
const NON_NOTE_WORKSPACE_VIEWS = new Set([
  "tasks",
  "mindmaps",
  "ai-chat",
  "diary",
  "files",
  "shares",
]);

function findDesktopHeader(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLElement>(DESKTOP_SIDEBAR_HEADER_SELECTOR);
}

export default function NoteWorkspaceLayoutController() {
  const { state } = useApp();
  const actions = useAppActions();
  const { t } = useTranslation();
  const noteWorkspaceActive = !NON_NOTE_WORKSPACE_VIEWS.has(state.viewMode);
  const [preferredMode, setPreferredMode] = useState<NoteWorkspaceLayoutMode>(() =>
    loadNoteWorkspaceLayoutMode(state.noteListCollapsed),
  );
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1920 : window.innerWidth,
  );
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(() => findDesktopHeader());
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ left: 8, top: 44 });
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const observedCollapsedRef = useRef(state.noteListCollapsed);
  const expectedCollapsedRef = useRef<boolean | null>(null);

  const automaticCollapseReason = noteWorkspaceActive
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
    const update = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    const updateTarget = () => setPortalTarget(findDesktopHeader());
    updateTarget();
    const observer = new MutationObserver(updateTarget);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!portalTarget || !noteWorkspaceActive) return;
    const previousPosition = portalTarget.style.position;
    const previousPaddingRight = portalTarget.style.paddingRight;
    portalTarget.style.position = "relative";
    portalTarget.style.paddingRight = "5rem";
    return () => {
      portalTarget.style.position = previousPosition;
      portalTarget.style.paddingRight = previousPaddingRight;
    };
  }, [noteWorkspaceActive, portalTarget]);

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
    const collapsedChanged = observedCollapsedRef.current !== state.noteListCollapsed;

    if (collapsedChanged) {
      observedCollapsedRef.current = state.noteListCollapsed;
      if (expectedCollapsedRef.current === state.noteListCollapsed) {
        expectedCollapsedRef.current = null;
      } else if (!automatic) {
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

    const desiredCollapsed = automatic || preferredMode === "standard";
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
    noteWorkspaceActive,
    preferredMode,
    state.noteListCollapsed,
  ]);

  useEffect(() => {
    if (!noteWorkspaceActive && open) setOpen(false);
  }, [noteWorkspaceActive, open]);

  const toggleMenu = () => {
    if (!open) {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) {
        const menuWidth = 304;
        setMenuPosition({
          left: Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8)),
          top: Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - 246)),
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
    actions.setEditorFullscreen(false);
    setOpen(false);
  };

  if (!noteWorkspaceActive) return null;

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      onClick={toggleMenu}
      className={cn(
        "flex h-8 shrink-0 items-center justify-center rounded-md text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary",
        portalTarget
          ? "absolute right-11 top-1/2 z-10 w-8 -translate-y-1/2"
          : "gap-1 border border-app-border bg-app-elevated px-2 shadow-lg",
      )}
      title={t("workspaceLayout.title", { defaultValue: "布局模式" })}
      aria-label={t("workspaceLayout.title", { defaultValue: "布局模式" })}
      aria-haspopup="menu"
      aria-expanded={open}
      data-testid="note-workspace-layout-trigger"
    >
      {currentMode === "focus" ? (
        <Maximize2 size={15} />
      ) : currentMode === "three-column" ? (
        <PanelLeft size={15} />
      ) : (
        <PanelLeftClose size={15} />
      )}
      {!portalTarget && <ChevronDown size={12} />}
    </button>
  );

  return (
    <>
      {portalTarget
        ? createPortal(trigger, portalTarget)
        : createPortal(
          <div className="fixed right-3 top-2 z-[70] hidden md:block">{trigger}</div>,
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
        >
          <div className="px-2.5 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-tx-tertiary">
            {t("workspaceLayout.title", { defaultValue: "布局模式" })}
          </div>
          {choices.map((choice) => {
            const selected = currentMode === choice.id;
            return (
              <button
                key={choice.id}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => selectMode(choice.id)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left transition-colors",
                  selected
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
                    {choice.description}
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
        </div>,
        document.body,
      )}
    </>
  );
}
