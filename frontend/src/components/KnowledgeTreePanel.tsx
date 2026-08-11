import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  CircleAlert,
  FileCode,
  FileText,
  Folder,
  Loader2,
  LockKeyhole,
  MoreHorizontal,
  Pin,
  Plus,
  RefreshCw,
  Search,
  SplitSquareHorizontal,
  SplitSquareVertical,
  Star,
  Trash2,
  TreePine,
  X,
} from "lucide-react";

import FolderPasswordDialog from "@/components/FolderPasswordDialog";
import {
  KnowledgeTreeBatchMovePanel,
  KnowledgeTreeBatchToolbar,
} from "@/components/KnowledgeTreeBatchActions";
import KnowledgeTreeDropdownMenu from "@/components/KnowledgeTreeDropdownMenu";
import KnowledgeSearchScopeMenuButton from "@/components/KnowledgeSearchScopeMenuButton";
import KnowledgeSearchScopeSwitch from "@/components/KnowledgeSearchScopeSwitch";
import KnowledgeTreeNodeMenu from "@/components/KnowledgeTreeNodeMenu";
import KnowledgeTreePermissionsDialog from "@/components/KnowledgeTreePermissionsDialog";
import {
  importMarkdownIntoKnowledgeTree,
  importMarkdownZipIntoKnowledgeTree,
  importWeChatArticleIntoKnowledgeTree,
  importWordIntoKnowledgeTree,
} from "@/components/knowledgeTreeImport";
import { choose, confirm, prompt } from "@/components/ui/confirm";
import { useContextMenu } from "@/hooks/useContextMenu";
import { api } from "@/lib/api";
import { affectedKnowledgeNoteIds } from "@/lib/knowledgeTreeDeleteReconcile";
import {
  knowledgeTreeRangeSelection,
  topLevelSelectedKnowledgeNodes,
} from "@/lib/knowledgeTreeMultiSelect";
import {
  defaultInlineCreateTitle,
  normalizeInlineCreateTitle,
  type KnowledgeTreeInlineCreateKind,
  type KnowledgeTreeInlineDraft,
} from "@/lib/knowledgeTreeInlineCreate";
import {
  loadMobileKnowledgeTreeRecentEntries,
  saveMobileKnowledgeTreeRecentEntries,
  upsertMobileKnowledgeTreeRecentEntry,
} from "@/lib/mobileKnowledgeTree";
import {
  knowledgeTreeApi,
  type KnowledgeTreeNode,
} from "@/lib/knowledgeTreeApi";
import {
  getKnowledgeTreeExpansionScope,
  getKnowledgeTreeExpansionSnapshot,
  initializeKnowledgeTreeExpansion,
  saveKnowledgeTreeExpansion,
  subscribeKnowledgeTreeExpansion,
} from "@/lib/knowledgeTreeExpansion";
import {
  forgetUnlockedFolder,
  hideLockedFolderDescendants,
  isFolderUnlocked,
  KNOWLEDGE_TREE_PASSWORD_SESSION_CHANGED_EVENT,
  loadUnlockedFolderIds,
  rememberUnlockedFolder,
} from "@/lib/knowledgeTreePassword";
import {
  buildFirstLevelNoteCounts,
  countOwnedNotes,
} from "@/lib/knowledgeTreeStats";
import { toast } from "@/lib/toast";
import {
  compareKnowledgeTreePinnedPriority,
  KNOWLEDGE_TREE_SORT_OPTIONS,
  loadKnowledgeTreeSortMode,
  planKnowledgeTreeSiblingReorder,
  saveKnowledgeTreeSortMode,
  type KnowledgeTreeSiblingDropPlacement,
} from "@/lib/knowledgeTreeSort";
import {
  detectNoteWorkspaceSurface,
  usesThreeColumnFolderNavigation,
  type NoteWorkspaceLayoutMode,
} from "@/lib/noteWorkspaceLayout";
import {
  KNOWLEDGE_TREE_OPEN_FOLDER_EVENT,
  type KnowledgeTreeOpenFolderDetail,
} from "@/lib/threeColumnFolderContents";
import { cn } from "@/lib/utils";
import {
  filterKnowledgeTreeNodes,
  isSharedRoot,
} from "@/lib/sharedKnowledgeTree";
import { useApp, useAppActions } from "@/store/AppContext";

export const FOCUS_KNOWLEDGE_TREE_EVENT = "nowen:focus-knowledge-tree";
export const KNOWLEDGE_TREE_CHANGED_EVENT = "nowen:knowledge-tree-changed";
const DESKTOP_COMPACT_TOOLBAR_WIDTH = 280;

function buildChildren(nodes: KnowledgeTreeNode[]) {
  const result = new Map<string | null, KnowledgeTreeNode[]>();
  for (const node of nodes) {
    const siblings = result.get(node.parentId) || [];
    siblings.push(node);
    result.set(node.parentId, siblings);
  }
  for (const siblings of result.values()) {
    siblings.sort((a, b) => (
      compareKnowledgeTreePinnedPriority(a, b)
      || a.sortOrder - b.sortOrder
      || a.title.localeCompare(b.title)
      || a.id.localeCompare(b.id)
    ));
  }
  return result;
}

function nodeIcon(node: KnowledgeTreeNode) {
  if (node.nodeType === "folder") {
    return node.icon
      ? <span className="w-[15px] shrink-0 text-center text-sm leading-none">{node.icon}</span>
      : <Folder size={15} className="text-amber-500" />;
  }
  if (node.nodeType === "markdown") return <FileCode size={15} className="text-emerald-500" />;
  return <FileText size={15} className="text-accent-primary" />;
}

function draftIcon(kind: KnowledgeTreeInlineCreateKind) {
  if (kind === "folder") return <Folder size={15} className="text-amber-500" />;
  if (kind === "markdown") return <FileCode size={15} className="text-emerald-500" />;
  return <FileText size={15} className="text-accent-primary" />;
}

function descendantsOf(nodeId: string, children: Map<string | null, KnowledgeTreeNode[]>) {
  const result = new Set<string>();
  const visit = (parentId: string) => {
    for (const child of children.get(parentId) || []) {
      if (result.has(child.id)) continue;
      result.add(child.id);
      visit(child.id);
    }
  };
  visit(nodeId);
  return result;
}

function emitTreeChanged(reason: string) {
  window.dispatchEvent(new CustomEvent(KNOWLEDGE_TREE_CHANGED_EVENT, { detail: { reason } }));
}

function useActiveSidebarSurface(variant: "desktop" | "mobile") {
  const mediaQuery = variant === "desktop" ? "(min-width: 768px)" : "(max-width: 767px)";
  const [active, setActive] = useState(() =>
    typeof window === "undefined" ? variant === "desktop" : window.matchMedia(mediaQuery).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(mediaQuery);
    const update = () => setActive(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [mediaQuery]);

  return active;
}

function MovePanel({
  node,
  nodes,
  children,
  onMoved,
  onClose,
}: {
  node: KnowledgeTreeNode;
  nodes: KnowledgeTreeNode[];
  children: Map<string | null, KnowledgeTreeNode[]>;
  onMoved: () => void;
  onClose: () => void;
}) {
  const blocked = useMemo(() => {
    const result = descendantsOf(node.id, children);
    result.add(node.id);
    return result;
  }, [children, node.id]);
  const candidates = nodes.filter((candidate) =>
    !blocked.has(candidate.id)
    && candidate.access.capabilities.canCreate
    && (node.sharedRootId
      ? candidate.sharedRootId === node.sharedRootId
      : !candidate.sharedRootId),
  );
  const allowRoot = !node.sharedRootId;

  const move = async (parentId: string | null) => {
    if ((node.parentId ?? null) === parentId) {
      onClose();
      return;
    }
    try {
      await knowledgeTreeApi.move(node.id, { parentId });
      emitTreeChanged("node-moved");
      toast.success("已移动");
      onMoved();
      onClose();
    } catch (error: any) {
      toast.error(error?.message || "移动失败");
    }
  };

  return (
    <div className="absolute inset-0 z-[220] flex flex-col bg-app-sidebar">
      <header className="flex h-11 items-center gap-2 border-b border-app-border px-3">
        <Folder size={16} className="text-amber-500" />
        <div className="min-w-0 flex-1 truncate text-sm font-semibold text-tx-primary">移动“{node.title}”</div>
        <button type="button" onClick={onClose} className="rounded-md p-1.5 text-tx-tertiary hover:bg-app-hover" aria-label="关闭移动面板"><X size={16} /></button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {allowRoot && (
          <button
            type="button"
            disabled={node.parentId === null}
            onClick={() => void move(null)}
            className="mb-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-tx-secondary hover:bg-app-hover hover:text-tx-primary disabled:cursor-not-allowed disabled:opacity-40"
          >
            <TreePine size={14} className="text-accent-primary" /><span className="truncate">根目录</span>
          </button>
        )}
        {candidates.map((candidate) => (
          <button key={candidate.id} type="button" onClick={() => void move(candidate.id)} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-tx-secondary hover:bg-app-hover hover:text-tx-primary">
            {nodeIcon(candidate)}<span className="truncate">{candidate.title}</span>
          </button>
        ))}
        {candidates.length === 0 && node.parentId === null && <p className="py-10 text-center text-xs text-tx-tertiary">没有可用目标节点</p>}
      </div>
    </div>
  );
}

export interface KnowledgeTreePanelProps {
  variant?: "desktop" | "mobile";
  className?: string;
  createRequest?: KnowledgeTreeInlineCreateRequest;
  importRequest?: KnowledgeTreeImportRequest;
  showAllNotesToolbar?: boolean;
  layoutMode?: NoteWorkspaceLayoutMode;
}

export interface KnowledgeTreeInlineCreateRequest {
  requestId: number;
  parentId: string | null;
  kind: KnowledgeTreeInlineCreateKind;
}

export interface KnowledgeTreeImportRequest {
  requestId: number;
  parentId: string | null;
  kind: "markdown" | "markdown-zip" | "word" | "wechat";
}

export function KnowledgeTreePanel({
  variant = "desktop",
  className,
  createRequest,
  importRequest,
  showAllNotesToolbar = true,
  layoutMode = "standard",
}: KnowledgeTreePanelProps) {
  const { state } = useApp();
  const actions = useAppActions();
  const threeColumnFolderNavigation = usesThreeColumnFolderNavigation({
    mode: layoutMode,
    noteListCollapsed: state.noteListCollapsed,
    desktopSurface: variant === "desktop",
  });
  const [workspaceSurface] = useState(() => detectNoteWorkspaceSurface());
  const surfaceActive = useActiveSidebarSurface(variant);
  const rootRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const draftInputRef = useRef<HTMLInputElement>(null);
  const handledCreateRequestRef = useRef<number | null>(null);
  const handledImportRequestRef = useRef<number | null>(null);
  const mobileActionsButtonRef = useRef<HTMLButtonElement>(null);
  const [nodes, setNodes] = useState<KnowledgeTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sharedLoadError, setSharedLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState(() => state.viewMode === "search" ? state.searchQuery : "");
  const [draft, setDraft] = useState<KnowledgeTreeInlineDraft | null>(null);
  const [permissionsNode, setPermissionsNode] = useState<KnowledgeTreeNode | null>(null);
  const [movingNode, setMovingNode] = useState<KnowledgeTreeNode | null>(null);
  const [batchMoving, setBatchMoving] = useState(false);
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(() => new Set());
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [unlockedFolderIds, setUnlockedFolderIds] = useState<Set<string>>(() => loadUnlockedFolderIds());
  const [passwordDialog, setPasswordDialog] = useState<{ node: KnowledgeTreeNode; mode: "unlock" | "manage" } | null>(null);
  const [pendingFolderAction, setPendingFolderAction] = useState<{
    nodeId: string;
    action: "select" | "toggle";
  } | null>(null);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const [compactDesktopToolbar, setCompactDesktopToolbar] = useState(false);
  const [treeDropTarget, setTreeDropTarget] = useState<{
    nodeId: string;
    placement: KnowledgeTreeSiblingDropPlacement;
  } | null>(null);
  const draggedTreeNodeIdRef = useRef<string | null>(null);
  const selectionAnchorRef = useRef<string | null>(null);
  const { menu, menuRef, openMenu, openMenuAt, closeMenu } = useContextMenu();
  const longPressRef = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const menuNode = menu.targetId ? nodes.find((candidate) => candidate.id === menu.targetId) || null : null;
  const expansionScope = getKnowledgeTreeExpansionScope();
  const subscribeExpansion = useCallback(
    (listener: () => void) => subscribeKnowledgeTreeExpansion(expansionScope, listener),
    [expansionScope],
  );
  const readExpansion = useCallback(
    () => getKnowledgeTreeExpansionSnapshot(expansionScope),
    [expansionScope],
  );
  const expansionSnapshot = useSyncExternalStore(subscribeExpansion, readExpansion, readExpansion);
  const expanded = useMemo(() => new Set(expansionSnapshot.expandedNodeIds), [expansionSnapshot]);

  const setNodeExpanded = useCallback((nodeId: string, opening: boolean) => {
    const next = new Set(getKnowledgeTreeExpansionSnapshot(expansionScope).expandedNodeIds);
    if (opening) next.add(nodeId); else next.delete(nodeId);
    saveKnowledgeTreeExpansion(expansionScope, next);
  }, [expansionScope]);

  const reload = useCallback(async () => {
    const requestExpansionScope = getKnowledgeTreeExpansionScope();
    setLoading(true);
    setError(null);
    try {
      const [ownedResult, sharedResult] = await Promise.allSettled([
        knowledgeTreeApi.list(),
        knowledgeTreeApi.listShared(),
      ]);
      if (ownedResult.status === "rejected") throw ownedResult.reason;
      const shared = sharedResult.status === "fulfilled" ? sharedResult.value.nodes : [];
      setSharedLoadError(
        sharedResult.status === "rejected"
          ? sharedResult.reason?.message || "加载共享内容失败"
          : null,
      );
      const merged = Array.from(
        new Map([...ownedResult.value.nodes, ...shared].map((node) => [node.id, node])).values(),
      );
      if (requestExpansionScope !== getKnowledgeTreeExpansionScope()) return;
      const folderIds = new Set(merged.filter((node) => node.nodeType === "folder").map((node) => node.id));
      setNodes(merged);
      initializeKnowledgeTreeExpansion(
        requestExpansionScope,
        merged.filter((node) => node.nodeType === "folder" && Boolean(node.isExpanded)).map((node) => node.id),
        folderIds,
        sharedResult.status === "fulfilled",
      );
    } catch (requestError: any) {
      setError(requestError?.message || "加载内容树失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (surfaceActive) void reload();
  }, [reload, surfaceActive]);

  useEffect(() => {
    if (variant !== "desktop" || workspaceSurface === "web") {
      setCompactDesktopToolbar(false);
      return;
    }
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const update = (width: number) => {
      if (width > 0) setCompactDesktopToolbar(width < DESKTOP_COMPACT_TOOLBAR_WIDTH);
    };
    update(root.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) update(entry.contentRect.width);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [variant, workspaceSurface]);

  useEffect(() => {
    if (!surfaceActive) return;
    const refresh = () => void reload();
    window.addEventListener("nowen:workspace-changed", refresh);
    window.addEventListener(KNOWLEDGE_TREE_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener("nowen:workspace-changed", refresh);
      window.removeEventListener(KNOWLEDGE_TREE_CHANGED_EVENT, refresh);
    };
  }, [reload, surfaceActive]);

  useEffect(() => {
    const syncUnlockedFolders = () => setUnlockedFolderIds(loadUnlockedFolderIds());
    window.addEventListener(KNOWLEDGE_TREE_PASSWORD_SESSION_CHANGED_EVENT, syncUnlockedFolders);
    return () => window.removeEventListener(KNOWLEDGE_TREE_PASSWORD_SESSION_CHANGED_EVENT, syncUnlockedFolders);
  }, []);

  useEffect(() => {
    if (!surfaceActive) return;
    const focus = (event: Event) => {
      const nextQuery = (event as CustomEvent<{ query?: string }>).detail?.query;
      if (typeof nextQuery === "string") setQuery(nextQuery);
      requestAnimationFrame(() => searchRef.current?.focus());
    };
    window.addEventListener(FOCUS_KNOWLEDGE_TREE_EVENT, focus);
    return () => window.removeEventListener(FOCUS_KNOWLEDGE_TREE_EVENT, focus);
  }, [surfaceActive]);

  useEffect(() => {
    if (!draft) return;
    requestAnimationFrame(() => {
      draftInputRef.current?.focus({ preventScroll: true });
      draftInputRef.current?.scrollIntoView({ block: "nearest" });
      draftInputRef.current?.select();
    });
  }, [draft?.kind, draft?.parentId]);

  const visibleNodes = useMemo(
    () => hideLockedFolderDescendants(nodes, unlockedFolderIds),
    [nodes, unlockedFolderIds],
  );
  const allChildren = useMemo(() => buildChildren(nodes), [nodes]);
  const selectedNodes = useMemo(
    () => visibleNodes.filter((node) => selectedNodeIds.has(node.id)),
    [selectedNodeIds, visibleNodes],
  );
  const topLevelSelectedNodes = useMemo(
    () => topLevelSelectedKnowledgeNodes(nodes, selectedNodeIds),
    [nodes, selectedNodeIds],
  );
  const canBatchMove = selectedNodes.length > 0 && selectedNodes.every((node) => (
    node.access.capabilities.canMove
    && !isSharedRoot(node)
    && node.scopeKey === selectedNodes[0].scopeKey
    && (node.sharedRootId || null) === (selectedNodes[0].sharedRootId || null)
  ));
  const firstLevelNoteCounts = useMemo(() => buildFirstLevelNoteCounts(visibleNodes), [visibleNodes]);
  const filteredNodes = useMemo(() => filterKnowledgeTreeNodes(visibleNodes, query), [visibleNodes, query]);
  const children = useMemo(() => buildChildren(filteredNodes), [filteredNodes]);
  const effectiveExpanded = query.trim() ? new Set(filteredNodes.map((node) => node.id)) : expanded;
  const expandableFolderIds = visibleNodes.filter((node) => (
    node.nodeType === "folder"
    && (children.get(node.id)?.length || 0) > 0
  )).map((node) => node.id);
  const hasExpandedFolders = !query.trim() && expandableFolderIds.some((id) => expanded.has(id));
  const toggleAllLabel = hasExpandedFolders ? "全部收起" : "全部展开";

  const clearSelection = useCallback(() => {
    selectionAnchorRef.current = null;
    setBatchMoving(false);
    setSelectedNodeIds(new Set());
    setMultiSelectMode(false);
  }, []);

  useEffect(() => {
    const availableIds = new Set(visibleNodes.map((node) => node.id));
    setSelectedNodeIds((current) => {
      const next = new Set([...current].filter((nodeId) => availableIds.has(nodeId)));
      return next.size === current.size ? current : next;
    });
  }, [visibleNodes]);

  useEffect(() => {
    if (!surfaceActive || (selectedNodeIds.size === 0 && !multiSelectMode)) return;
    const exitSelection = (event: KeyboardEvent) => {
      if (event.key === "Escape") clearSelection();
    };
    window.addEventListener("keydown", exitSelection);
    return () => window.removeEventListener("keydown", exitSelection);
  }, [clearSelection, multiSelectMode, selectedNodeIds.size, surfaceActive]);

  // Selecting or restoring an active note must not override the user's folder disclosure choices.
  const activateNote = useCallback((
    note: Awaited<ReturnType<typeof api.getNote>>,
    treeParentId?: string | null,
  ) => {
    actions.setActiveNote(note);
    actions.setSelectedNotebook(note.notebookId);
    actions.setSelectedKnowledgeTreeParent(treeParentId);
    actions.setViewMode("notebook");
    actions.openNoteTab({
      id: note.id,
      title: note.title,
      notebookId: note.notebookId,
      workspaceId: note.workspaceId,
      contentFormat: note.contentFormat,
      isLocked: note.isLocked,
      isTrashed: note.isTrashed,
      updatedAt: note.updatedAt,
    });
    actions.setMobileView("editor");
    if (variant === "mobile") actions.setMobileSidebar(false);
  }, [actions, variant]);

  const rememberOpened = useCallback((nodeId: string) => {
    const next = upsertMobileKnowledgeTreeRecentEntry(loadMobileKnowledgeTreeRecentEntries(), nodeId);
    saveMobileKnowledgeTreeRecentEntries(next);
  }, []);

  const toggle = async (node: KnowledgeTreeNode) => {
    const opening = !getKnowledgeTreeExpansionSnapshot(expansionScope).expandedNodeIds.includes(node.id);
    setNodeExpanded(node.id, opening);
    if (!node.sharedRootId) {
      try { await knowledgeTreeApi.update(node.id, { isExpanded: opening }); } catch { /* local navigation remains usable */ }
    }
  };

  const toggleAll = useCallback(() => {
    const expanding = !hasExpandedFolders;
    const targetIds = new Set(expandableFolderIds);
    const changedOwnedFolders = nodes.filter((node) => (
      node.nodeType === "folder"
      && targetIds.has(node.id)
      && !node.sharedRootId
    ));
    saveKnowledgeTreeExpansion(expansionScope, expanding ? targetIds : []);
    void Promise.allSettled(
      changedOwnedFolders.map((node) => knowledgeTreeApi.update(node.id, { isExpanded: expanding })),
    );
  }, [expandableFolderIds, expansionScope, hasExpandedFolders, nodes]);

  const runMobileTreeAction = useCallback((value: string) => {
    setMobileActionsOpen(false);
    if (value.startsWith("sort:")) {
      const mode = value.slice("sort:".length);
      const option = KNOWLEDGE_TREE_SORT_OPTIONS.find((candidate) => candidate.value === mode);
      if (option) saveKnowledgeTreeSortMode(option.value);
    } else if (value === "toggle") {
      toggleAll();
    } else if (value === "refresh") {
      void reload();
    } else if (value === "multi-select") {
      setMultiSelectMode(true);
      setSelectedNodeIds(new Set());
      selectionAnchorRef.current = null;
    }
  }, [reload, toggleAll]);

  const selectFolder = useCallback((node: KnowledgeTreeNode) => {
    if (node.resourceType !== "notebook") return;
    actions.setSelectedNotebook(node.resourceId);
    actions.setSelectedKnowledgeTreeParent(node.id);
    actions.clearSelectedTags();
    actions.setSearchQuery("");
    actions.setViewMode("notebook");
    actions.setMobileView("list");
    if (variant === "mobile") actions.setMobileSidebar(false);
  }, [actions, variant]);

  const openDocument = async (node: KnowledgeTreeNode) => {
    closeMenu();
    if (node.nodeType === "folder") {
      if (!isFolderUnlocked(node, unlockedFolderIds)) {
        if (threeColumnFolderNavigation) {
          setPendingFolderAction({ nodeId: node.id, action: "select" });
        } else {
          setPendingFolderAction({ nodeId: node.id, action: "toggle" });
        }
        setPasswordDialog({ node, mode: "unlock" });
        return;
      }
      if (threeColumnFolderNavigation) selectFolder(node);
      else await toggle(node);
      return;
    }
    if (node.resourceType !== "note") return;
    rememberOpened(node.id);
    try {
      activateNote(await api.getNote(node.resourceId), node.parentId);
    } catch (requestError: any) {
      toast.error(requestError?.message || "打开文档失败");
    }
  };

  const handleNodeSelection = (event: React.MouseEvent, node: KnowledgeTreeNode) => {
    if (multiSelectMode || event.ctrlKey || event.metaKey) {
      event.preventDefault();
      setSelectedNodeIds((current) => {
        const next = new Set(current);
        if (next.has(node.id)) next.delete(node.id); else next.add(node.id);
        return next;
      });
      selectionAnchorRef.current = node.id;
      return;
    }
    if (event.shiftKey) {
      event.preventDefault();
      const renderedIds = Array.from(
        rootRef.current?.querySelectorAll<HTMLElement>("[data-knowledge-tree-select-id]") || [],
      ).map((element) => element.dataset.knowledgeTreeSelectId || "").filter(Boolean);
      setSelectedNodeIds(knowledgeTreeRangeSelection(renderedIds, selectionAnchorRef.current, node.id));
      if (!selectionAnchorRef.current) selectionAnchorRef.current = node.id;
      return;
    }
    setSelectedNodeIds(new Set([node.id]));
    selectionAnchorRef.current = node.id;
    void openDocument(node);
  };

  const removeSelected = async () => {
    if (topLevelSelectedNodes.length === 0) return;
    const selectedCount = selectedNodeIds.size;
    const includesFolder = topLevelSelectedNodes.some((node) => node.nodeType === "folder");
    const accepted = await confirm({
      title: `确定将选中的 ${selectedNodeIds.size} 项移到回收站吗？`,
      description: includesFolder ? "所选文件夹中的子内容也会一起移入回收站。" : "可以稍后从回收站恢复。",
      danger: true,
      confirmText: "删除",
    });
    if (!accepted) return;
    try {
      const result = await knowledgeTreeApi.batchRemove(topLevelSelectedNodes.map((node) => node.id));
      const deletedNoteIds = affectedKnowledgeNoteIds(nodes, result.affectedNodeIds);
      for (const noteId of deletedNoteIds) {
        actions.removeNoteFromList(noteId);
        actions.removeNoteTab(noteId);
      }
      if (state.activeNote && deletedNoteIds.includes(state.activeNote.id)) actions.setActiveNote(null);
      clearSelection();
      emitTreeChanged("nodes-batch-deleted");
      actions.refreshNotebooks();
      actions.refreshNotes();
      toast.success(`已将 ${selectedCount} 项移入回收站`);
    } catch (requestError: any) {
      toast.error(requestError?.message || "批量删除失败");
    }
  };

  useEffect(() => {
    if (!surfaceActive || !threeColumnFolderNavigation) return;
    const openRequestedFolder = (event: Event) => {
      const detail = (event as CustomEvent<KnowledgeTreeOpenFolderDetail>).detail;
      const requestedNode = detail?.node
        || nodes.find((node) => node.id === (detail as any)?.nodeId);
      if (!requestedNode || requestedNode.nodeType !== "folder") return;
      void openDocument(requestedNode);
    };
    window.addEventListener(KNOWLEDGE_TREE_OPEN_FOLDER_EVENT, openRequestedFolder);
    return () => window.removeEventListener(KNOWLEDGE_TREE_OPEN_FOLDER_EVENT, openRequestedFolder);
  }, [nodes, surfaceActive, threeColumnFolderNavigation, openDocument]);

  const toggleDisclosure = async (node: KnowledgeTreeNode) => {
    closeMenu();
    if (node.nodeType === "folder" && !isFolderUnlocked(node, unlockedFolderIds)) {
      setPendingFolderAction({ nodeId: node.id, action: "toggle" });
      setPasswordDialog({ node, mode: "unlock" });
      return;
    }
    await toggle(node);
  };

  const openSplit = (node: KnowledgeTreeNode, direction: "right" | "down") => {
    if (node.resourceType !== "note") return;
    rememberOpened(node.id);
    actions.splitEditor({ noteId: node.resourceId, direction });
    closeMenu();
  };

  const patchNoteStatus = useCallback((
    nodeId: string,
    patch: Partial<Pick<KnowledgeTreeNode, "isPinned" | "isFavorite" | "isLocked">>,
  ) => {
    setNodes((current) => current.map((node) => (
      node.id === nodeId ? { ...node, ...patch } : node
    )));
  }, []);

  const startInlineCreate = useCallback((parent: KnowledgeTreeNode | null, kind: KnowledgeTreeInlineCreateKind) => {
    if (parent && !parent.access.capabilities.canCreate) return;
    if (parent && !isFolderUnlocked(parent, unlockedFolderIds)) {
      setPendingFolderAction(null);
      setPasswordDialog({ node: parent, mode: "unlock" });
      return;
    }
    closeMenu();
    setQuery("");
    if (parent) {
      setNodeExpanded(parent.id, true);
      if (!parent.sharedRootId) void knowledgeTreeApi.update(parent.id, { isExpanded: true }).catch(() => {});
    }
    setDraft({
      parentId: parent?.id || null,
      kind,
      title: defaultInlineCreateTitle(kind),
      saving: false,
      error: null,
    });
  }, [closeMenu, setNodeExpanded, unlockedFolderIds]);

  useEffect(() => {
    if (!createRequest || handledCreateRequestRef.current === createRequest.requestId) return;
    const parent = createRequest.parentId
      ? nodes.find((node) => node.id === createRequest.parentId) || null
      : null;
    if (createRequest.parentId && !parent) return;
    handledCreateRequestRef.current = createRequest.requestId;
    startInlineCreate(parent, createRequest.kind);
  }, [createRequest, nodes, startInlineCreate]);

  useEffect(() => {
    if (!importRequest || handledImportRequestRef.current === importRequest.requestId) return;
    const parent = importRequest.parentId
      ? nodes.find((node) => node.id === importRequest.parentId) || null
      : null;
    if (importRequest.parentId && !parent) return;
    handledImportRequestRef.current = importRequest.requestId;
    if (parent && !isFolderUnlocked(parent, unlockedFolderIds)) {
      setPendingFolderAction(null);
      setPasswordDialog({ node: parent, mode: "unlock" });
      return;
    }

    const runImport = async () => {
      try {
        const options = {
          parent,
          nodes,
          fallbackNotebookId: state.activeNote?.notebookId || state.selectedNotebookId || state.notebooks[0]?.id || null,
        };
        const imported = importRequest.kind === "markdown"
          ? await importMarkdownIntoKnowledgeTree(options)
          : importRequest.kind === "markdown-zip"
            ? await importMarkdownZipIntoKnowledgeTree(options)
            : importRequest.kind === "word"
              ? await importWordIntoKnowledgeTree(options)
              : await importWeChatArticleIntoKnowledgeTree(options);
        if (!imported) return;
        activateNote(imported, parent?.id || null);
        emitTreeChanged("node-imported-plus-menu");
        actions.refreshNotes();
        actions.refreshNotebooks();
      } catch (requestError: any) {
        toast.error(requestError?.message || "导入失败，请重试");
      }
    };
    void runImport();
  }, [actions, activateNote, importRequest, nodes, state.activeNote?.notebookId, state.notebooks, state.selectedNotebookId, unlockedFolderIds]);

  const commitDraft = async () => {
    if (!draft || draft.saving) return;
    const title = normalizeInlineCreateTitle(draft.title);
    if (!title) {
      setDraft((current) => current ? { ...current, error: "名称不能为空" } : null);
      requestAnimationFrame(() => draftInputRef.current?.focus());
      return;
    }

    const snapshot = { ...draft, title };
    setDraft((current) => current ? { ...current, title, saving: true, error: null } : null);

    let created: KnowledgeTreeNode;
    try {
      created = await knowledgeTreeApi.create({
        parentId: snapshot.parentId,
        nodeType: snapshot.kind,
        title,
      });
    } catch (requestError: any) {
      setDraft((current) => current ? {
        ...current,
        saving: false,
        error: requestError?.message || "创建失败，请重试",
      } : null);
      requestAnimationFrame(() => draftInputRef.current?.focus());
      return;
    }

    setDraft(null);
    if (snapshot.parentId) setNodeExpanded(snapshot.parentId, true);
    emitTreeChanged("node-created-inline");
    await reload();
    actions.refreshNotebooks();
    actions.refreshNotes();

    if (snapshot.kind === "folder") {
      toast.success("已创建文件夹");
      return;
    }

    try {
      activateNote(await api.getNote(created.resourceId), snapshot.parentId);
    } catch (requestError: any) {
      toast.error(requestError?.message || "文档已创建，但自动打开失败");
    }
  };

  const rename = async (node: KnowledgeTreeNode) => {
    closeMenu();
    const title = await prompt({ title: "重命名", defaultValue: node.title, confirmText: "保存" });
    if (title == null || !title.trim() || title.trim() === node.title) return;
    try {
      await knowledgeTreeApi.update(node.id, { title: title.trim() });
      emitTreeChanged("node-renamed");
      await reload();
      actions.refreshNotebooks();
      toast.success("已重命名");
    } catch (requestError: any) {
      toast.error(requestError?.message || "重命名失败");
    }
  };

  const remove = async (node: KnowledgeTreeNode) => {
    closeMenu();
    const hasChildren = node.childCount > 0 || (allChildren.get(node.id)?.length || 0) > 0;
    let mode: "subtree" | "promote" = "subtree";
    if (hasChildren) {
      const choice = await choose({
        title: "删除节点",
        description: `“${node.title}”包含子节点。删除会先进入回收站。`,
        danger: true,
        choices: [
          { value: "subtree", label: "删除父节点及整个子树", variant: "destructive" },
          { value: "promote", label: "仅删除父节点并提升子节点", variant: "outline" },
        ],
      });
      if (choice !== "subtree" && choice !== "promote") return;
      mode = choice;
    } else {
      const ok = await confirm({ title: "移入回收站？", description: node.title, danger: true, confirmText: "删除" });
      if (!ok) return;
    }
    try {
      const deleted = await knowledgeTreeApi.remove(node.id, mode);
      const deletedNoteIds = affectedKnowledgeNoteIds(nodes, deleted.affectedNodeIds);
      for (const noteId of deletedNoteIds) {
        actions.removeNoteFromList(noteId);
        actions.removeNoteTab(noteId);
      }
      if (state.activeNote && deletedNoteIds.includes(state.activeNote.id)) {
        actions.setActiveNote(null);
      }
      emitTreeChanged("node-deleted");
      await reload();
      actions.refreshNotebooks();
      actions.refreshNotes();
      toast.success("已移入回收站");
    } catch (requestError: any) {
      toast.error(requestError?.message || "删除失败");
    }
  };

  const canReorderWithTarget = (sourceId: string, target: KnowledgeTreeNode) => {
    const source = nodes.find((node) => node.id === sourceId);
    return Boolean(
      source
      && source.id !== target.id
      && source.access.capabilities.canMove
      && target.access.capabilities.canMove
      && (source.parentId ?? null) === (target.parentId ?? null)
      && Boolean(source.sharedRootId) === Boolean(target.sharedRootId)
      && (!source.sharedRootId || source.sharedRootId === target.sharedRootId)
      && compareKnowledgeTreePinnedPriority(source, target) === 0,
    );
  };

  const dropReorder = async (
    sourceId: string,
    target: KnowledgeTreeNode,
    placement: KnowledgeTreeSiblingDropPlacement,
  ) => {
    if (!sourceId || sourceId === target.id) return;
    const source = nodes.find((node) => node.id === sourceId);
    if (!source) return;
    if ((source.parentId ?? null) !== (target.parentId ?? null)) {
      toast.error("手动排序仅支持同级节点；调整层级请使用“移动到”");
      return;
    }
    if (!canReorderWithTarget(sourceId, target)) {
      toast.error("文件夹、置顶笔记和普通笔记请在各自分组内排序");
      return;
    }
    const plan = planKnowledgeTreeSiblingReorder(nodes, sourceId, target.id, placement);
    if (!plan) return;
    setNodes(plan.nodes);
    try {
      await knowledgeTreeApi.reorder(plan.items);
      emitTreeChanged("node-reordered");
      actions.refreshNotebooks();
      actions.refreshNotes();
      toast.success("已调整顺序");
    } catch (requestError: any) {
      void reload();
      toast.error(requestError?.message || "排序失败");
    }
  };

  const cancelLongPress = () => {
    if (!longPressRef.current) return;
    clearTimeout(longPressRef.current.timer);
    longPressRef.current = null;
  };

  const beginLongPress = (event: React.TouchEvent, node: KnowledgeTreeNode) => {
    const touch = event.touches[0];
    if (!touch) return;
    cancelLongPress();
    const x = touch.clientX;
    const y = touch.clientY;
    const timer = setTimeout(() => {
      openMenuAt(x, y, node.id, "knowledge-node");
      longPressRef.current = null;
    }, 600);
    longPressRef.current = { timer, x, y };
  };

  const moveLongPress = (event: React.TouchEvent) => {
    const current = longPressRef.current;
    const touch = event.touches[0];
    if (!current || !touch) return;
    const dx = touch.clientX - current.x;
    const dy = touch.clientY - current.y;
    if (dx * dx + dy * dy > 100) cancelLongPress();
  };

  const treeIndent = variant === "mobile" ? 12 : 16;
  const treeInset = variant === "mobile" ? 0 : 2;

  const renderDraft = (depth: number) => {
    if (!draft) return null;
    return (
      <div
        key={`inline-create:${draft.parentId ?? "root"}`}
        className={cn(
          "rounded-md bg-accent-primary/5",
          draft.error && "bg-red-500/5",
        )}
        style={{ paddingLeft: `${depth * treeIndent + treeInset}px` }}
        data-knowledge-tree-inline-create=""
      >
        <div className="flex min-w-0 items-center py-0.5">
          <span className="flex h-7 w-5 shrink-0 items-center justify-center" />
          <span className="mr-1.5 shrink-0">{draftIcon(draft.kind)}</span>
          <input
            ref={draftInputRef}
            value={draft.title}
            disabled={draft.saving}
            onChange={(event) => setDraft((current) => current ? { ...current, title: event.target.value, error: null } : null)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !draft.saving) {
                event.preventDefault();
                setDraft(null);
                return;
              }
              if (event.key === "Enter" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
                event.preventDefault();
                void commitDraft();
              }
            }}
            className={cn(
              "min-w-0 flex-1 rounded border bg-app-bg px-1.5 py-1 text-xs text-tx-primary outline-none",
              draft.error ? "border-red-500" : "border-accent-primary/60 focus:border-accent-primary",
            )}
            aria-label="新内容名称"
          />
          <button
            type="button"
            disabled={draft.saving}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void commitDraft()}
            className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-accent-primary hover:bg-accent-primary/10 disabled:opacity-50"
            title="确认创建"
            aria-label="确认创建"
          >
            {draft.saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
          </button>
          <button
            type="button"
            disabled={draft.saving}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setDraft(null)}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-tx-tertiary hover:bg-app-hover hover:text-tx-primary disabled:opacity-50"
            title="取消创建"
            aria-label="取消创建"
          >
            <X size={13} />
          </button>
        </div>
        {draft.error && <p className="pb-1 pl-7 pr-2 text-[10px] text-red-500">{draft.error}</p>}
      </div>
    );
  };

  const renderNode = (node: KnowledgeTreeNode, depth: number): React.ReactNode => {
    const childNodes = children.get(node.id) || [];
    const hasChildren = childNodes.length > 0 || node.childCount > 0 || draft?.parentId === node.id;
    const isExpanded = effectiveExpanded.has(node.id);
    const active = (
      (node.resourceType === "note" && state.activeNote?.id === node.resourceId)
      || (
        threeColumnFolderNavigation
        && node.resourceType === "notebook"
        && state.viewMode === "notebook"
        && state.selectedNotebookId === node.resourceId
      )
    );
    const selected = selectedNodeIds.has(node.id);
    const actionVisibility = multiSelectMode ? "hidden" : variant === "mobile" ? "flex" : "hidden group-hover:flex";
    const firstLevelNoteCount = depth === 0 && node.nodeType === "folder" && !node.sharedRootId && isFolderUnlocked(node, unlockedFolderIds)
      ? firstLevelNoteCounts.get(node.id) ?? 0
      : null;
    return (
      <div key={node.id}>
        <div
          className={cn(
            "group relative flex min-w-0 items-center text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
            variant === "mobile" ? "rounded-sm" : "rounded-md",
            active && "bg-app-active text-tx-primary",
            selected && "bg-accent-primary/10 text-tx-primary ring-1 ring-inset ring-accent-primary/25",
            treeDropTarget?.nodeId === node.id && treeDropTarget.placement === "before"
              && "before:absolute before:inset-x-0 before:top-0 before:z-10 before:h-0.5 before:bg-accent-primary",
            treeDropTarget?.nodeId === node.id && treeDropTarget.placement === "after"
              && "after:absolute after:inset-x-0 after:bottom-0 after:z-10 after:h-0.5 after:bg-accent-primary",
          )}
          style={{ paddingLeft: `${depth * treeIndent + treeInset}px` }}
          draggable={currentSortMode === "manual" && !query.trim() && node.access.capabilities.canMove && !isSharedRoot(node)}
          onDragStart={(event) => {
            draggedTreeNodeIdRef.current = node.id;
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("application/x-nowen-tree-node", node.id);
          }}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes("application/x-nowen-tree-node")) return;
            event.preventDefault();
            event.stopPropagation();
            const sourceId = event.dataTransfer.getData("application/x-nowen-tree-node") || draggedTreeNodeIdRef.current || "";
            if (!canReorderWithTarget(sourceId, node)) {
              event.dataTransfer.dropEffect = "none";
              setTreeDropTarget(null);
              return;
            }
            const rect = event.currentTarget.getBoundingClientRect();
            const placement = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
            event.dataTransfer.dropEffect = "move";
            setTreeDropTarget((current) => (
              current?.nodeId === node.id && current.placement === placement
                ? current
                : { nodeId: node.id, placement }
            ));
          }}
          onDrop={(event) => {
            if (!event.dataTransfer.types.includes("application/x-nowen-tree-node")) return;
            event.preventDefault();
            event.stopPropagation();
            const sourceId = event.dataTransfer.getData("application/x-nowen-tree-node") || draggedTreeNodeIdRef.current || "";
            const rect = event.currentTarget.getBoundingClientRect();
            const placement = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
            setTreeDropTarget(null);
            draggedTreeNodeIdRef.current = null;
            void dropReorder(sourceId, node, placement);
          }}
          onDragEnd={() => {
            draggedTreeNodeIdRef.current = null;
            setTreeDropTarget(null);
          }}
          onContextMenu={(event) => openMenu(event, node.id, "knowledge-node")}
          onTouchStart={(event) => beginLongPress(event, node)}
          onTouchMove={moveLongPress}
          onTouchEnd={cancelLongPress}
          onTouchCancel={cancelLongPress}
          data-knowledge-tree-node-id={node.id}
          data-knowledge-tree-select-id={node.id}
          aria-selected={selected}
        >
          <button
            type="button"
            onClick={() => hasChildren && void toggleDisclosure(node)}
            className={cn(
              "flex shrink-0 items-center justify-center text-tx-tertiary",
              variant === "mobile" ? "h-6 w-4" : "h-7 w-5",
            )}
            aria-label={isExpanded ? "折叠" : "展开"}
          >
            {hasChildren ? (isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : null}
          </button>
          <button
            type="button"
            onClick={(event) => handleNodeSelection(event, node)}
            className={cn(
              "flex min-w-0 flex-1 items-center text-left",
              variant === "mobile" ? "gap-1 py-0.5 text-[11px] leading-4" : "gap-1.5 py-1.5 text-xs",
            )}
            title={node.title}
          >
            {multiSelectMode && (
              <span className={cn(
                "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                selected ? "border-accent-primary bg-accent-primary text-white" : "border-app-border bg-app-bg",
              )}>
                {selected && <Check size={11} />}
              </span>
            )}
            {nodeIcon(node)}
            <span className="min-w-0 flex-1 truncate">{node.title}</span>
            {node.nodeType === "folder" && node.isPasswordProtected === 1 && (
              <LockKeyhole size={11} className="shrink-0 text-tx-tertiary" aria-label="密码保护" />
            )}
            {firstLevelNoteCount !== null && (
              <span
                className="min-w-4 shrink-0 rounded-full bg-app-hover px-1.5 text-center text-[10px] leading-4 tabular-nums text-tx-tertiary transition-opacity [@media(hover:hover)]:group-hover:opacity-0"
                aria-label={`“${node.title}”下共 ${firstLevelNoteCount} 条笔记`}
                data-knowledge-tree-first-level-note-count=""
              >
                {firstLevelNoteCount}
              </span>
            )}
            {node.resourceType === "note" && node.isPinned === 1 && (
              <span
                className="flex shrink-0 items-center text-accent-primary"
                title="已置顶"
                aria-label="已置顶"
              >
                <Pin size={11} className="fill-current" aria-hidden="true" />
              </span>
            )}
            {node.resourceType === "note" && node.isFavorite === 1 && (
              <span
                className="flex shrink-0 items-center text-amber-400"
                title="已收藏"
                aria-label="已收藏"
              >
                <Star size={11} className="fill-current" aria-hidden="true" />
              </span>
            )}
            {isSharedRoot(node) && <span className="rounded bg-accent-primary/10 px-1 text-[9px] text-accent-primary">共享</span>}
            {node.access.source === "inherited" && <span className="rounded bg-app-active px-1 text-[9px] text-tx-tertiary">继承</span>}
          </button>
          {node.access.capabilities.canCreate && isFolderUnlocked(node, unlockedFolderIds) && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                startInlineCreate(node, "note");
              }}
              className={cn("h-6 w-6 items-center justify-center rounded text-tx-tertiary hover:bg-app-active", actionVisibility)}
              title="新建文档"
              aria-label={`在“${node.title}”下新建文档`}
            >
              <Plus size={13} />
            </button>
          )}
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              openMenuAt(rect.right, rect.bottom + 4, node.id, "knowledge-node");
            }}
            className={cn("h-6 w-6 items-center justify-center rounded text-tx-tertiary hover:bg-app-active", actionVisibility)}
            title="更多"
          ><MoreHorizontal size={14} /></button>
        </div>
        {isExpanded && (
          <>
            {childNodes.map((child) => renderNode(child, depth + 1))}
            {draft?.parentId === node.id && renderDraft(depth + 1)}
          </>
        )}
      </div>
    );
  };

  const rootNodes = children.get(null) || [];
  const ownedRoots = rootNodes.filter((node) => !node.sharedRootId);
  const sharedRoots = rootNodes.filter((node) => Boolean(node.sharedRootId));
  const ownedNoteCount = countOwnedNotes(nodes);
  const currentSortMode = loadKnowledgeTreeSortMode();
  const hasRootDraft = draft?.parentId === null;
  const compactToolbar = variant === "mobile"
    || workspaceSurface === "web"
    || compactDesktopToolbar;

  useEffect(() => {
    if (!compactToolbar) setMobileActionsOpen(false);
  }, [compactToolbar]);

  const openFullTextSearch = useCallback(() => {
    actions.setSearchQuery(query.trim());
    actions.setViewMode("search");
    actions.setMobileSidebar(false);
    actions.setMobileView("list");
  }, [actions, query]);

  const changeSearchScope = useCallback((scope: "tree" | "content") => {
    if (scope === "content") {
      openFullTextSearch();
      return;
    }
    actions.setSearchQuery("");
    actions.setViewMode(state.selectedNotebookId ? "notebook" : "all");
  }, [actions, openFullTextSearch, state.selectedNotebookId]);

  const searchScope = state.viewMode === "search" ? "content" : "tree";

  useEffect(() => {
    if (!surfaceActive || searchScope !== "content") return;
    if (searchRef.current && document.activeElement === searchRef.current) return;
    setQuery((current) => current === state.searchQuery ? current : state.searchQuery);
  }, [searchScope, state.searchQuery, surfaceActive]);

  useEffect(() => {
    if (!surfaceActive || searchScope !== "content") return;
    const keyword = query.trim();
    if (keyword === state.searchQuery) return;
    const timer = window.setTimeout(() => actions.setSearchQuery(keyword), 180);
    return () => window.clearTimeout(timer);
  }, [actions, query, searchScope, state.searchQuery, surfaceActive]);

  const compactActionButtons = (
    <>
      <button
        type="button"
        onClick={() => startInlineCreate(null, "folder")}
        className={cn(
          "flex h-8 shrink-0 items-center justify-center rounded-md text-tx-tertiary hover:bg-app-bg hover:text-tx-primary",
          variant === "mobile" ? "w-8" : showAllNotesToolbar ? "w-7" : "w-6",
        )}
        title="新建根文件夹"
      >
        <Plus size={variant === "mobile" ? 15 : 14} />
      </button>
      <button
        ref={mobileActionsButtonRef}
        type="button"
        onClick={() => setMobileActionsOpen((current) => !current)}
        className={cn(
          "flex h-8 shrink-0 items-center justify-center rounded-md text-tx-tertiary hover:bg-app-bg hover:text-tx-primary",
          variant === "mobile" ? "w-8" : showAllNotesToolbar ? "w-7" : "w-6",
        )}
        title="更多目录操作"
        aria-label="更多目录操作"
        aria-haspopup="menu"
        aria-expanded={mobileActionsOpen}
      >
        <MoreHorizontal size={15} />
      </button>
    </>
  );

  return (
    <section
      ref={rootRef}
      className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col", className)}
      data-nowen-knowledge-tree="embedded"
      data-knowledge-tree-variant={variant}
      data-knowledge-tree-compact-toolbar={compactToolbar ? "true" : "false"}
      data-sidebar-surface-active={surfaceActive ? "true" : "false"}
    >
      <div className={cn(
        "flex",
        variant === "mobile"
          ? "flex-col items-stretch gap-0.5 px-3 pb-1.5 pt-2"
          : compactToolbar
            ? "flex-col items-stretch gap-0.5 px-2 pb-1.5"
          : "items-center gap-0.5 px-2 pb-1.5",
      )}>
        <div className={compactToolbar
          ? cn("flex w-full items-center", showAllNotesToolbar ? "gap-2" : "gap-0")
          : "contents"}
        >
          <div className={cn(
            "flex min-w-0 items-center border border-app-border bg-app-bg",
            variant === "mobile"
              ? "w-full gap-1.5 rounded-lg px-2 py-1.5 shadow-sm"
              : compactToolbar
                ? "flex-1 gap-1.5 rounded-md px-1.5 py-1 shadow-sm"
              : "flex-1 gap-1.5 rounded-md px-1.5 py-1",
          )}>
            {!compactToolbar && (
              <KnowledgeSearchScopeSwitch
                scope={searchScope}
                compact
                onChange={changeSearchScope}
              />
            )}
            <Search size={variant === "mobile" ? 14 : 13} className="shrink-0 text-tx-tertiary" />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={searchScope === "content"
                ? "搜索笔记标题与正文…"
                : variant === "mobile" ? "搜索…" : compactToolbar ? "筛选…" : "筛选目录与文档…"}
              aria-label={searchScope === "content" ? "搜索笔记标题与正文" : "筛选当前目录中的文件夹与文档"}
              title={searchScope === "content" ? "搜索笔记标题与正文" : "仅筛选当前内容树，不搜索笔记正文"}
              className="min-w-0 flex-1 bg-transparent text-xs text-tx-primary outline-none placeholder:text-tx-tertiary"
              data-knowledge-tree-search=""
              data-search-scope={searchScope}
            />
            {query && <button type="button" onClick={() => setQuery("")} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-tx-tertiary hover:bg-app-hover hover:text-tx-primary" aria-label="清空筛选"><X size={variant === "mobile" ? 15 : 12} /></button>}
            {compactToolbar && (
              <KnowledgeSearchScopeMenuButton
                scope={searchScope}
                onChange={changeSearchScope}
              />
            )}
          </div>
          {compactToolbar && !showAllNotesToolbar && compactActionButtons}
        </div>
        {compactToolbar && showAllNotesToolbar ? (
          <div className={cn(
            "grid w-full rounded-lg border border-app-border/70 bg-app-hover/40 px-0.5",
            variant === "mobile"
              ? "grid-cols-[minmax(0,1fr)_2rem_2rem]"
              : "grid-cols-[minmax(0,1fr)_1.75rem_1.75rem]",
          )}>
            <span
              className="min-w-0 border-r border-app-border/70 pr-0.5"
              data-knowledge-tree-all-notes-host="mobile-toolbar"
            />
            {compactActionButtons}
          </div>
        ) : !compactToolbar ? (
          <div className="contents">
            <button
              type="button"
              onClick={toggleAll}
              disabled={Boolean(query.trim()) || expandableFolderIds.length === 0}
              className="flex h-7 w-6 shrink-0 items-center justify-center rounded-md text-tx-tertiary hover:bg-app-hover hover:text-tx-primary disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-tx-tertiary"
              title={query.trim() ? "清除筛选后可批量展开或收起" : toggleAllLabel}
              aria-label={toggleAllLabel}
            >
              {hasExpandedFolders ? <ChevronsUp size={14} /> : <ChevronsDown size={14} />}
            </button>
            <button
              type="button"
              onClick={() => startInlineCreate(null, "folder")}
              className="flex h-7 w-6 shrink-0 items-center justify-center rounded-md text-tx-tertiary hover:bg-app-hover hover:text-tx-primary"
              title="新建根文件夹"
            >
              <Plus size={14} />
            </button>
            <button
              type="button"
              onClick={() => void reload()}
              disabled={loading}
              className="flex h-7 w-6 shrink-0 items-center justify-center rounded-md text-tx-tertiary hover:bg-app-hover hover:text-tx-primary disabled:opacity-50"
              title="刷新内容树"
            >
              <RefreshCw size={13} className={loading ? "animate-spin" : undefined} />
            </button>
          </div>
        ) : null}
      </div>

      {compactToolbar && (
        <KnowledgeTreeDropdownMenu
          open={mobileActionsOpen}
          anchor={mobileActionsButtonRef.current}
          ariaLabel="目录操作"
          items={[
            ...KNOWLEDGE_TREE_SORT_OPTIONS.map((option, index) => ({
              value: `sort:${option.value}`,
              label: option.label,
              checked: currentSortMode === option.value,
              sectionLabel: index === 0 ? "排序方式" : undefined,
            })),
            {
              value: "toggle",
              label: toggleAllLabel,
              disabled: Boolean(query.trim()) || expandableFolderIds.length === 0,
              separatorBefore: true,
            },
            { value: "refresh", label: "刷新目录" },
            ...(variant === "mobile" ? [{ value: "multi-select", label: "多选", separatorBefore: true }] : []),
          ]}
          onSelect={runMobileTreeAction}
          onClose={() => setMobileActionsOpen(false)}
        />
      )}

      {(selectedNodeIds.size > 1 || multiSelectMode) && (
        <KnowledgeTreeBatchToolbar
          count={selectedNodeIds.size}
          canMove={canBatchMove}
          canDelete={selectedNodes.length > 0 && selectedNodes.every((node) => node.access.capabilities.canDelete)}
          onMove={() => setBatchMoving(true)}
          onDelete={() => void removeSelected()}
          onClear={clearSelection}
        />
      )}

      <div
        className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-1 pb-3"
        data-swipe-blocker="knowledge-tree-scroll"
        onClick={(event) => {
          const target = event.target as HTMLElement;
          if (!target.closest("[data-knowledge-tree-select-id]")) clearSelection();
        }}
      >
        {loading && nodes.length === 0 ? (
          <div className="flex justify-center py-14"><Loader2 size={20} className="animate-spin text-tx-tertiary" /></div>
        ) : error ? (
          <div role="status" className="mx-2 mt-4 rounded-xl border border-app-border bg-app-surface/70 px-4 py-5 text-center shadow-sm">
            <span className="mx-auto flex h-9 w-9 items-center justify-center rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
              <CircleAlert size={18} aria-hidden="true" />
            </span>
            <p className="mt-3 text-sm font-medium text-tx-primary">内容暂时未加载</p>
            <p className="mx-auto mt-1 max-w-[250px] text-[11px] leading-relaxed text-tx-tertiary">
              可能是网络波动或服务暂时不可用，本次加载失败不会修改你的笔记数据。
            </p>
            <button
              type="button"
              onClick={() => void reload()}
              className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-accent-primary px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-primary/90"
            >
              <RefreshCw size={12} aria-hidden="true" />
              重新加载
            </button>
            <details className="mx-auto mt-3 max-w-[250px] text-left text-[10px] text-tx-tertiary">
              <summary className="cursor-pointer select-none text-center hover:text-tx-secondary">查看错误详情</summary>
              <p className="mt-1.5 break-words rounded-md bg-app-bg px-2 py-1.5 leading-relaxed">{error}</p>
            </details>
          </div>
        ) : filteredNodes.length === 0 && !sharedLoadError && !draft ? (
          <div className="flex flex-col items-center py-14 text-center">
            <TreePine size={28} className="mb-2 text-tx-tertiary/40" />
            <p className="text-xs text-tx-secondary">{query ? "没有匹配内容" : "暂无内容"}</p>
            {!query && <p className="mt-1 max-w-[230px] text-[10px] leading-relaxed text-tx-tertiary">点击上方加号创建根文件夹，再在树中直接创建文档。</p>}
          </div>
        ) : (
          <>
            {(ownedRoots.length > 0 || hasRootDraft) && (
              <div data-knowledge-tree-section="owned">
                <div className="flex items-center justify-between px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-tx-tertiary">
                  <span>当前空间</span>
                  {variant !== "mobile" && (
                    <span
                      className="min-w-4 rounded-full bg-app-hover px-1.5 text-center leading-4"
                      aria-label={`当前空间共 ${ownedNoteCount} 条笔记`}
                      data-knowledge-tree-notebook-count=""
                    >
                      {ownedNoteCount}
                    </span>
                  )}
                </div>
                {ownedRoots.map((node) => renderNode(node, 0))}
                {hasRootDraft && renderDraft(0)}
              </div>
            )}
            {sharedRoots.length > 0 && (
              <div className={cn("mt-2 border-t border-app-border pt-2", ownedRoots.length === 0 && !hasRootDraft && "mt-0 border-t-0 pt-0")} data-knowledge-tree-section="shared">
                <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-tx-tertiary">共享给我</div>
                {sharedRoots.map((node) => renderNode(node, 0))}
              </div>
            )}
            {sharedLoadError && (
              <div className="mx-2 mt-2 flex items-center justify-between gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 px-2.5 py-2 text-[10px] text-amber-600 dark:text-amber-400">
                <span className="min-w-0 flex-1 truncate" title={sharedLoadError}>共享内容加载失败</span>
                <button type="button" onClick={() => void reload()} className="shrink-0 underline underline-offset-2">重试</button>
              </div>
            )}
          </>
        )}
        {permissionsNode && (
          <KnowledgeTreePermissionsDialog
            node={permissionsNode}
            onChanged={emitTreeChanged}
            onClose={() => setPermissionsNode(null)}
          />
        )}
        {passwordDialog && (
          <FolderPasswordDialog
            node={passwordDialog.node}
            mode={passwordDialog.mode}
            onClose={() => {
              setPasswordDialog(null);
              setPendingFolderAction(null);
            }}
            onUnlocked={(nodeId, unlockToken) => {
              setUnlockedFolderIds(rememberUnlockedFolder(nodeId, unlockToken));
              const pendingAction = pendingFolderAction?.nodeId === nodeId
                ? pendingFolderAction.action
                : null;
              setPendingFolderAction(null);
              const target = nodes.find((node) => node.id === nodeId);
              if (pendingAction === "select" && target) {
                selectFolder(target);
              } else if (pendingAction === "toggle") {
                setNodeExpanded(nodeId, true);
                if (target && !target.sharedRootId) {
                  void knowledgeTreeApi.update(nodeId, { isExpanded: true }).catch(() => undefined);
                }
              }
            }}
            onChanged={(nodeId, isPasswordProtected) => {
              setUnlockedFolderIds(forgetUnlockedFolder(nodeId));
              if (isPasswordProtected) {
                setNodeExpanded(nodeId, false);
              }
              setNodes((current) => current.map((node) => (
                node.id === nodeId
                  ? { ...node, isPasswordProtected: isPasswordProtected ? 1 : 0, ...(isPasswordProtected ? { isExpanded: 0 } : {}) }
                  : node
              )));
              emitTreeChanged("folder-password-changed");
            }}
          />
        )}
        {movingNode && <MovePanel node={movingNode} nodes={visibleNodes.filter((node) => isFolderUnlocked(node, unlockedFolderIds))} children={allChildren} onMoved={() => void reload()} onClose={() => setMovingNode(null)} />}
        {batchMoving && (
          <KnowledgeTreeBatchMovePanel
            selectedNodes={selectedNodes}
            nodes={visibleNodes}
            targetNodes={visibleNodes.filter((node) => isFolderUnlocked(node, unlockedFolderIds))}
            onMoved={() => {
              clearSelection();
              emitTreeChanged("nodes-batch-moved");
            }}
            onClose={() => setBatchMoving(false)}
          />
        )}
      </div>
      <KnowledgeTreeNodeMenu
        menu={menu}
        menuRef={menuRef}
        node={menuNode}
        nodes={visibleNodes.filter((node) => isFolderUnlocked(node, unlockedFolderIds))}
        onClose={closeMenu}
        onOpen={openDocument}
        onSplit={openSplit}
        onCreate={startInlineCreate}
        onRename={rename}
        onMove={setMovingNode}
        onPassword={(node) => {
          setPendingFolderAction(null);
          setPasswordDialog({ node, mode: "manage" });
        }}
        isNodeUnlocked={(node) => isFolderUnlocked(node, unlockedFolderIds)}
        onUnlockNode={(node) => {
          setPendingFolderAction(null);
          setPasswordDialog({ node, mode: "unlock" });
        }}
        onPermissions={setPermissionsNode}
        onDelete={remove}
        onReload={reload}
        onNotePatched={patchNoteStatus}
      />
    </section>
  );
}

export default KnowledgeTreePanel;
