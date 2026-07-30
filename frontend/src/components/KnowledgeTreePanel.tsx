import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import KnowledgeTreeNodeMenu from "@/components/KnowledgeTreeNodeMenu";
import KnowledgeTreePermissionsDialog from "@/components/KnowledgeTreePermissionsDialog";
import {
  importMarkdownIntoKnowledgeTree,
  importWeChatArticleIntoKnowledgeTree,
  importWordIntoKnowledgeTree,
} from "@/components/knowledgeTreeImport";
import { choose, confirm, prompt } from "@/components/ui/confirm";
import { useContextMenu } from "@/hooks/useContextMenu";
import { api } from "@/lib/api";
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
  forgetUnlockedFolder,
  hideLockedFolderDescendants,
  isFolderUnlocked,
  KNOWLEDGE_TREE_PASSWORD_SESSION_CHANGED_EVENT,
  loadUnlockedFolderIds,
  rememberUnlockedFolder,
} from "@/lib/knowledgeTreePassword";
import {
  buildFirstLevelNoteCounts,
  countOwnedNotebooks,
} from "@/lib/knowledgeTreeStats";
import { toast } from "@/lib/toast";
import { compareKnowledgeTreePinnedPriority } from "@/lib/knowledgeTreeSort";
import { cn } from "@/lib/utils";
import {
  canMoveWithinSharedRoot,
  filterKnowledgeTreeNodes,
  isSharedRoot,
} from "@/lib/sharedKnowledgeTree";
import { useApp, useAppActions } from "@/store/AppContext";

export const FOCUS_KNOWLEDGE_TREE_EVENT = "nowen:focus-knowledge-tree";
export const KNOWLEDGE_TREE_CHANGED_EVENT = "nowen:knowledge-tree-changed";

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
}

export interface KnowledgeTreeInlineCreateRequest {
  requestId: number;
  parentId: string | null;
  kind: KnowledgeTreeInlineCreateKind;
}

export interface KnowledgeTreeImportRequest {
  requestId: number;
  parentId: string | null;
  kind: "markdown" | "word" | "wechat";
}

export function KnowledgeTreePanel({
  variant = "desktop",
  className,
  createRequest,
  importRequest,
}: KnowledgeTreePanelProps) {
  const { state } = useApp();
  const actions = useAppActions();
  const surfaceActive = useActiveSidebarSurface(variant);
  const rootRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const draftInputRef = useRef<HTMLInputElement>(null);
  const handledCreateRequestRef = useRef<number | null>(null);
  const handledImportRequestRef = useRef<number | null>(null);
  const [nodes, setNodes] = useState<KnowledgeTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sharedLoadError, setSharedLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<KnowledgeTreeInlineDraft | null>(null);
  const [permissionsNode, setPermissionsNode] = useState<KnowledgeTreeNode | null>(null);
  const [movingNode, setMovingNode] = useState<KnowledgeTreeNode | null>(null);
  const [unlockedFolderIds, setUnlockedFolderIds] = useState<Set<string>>(() => loadUnlockedFolderIds());
  const [passwordDialog, setPasswordDialog] = useState<{ node: KnowledgeTreeNode; mode: "unlock" | "manage" } | null>(null);
  const [pendingFolderOpenId, setPendingFolderOpenId] = useState<string | null>(null);
  const { menu, menuRef, openMenu, openMenuAt, closeMenu } = useContextMenu();
  const longPressRef = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const menuNode = menu.targetId ? nodes.find((candidate) => candidate.id === menu.targetId) || null : null;

  const reload = useCallback(async () => {
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
      const ids = new Set(merged.map((node) => node.id));
      setNodes(merged);
      setExpanded((current) => {
        if (current.size === 0) {
          return new Set(merged.filter((node) => node.parentId === null || node.isExpanded).map((node) => node.id));
        }
        return new Set(Array.from(current).filter((id) => ids.has(id)));
      });
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
    const focus = () => requestAnimationFrame(() => searchRef.current?.focus());
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

  useEffect(() => {
    if (variant !== "desktop" || !surfaceActive || nodes.length === 0 || !state.activeNote?.id) return;

    const activeNode = nodes.find(
      (node) => node.resourceType === "note" && node.resourceId === state.activeNote?.id,
    );
    if (!activeNode) return;

    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    const ancestorIds = new Set<string>();
    let parent = activeNode.parentId ? nodesById.get(activeNode.parentId) : undefined;
    while (parent) {
      ancestorIds.add(parent.id);
      parent = parent.parentId ? nodesById.get(parent.parentId) : undefined;
    }

    setExpanded((current) => {
      const next = new Set(current);
      let changed = false;
      ancestorIds.forEach((id) => {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      });
      return changed ? next : current;
    });

    const frame = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const nodeElement = Array.from(
          rootRef.current?.querySelectorAll<HTMLElement>("[data-knowledge-tree-node-id]") ?? [],
        ).find((element) => element.dataset.knowledgeTreeNodeId === activeNode.id);
        nodeElement?.scrollIntoView({ block: "nearest" });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [nodes, state.activeNote?.id, surfaceActive, variant]);

  const activateNote = useCallback((note: Awaited<ReturnType<typeof api.getNote>>) => {
    actions.setActiveNote(note);
    actions.setSelectedNotebook(note.notebookId);
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
    const next = new Set(expanded);
    const opening = !next.has(node.id);
    if (opening) next.add(node.id); else next.delete(node.id);
    setExpanded(next);
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
    setExpanded(expanding ? targetIds : new Set());
    void Promise.allSettled(
      changedOwnedFolders.map((node) => knowledgeTreeApi.update(node.id, { isExpanded: expanding })),
    );
  }, [expandableFolderIds, hasExpandedFolders, nodes]);

  const openDocument = async (node: KnowledgeTreeNode) => {
    closeMenu();
    if (node.nodeType === "folder") {
      if (!isFolderUnlocked(node, unlockedFolderIds)) {
        setPendingFolderOpenId(node.id);
        setPasswordDialog({ node, mode: "unlock" });
        return;
      }
      await toggle(node);
      return;
    }
    if (node.resourceType !== "note") return;
    rememberOpened(node.id);
    try {
      activateNote(await api.getNote(node.resourceId));
    } catch (requestError: any) {
      toast.error(requestError?.message || "打开文档失败");
    }
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
      setPendingFolderOpenId(null);
      setPasswordDialog({ node: parent, mode: "unlock" });
      return;
    }
    closeMenu();
    setQuery("");
    if (parent) {
      setExpanded((current) => new Set(current).add(parent.id));
      if (!parent.sharedRootId) void knowledgeTreeApi.update(parent.id, { isExpanded: true }).catch(() => {});
    }
    setDraft({
      parentId: parent?.id || null,
      kind,
      title: defaultInlineCreateTitle(kind),
      saving: false,
      error: null,
    });
  }, [closeMenu, unlockedFolderIds]);

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
      setPendingFolderOpenId(null);
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
          : importRequest.kind === "word"
            ? await importWordIntoKnowledgeTree(options)
            : await importWeChatArticleIntoKnowledgeTree(options);
        if (!imported) return;
        activateNote(imported);
        emitTreeChanged("node-imported-plus-menu");
        await reload();
        actions.refreshNotes();
        actions.refreshNotebooks();
      } catch (requestError: any) {
        toast.error(requestError?.message || "导入失败，请重试");
      }
    };
    void runImport();
  }, [actions, activateNote, importRequest, nodes, reload, state.activeNote?.notebookId, state.notebooks, state.selectedNotebookId, unlockedFolderIds]);

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
    if (snapshot.parentId) setExpanded((current) => new Set(current).add(snapshot.parentId!));
    emitTreeChanged("node-created-inline");
    await reload();
    actions.refreshNotebooks();
    actions.refreshNotes();

    if (snapshot.kind === "folder") {
      toast.success("已创建文件夹");
      return;
    }

    try {
      activateNote(await api.getNote(created.resourceId));
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
      await knowledgeTreeApi.remove(node.id, mode);
      emitTreeChanged("node-deleted");
      await reload();
      actions.refreshNotebooks();
      actions.refreshNotes();
      toast.success("已移入回收站");
    } catch (requestError: any) {
      toast.error(requestError?.message || "删除失败");
    }
  };

  const dropMove = async (sourceId: string, targetId: string) => {
    if (!sourceId || sourceId === targetId) return;
    const source = nodes.find((node) => node.id === sourceId);
    const target = nodes.find((node) => node.id === targetId);
    if (!source || !target) return;
    if (Boolean(source.sharedRootId) !== Boolean(target.sharedRootId)) {
      toast.error("自有内容与共享内容不能互相移动");
      return;
    }
    if (source.sharedRootId && !canMoveWithinSharedRoot(source, target)) {
      toast.error("共享内容只能在同一个共享根内移动");
      return;
    }
    const blockedTargets = descendantsOf(sourceId, allChildren);
    if (blockedTargets.has(targetId)) {
      toast.error("不能移动到自己的子节点中");
      return;
    }
    try {
      await knowledgeTreeApi.move(sourceId, { parentId: targetId });
      setExpanded((current) => new Set(current).add(targetId));
      emitTreeChanged("node-moved");
      await reload();
      actions.refreshNotebooks();
      toast.success("已移动");
    } catch (requestError: any) {
      toast.error(requestError?.message || "移动失败");
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
    const active = node.resourceType === "note" && state.activeNote?.id === node.resourceId;
    const actionVisibility = variant === "mobile" ? "flex" : "hidden group-hover:flex";
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
          )}
          style={{ paddingLeft: `${depth * treeIndent + treeInset}px` }}
          draggable={node.access.capabilities.canMove && !isSharedRoot(node)}
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("application/x-nowen-tree-node", node.id);
          }}
          onDragOver={(event) => {
            if (!node.access.capabilities.canCreate || !isFolderUnlocked(node, unlockedFolderIds)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }}
          onDrop={(event) => {
            if (!node.access.capabilities.canCreate) return;
            event.preventDefault();
            if (!isFolderUnlocked(node, unlockedFolderIds)) {
              setPendingFolderOpenId(null);
              setPasswordDialog({ node, mode: "unlock" });
              return;
            }
            void dropMove(event.dataTransfer.getData("application/x-nowen-tree-node"), node.id);
          }}
          onContextMenu={(event) => openMenu(event, node.id, "knowledge-node")}
          onTouchStart={(event) => beginLongPress(event, node)}
          onTouchMove={moveLongPress}
          onTouchEnd={cancelLongPress}
          onTouchCancel={cancelLongPress}
          data-knowledge-tree-node-id={node.id}
        >
          <button
            type="button"
            onClick={() => hasChildren && void openDocument(node)}
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
            onClick={(event) => {
              if ((event.ctrlKey || event.metaKey) && node.resourceType === "note") openSplit(node, "right");
              else void openDocument(node);
            }}
            className={cn(
              "flex min-w-0 flex-1 items-center text-left",
              variant === "mobile" ? "gap-1 py-0.5 text-[11px] leading-4" : "gap-1.5 py-1.5 text-xs",
            )}
            title={node.title}
          >
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
  const ownedNotebookCount = countOwnedNotebooks(nodes);
  const hasRootDraft = draft?.parentId === null;

  return (
    <section ref={rootRef} className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col", className)} data-nowen-knowledge-tree="embedded" data-sidebar-surface-active={surfaceActive ? "true" : "false"}>
      <div className="flex items-center gap-0.5 px-2 pb-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-app-border bg-app-bg px-2 py-1.5">
          <Search size={13} className="shrink-0 text-tx-tertiary" />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="筛选内容树…"
            className="min-w-0 flex-1 bg-transparent text-xs text-tx-primary outline-none placeholder:text-tx-tertiary"
            data-knowledge-tree-search=""
          />
          {query && <button type="button" onClick={() => setQuery("")} className="text-tx-tertiary hover:text-tx-primary" aria-label="清空筛选"><X size={12} /></button>}
        </div>
        <button
          type="button"
          onClick={toggleAll}
          disabled={Boolean(query.trim()) || expandableFolderIds.length === 0}
          className="flex h-7 w-6 shrink-0 items-center justify-center rounded-md text-tx-tertiary hover:bg-app-hover hover:text-tx-primary disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-tx-tertiary"
          title={query.trim() ? "清除筛选后可批量展开或收起" : toggleAllLabel}
          aria-label={toggleAllLabel}
        >{hasExpandedFolders ? <ChevronsUp size={14} /> : <ChevronsDown size={14} />}</button>
        <button
          type="button"
          onClick={() => startInlineCreate(null, "folder")}
          className="flex h-7 w-6 shrink-0 items-center justify-center rounded-md text-tx-tertiary hover:bg-app-hover hover:text-tx-primary"
          title="新建根文件夹"
        ><Plus size={14} /></button>
        <button type="button" onClick={() => void reload()} disabled={loading} className="flex h-7 w-6 shrink-0 items-center justify-center rounded-md text-tx-tertiary hover:bg-app-hover hover:text-tx-primary disabled:opacity-50" title="刷新内容树"><RefreshCw size={13} className={loading ? "animate-spin" : undefined} /></button>
      </div>

      <div className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-1 pb-3" data-swipe-blocker="knowledge-tree-scroll">
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
                  <span
                    className="min-w-4 rounded-full bg-app-hover px-1.5 text-center leading-4"
                    aria-label={`当前空间共 ${ownedNotebookCount} 个笔记本`}
                    data-knowledge-tree-notebook-count=""
                  >
                    {ownedNotebookCount}
                  </span>
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
              setPendingFolderOpenId(null);
            }}
            onUnlocked={(nodeId, unlockToken) => {
              setUnlockedFolderIds(rememberUnlockedFolder(nodeId, unlockToken));
              if (pendingFolderOpenId === nodeId) {
                setExpanded((current) => new Set(current).add(nodeId));
                const target = nodes.find((node) => node.id === nodeId);
                if (target && !target.sharedRootId) {
                  void knowledgeTreeApi.update(nodeId, { isExpanded: true }).catch(() => undefined);
                }
              }
            }}
            onChanged={(nodeId) => {
              setUnlockedFolderIds(forgetUnlockedFolder(nodeId));
              setExpanded((current) => {
                const next = new Set(current);
                next.delete(nodeId);
                return next;
              });
              setNodes((current) => current.map((node) => (
                node.id === nodeId ? { ...node, isPasswordProtected: 1, isExpanded: 0 } : node
              )));
              emitTreeChanged("folder-password-changed");
            }}
          />
        )}
        {movingNode && <MovePanel node={movingNode} nodes={visibleNodes.filter((node) => isFolderUnlocked(node, unlockedFolderIds))} children={allChildren} onMoved={() => void reload()} onClose={() => setMovingNode(null)} />}
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
          setPendingFolderOpenId(null);
          setPasswordDialog({ node, mode: "manage" });
        }}
        isNodeUnlocked={(node) => isFolderUnlocked(node, unlockedFolderIds)}
        onUnlockNode={(node) => {
          setPendingFolderOpenId(null);
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
