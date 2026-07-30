import React, { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, ChevronRight, PanelLeft, Tags, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import KnowledgeTreePanel, {
  FOCUS_KNOWLEDGE_TREE_EVENT,
  KNOWLEDGE_TREE_CHANGED_EVENT,
} from "@/components/KnowledgeTreePanel";
import MobileKnowledgeTreePanel from "@/components/MobileKnowledgeTreePanel";
import { OPEN_KNOWLEDGE_TREE_EVENT } from "@/components/KnowledgeTreeDrawer";
import TagColorPopover from "@/components/TagColorPopover";
import WorkspaceSwitcher from "@/components/WorkspaceSwitcher";
import { useRailMode, nextRailMode } from "@/hooks/useRailMode";
import { useSiteSettings } from "@/hooks/useSiteSettings";
import { api } from "@/lib/api";
import { refreshKnowledgeTreeScrollbars } from "@/lib/knowledgeTreeScrollbarBridge";
import {
  DESKTOP_KNOWLEDGE_TREE_VIEW_MODE_CHANGED_EVENT,
  DESKTOP_KNOWLEDGE_TREE_VIEW_MODE_STORAGE_KEY,
  loadDesktopKnowledgeTreeViewMode,
  type DesktopKnowledgeTreeViewMode,
} from "@/lib/mobileKnowledgeTreeViewMode";
import { cn } from "@/lib/utils";
import { useApp, useAppActions } from "@/store/AppContext";

interface DeleteTagTarget {
  id: string;
  name: string;
  color: string;
}

interface TagColorTarget {
  tagId: string;
  tagName: string;
  color: string;
  x: number;
  y: number;
}

/**
 * Keep the desktop tree scrollbar discoverable even when Chromium/Windows uses
 * auto-hiding overlay scrollbars. Mobile keeps its native touch-scrolling UI.
 */
export const KNOWLEDGE_TREE_SCROLLBAR_CSS = `
[data-sidebar-variant="desktop"] [data-swipe-blocker="knowledge-tree-scroll"] {
  overflow-y: scroll !important;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: var(--pm-scrollbar) transparent;
}

[data-sidebar-variant="desktop"] [data-swipe-blocker="knowledge-tree-scroll"]::-webkit-scrollbar {
  width: 9px;
}

[data-sidebar-variant="desktop"] [data-swipe-blocker="knowledge-tree-scroll"]::-webkit-scrollbar-track {
  background: transparent;
}

[data-sidebar-variant="desktop"] [data-swipe-blocker="knowledge-tree-scroll"]::-webkit-scrollbar-thumb {
  min-height: 36px;
  border: 2.5px solid transparent;
  border-radius: 999px;
  background: var(--pm-scrollbar);
  background-clip: content-box;
  transition: border-width 140ms ease, background-color 120ms ease;
}

[data-sidebar-variant="desktop"] [data-swipe-blocker="knowledge-tree-scroll"]::-webkit-scrollbar-thumb:hover {
  border-width: 1.5px;
  background: var(--pm-scrollbar-hover);
  background-clip: content-box;
}
`;

/**
 * Unified sidebar.
 *
 * 桌面端默认保留递归目录树，并可按本地偏好切换为快捷浏览；移动端默认使用快捷浏览。
 */
export default function Sidebar({ variant = "mobile" }: { variant?: "desktop" | "mobile" } = {}) {
  const { state } = useApp();
  const actions = useAppActions();
  const { t } = useTranslation();
  const { siteConfig } = useSiteSettings();
  const [railMode, setRailMode] = useRailMode();
  const rootRef = useRef<HTMLDivElement>(null);
  const tagLongPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tagLongPressFired = useRef(false);

  const [tagsExpanded, setTagsExpanded] = useState(() => {
    try {
      const saved = localStorage.getItem("nowen-tags-expanded");
      return saved === null ? true : saved === "true";
    } catch {
      return true;
    }
  });
  const [deleteTagTarget, setDeleteTagTarget] = useState<DeleteTagTarget | null>(null);
  const [tagColorPopover, setTagColorPopover] = useState<TagColorTarget | null>(null);
  const [desktopKnowledgeTreeMode, setDesktopKnowledgeTreeMode] = useState<DesktopKnowledgeTreeViewMode>(
    () => loadDesktopKnowledgeTreeViewMode(),
  );

  useEffect(() => {
    const syncMode = () => setDesktopKnowledgeTreeMode(loadDesktopKnowledgeTreeViewMode());
    const syncStorage = (event: StorageEvent) => {
      if (event.key === DESKTOP_KNOWLEDGE_TREE_VIEW_MODE_STORAGE_KEY) syncMode();
    };
    window.addEventListener(DESKTOP_KNOWLEDGE_TREE_VIEW_MODE_CHANGED_EVENT, syncMode);
    window.addEventListener("storage", syncStorage);
    return () => {
      window.removeEventListener(DESKTOP_KNOWLEDGE_TREE_VIEW_MODE_CHANGED_EVENT, syncMode);
      window.removeEventListener("storage", syncStorage);
    };
  }, []);

  const refreshSidebarData = useCallback(async () => {
    try {
      const [notebooks, tags] = await Promise.all([api.getNotebooks(), api.getTags()]);
      actions.setNotebooks(notebooks);
      actions.setTags(tags);
    } catch (error) {
      console.error("[Sidebar] failed to refresh unified sidebar data:", error);
    }
  }, [actions]);

  useEffect(() => {
    void refreshSidebarData();
    const refresh = () => void refreshSidebarData();
    window.addEventListener("nowen:workspace-changed", refresh);
    window.addEventListener(KNOWLEDGE_TREE_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener("nowen:workspace-changed", refresh);
      window.removeEventListener(KNOWLEDGE_TREE_CHANGED_EVENT, refresh);
    };
  }, [refreshSidebarData]);

  useEffect(() => {
    if (variant !== "desktop") return;
    refreshKnowledgeTreeScrollbars();
    return () => refreshKnowledgeTreeScrollbars();
  }, [variant]);

  useEffect(() => {
    const focusKnowledgeTree = () => {
      const root = rootRef.current;
      if (!root || root.getClientRects().length === 0) return;
      requestAnimationFrame(() => window.dispatchEvent(new Event(FOCUS_KNOWLEDGE_TREE_EVENT)));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        focusKnowledgeTree();
      }
    };
    window.addEventListener(OPEN_KNOWLEDGE_TREE_EVENT, focusKnowledgeTree);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener(OPEN_KNOWLEDGE_TREE_EVENT, focusKnowledgeTree);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => () => {
    if (tagLongPressTimer.current) clearTimeout(tagLongPressTimer.current);
  }, []);

  const toggleTagsExpanded = () => {
    setTagsExpanded((current) => {
      const next = !current;
      try { localStorage.setItem("nowen-tags-expanded", String(next)); } catch {}
      return next;
    });
  };

  const openTagColor = (target: TagColorTarget) => {
    setTagColorPopover(target);
  };

  const handleTagClick = (tagId: string) => {
    if (tagLongPressFired.current) {
      tagLongPressFired.current = false;
      return;
    }

    const isCurrentlyActive = state.selectedTagIds.includes(tagId);
    actions.toggleSelectedTag(tagId);
    actions.setSelectedNotebook(null);
    const willHaveTags = isCurrentlyActive ? state.selectedTagIds.length > 1 : true;
    actions.setViewMode(willHaveTags ? "tag" : "all");
    if (variant === "mobile") actions.setMobileSidebar(false);
  };

  const deleteTag = async (target: DeleteTagTarget) => {
    setDeleteTagTarget(null);
    try {
      await api.deleteTag(target.id);
      const tags = await api.getTags();
      actions.setTags(tags);

      if (!state.selectedTagIds.includes(target.id)) return;
      const remaining = state.selectedTagIds.filter((id) => id !== target.id);
      if (remaining.length > 0) {
        actions.setSelectedTags(remaining);
      } else {
        actions.clearSelectedTags();
        if (state.viewMode === "tag") actions.setViewMode("all");
      }
    } catch (error) {
      console.error("[Sidebar] failed to delete tag:", error);
    }
  };

  return (
    <aside
      ref={rootRef}
      className="flex h-full w-full min-w-0 flex-col overflow-hidden border-r border-app-border bg-app-sidebar text-tx-primary"
      data-unified-sidebar=""
      data-sidebar-variant={variant}
    >
      {variant === "desktop" && (
        <style data-knowledge-tree-scrollbar="">{KNOWLEDGE_TREE_SCROLLBAR_CSS}</style>
      )}

      <header
        className="flex shrink-0 items-center justify-between border-b border-app-border px-4 py-3"
        style={{ paddingTop: "calc(var(--safe-area-top) + 12px)" }}
      >
        <span className="min-w-0 truncate text-sm font-semibold">{siteConfig.title || "nowen-note"}</span>
        {variant === "desktop" && (
          <button
            type="button"
            onClick={() => setRailMode(nextRailMode(railMode))}
            title={t(`sidebar.railMode.switchTo.${nextRailMode(railMode)}`)}
            aria-label={t(`sidebar.railMode.switchTo.${nextRailMode(railMode)}`)}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary"
          >
            <PanelLeft size={16} />
          </button>
        )}
      </header>

      <div className="shrink-0 px-3 py-2">
        <WorkspaceSwitcher />
      </div>

      <section className="flex min-h-0 flex-1 flex-col border-t border-app-border/60">
        <div className="shrink-0 px-4 pb-1 pt-2 text-[11px] font-medium text-tx-tertiary">
          内容
        </div>
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {variant === "mobile" ? (
            <MobileKnowledgeTreePanel />
          ) : desktopKnowledgeTreeMode === "quick" ? (
            <MobileKnowledgeTreePanel variant="desktop" />
          ) : (
            <KnowledgeTreePanel variant="desktop" />
          )}
        </div>
      </section>

      <section className="shrink-0 border-t border-app-border">
        <button
          type="button"
          onClick={toggleTagsExpanded}
          className="flex w-full items-center gap-2 px-4 py-2 text-xs font-medium text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary"
          aria-expanded={tagsExpanded}
        >
          {tagsExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <Tags size={13} />
          <span>{t("sidebar.tags")}</span>
          <span className="ml-auto tabular-nums">{state.tags.length}</span>
        </button>

        <AnimatePresence initial={false}>
          {tagsExpanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.16 }}
              className="overflow-hidden"
            >
              <div className="max-h-[min(35vh,260px)] space-y-0.5 overflow-y-auto px-2 pb-2">
                {state.tags.length === 0 ? (
                  <p className="px-2 py-1 text-[10px] text-tx-tertiary">{t("sidebar.noTags")}</p>
                ) : state.tags.map((tag) => {
                  const active = state.selectedTagIds.includes(tag.id);
                  return (
                    <div
                      key={tag.id}
                      onClick={() => handleTagClick(tag.id)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        openTagColor({
                          tagId: tag.id,
                          tagName: tag.name,
                          color: tag.color,
                          x: event.clientX,
                          y: event.clientY,
                        });
                      }}
                      onTouchStart={(event) => {
                        const touch = event.touches[0];
                        if (!touch) return;
                        tagLongPressFired.current = false;
                        if (tagLongPressTimer.current) clearTimeout(tagLongPressTimer.current);
                        tagLongPressTimer.current = setTimeout(() => {
                          tagLongPressFired.current = true;
                          openTagColor({
                            tagId: tag.id,
                            tagName: tag.name,
                            color: tag.color,
                            x: touch.clientX,
                            y: touch.clientY,
                          });
                        }, 500);
                      }}
                      onTouchMove={() => {
                        if (!tagLongPressTimer.current) return;
                        clearTimeout(tagLongPressTimer.current);
                        tagLongPressTimer.current = null;
                      }}
                      onTouchEnd={() => {
                        if (!tagLongPressTimer.current) return;
                        clearTimeout(tagLongPressTimer.current);
                        tagLongPressTimer.current = null;
                      }}
                      className={cn(
                        "group/tag flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors",
                        active
                          ? "bg-app-active text-tx-primary"
                          : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
                      )}
                    >
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} />
                      <span className="min-w-0 flex-1 truncate" title={tag.name}>{tag.name}</span>
                      <span className="relative flex h-4 w-5 shrink-0 items-center justify-center">
                        {tag.noteCount !== undefined && tag.noteCount > 0 && (
                          <span className="absolute inset-0 flex items-center justify-center text-[10px] tabular-nums text-tx-tertiary transition-opacity [@media(hover:hover)]:group-hover/tag:opacity-0">
                            {tag.noteCount}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            setDeleteTagTarget({ id: tag.id, name: tag.name, color: tag.color });
                          }}
                          title={t("common.delete")}
                          className="absolute inset-0 hidden items-center justify-center text-tx-tertiary transition-colors hover:text-accent-danger [@media(hover:hover)]:group-hover/tag:flex"
                        >
                          <X size={12} />
                        </button>
                      </span>
                    </div>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </section>

      <AnimatePresence>
        {deleteTagTarget && (
          <div className="fixed inset-0 z-[260] flex items-center justify-center p-4">
            <motion.button
              type="button"
              aria-label={t("common.close")}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
              onClick={() => setDeleteTagTarget(null)}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              className="relative w-full max-w-sm rounded-xl border border-app-border bg-app-elevated p-5 shadow-2xl"
            >
              <div className="mb-3 flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-danger/10 text-accent-danger">
                  <Trash2 size={18} />
                </span>
                <h4 className="text-base font-bold">{t("sidebar.deleteTagTitle")}</h4>
              </div>
              <p className="mb-5 flex items-center gap-2 pl-[52px] text-sm text-tx-secondary">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: deleteTagTarget.color }} />
                <span>{t("sidebar.confirmDeleteTag", { name: deleteTagTarget.name })}</span>
              </p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setDeleteTagTarget(null)}
                  className="rounded-lg px-4 py-2 text-sm text-tx-secondary hover:bg-app-hover"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  onClick={() => void deleteTag(deleteTagTarget)}
                  className="rounded-lg bg-accent-danger px-4 py-2 text-sm font-medium text-white hover:bg-accent-danger/90"
                >
                  {t("sidebar.confirmDelete")}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {tagColorPopover && (
        <TagColorPopover
          x={tagColorPopover.x}
          y={tagColorPopover.y}
          currentColor={tagColorPopover.color}
          title={tagColorPopover.tagName}
          onPick={async (color) => {
            try {
              await api.updateTag(tagColorPopover.tagId, { color });
              actions.setTags(await api.getTags());
            } catch (error) {
              console.error("[Sidebar] failed to update tag color:", error);
            }
          }}
          onClose={() => setTagColorPopover(null)}
        />
      )}
    </aside>
  );
}
