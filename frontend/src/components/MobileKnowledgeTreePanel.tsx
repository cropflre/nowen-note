import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpDown,
  Check,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  CircleAlert,
  Clock3,
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
  Star,
  TreePine,
  X,
} from "lucide-react";

import FolderPasswordDialog from "@/components/FolderPasswordDialog";
import KnowledgeTreeNodeMenu from "@/components/KnowledgeTreeNodeMenu";
import KnowledgeTreePermissionsDialog from "@/components/KnowledgeTreePermissionsDialog";
import {
  KnowledgeTreeCreateDropdown,
  type KnowledgeTreeCreateMenuState,
} from "@/components/KnowledgeTreeCreateMenuRuntime";
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
  type KnowledgeTreeInlineDraft,
  type KnowledgeTreeInlineCreateKind,
} from "@/lib/knowledgeTreeInlineCreate";
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
import {
  buildMobileKnowledgeTreePath,
  buildMobileKnowledgeTreeRecentNodes,
  filterMobileKnowledgeTreeNodes,
  getMobileKnowledgeTreeAncestors,
  getMobileKnowledgeTreeChildren,
  loadMobileKnowledgeTreeRecentEntries,
  loadMobileKnowledgeTreeSortMode,
  saveMobileKnowledgeTreeRecentEntries,
  saveMobileKnowledgeTreeSortMode,
  sortMobileKnowledgeTreeNodes,
  upsertMobileKnowledgeTreeRecentEntry,
  type MobileKnowledgeTreeRecentEntry,
  type MobileKnowledgeTreeSortMode,
} from "@/lib/mobileKnowledgeTree";
import { isSharedRoot } from "@/lib/sharedKnowledgeTree";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { useApp, useAppActions } from "@/store/AppContext";

const FOCUS_KNOWLEDGE_TREE_EVENT = "nowen:focus-knowledge-tree";
const KNOWLEDGE_TREE_CHANGED_EVENT = "nowen:knowledge-tree-changed";

type MobileView = "recent" | "browse";

const SORT_LABELS: Record<MobileKnowledgeTreeSortMode, string> = {
  "updated-desc": "最近更新",
  "title-asc": "名称 A–Z",
  "title-desc": "名称 Z–A",
  "created-desc": "最近创建",
  manual: "手动排序",
};

function emitTreeChanged(reason: string) {
  window.dispatchEvent(new CustomEvent(KNOWLEDGE_TREE_CHANGED_EVENT, { detail: { reason } }));
}

function nodeIcon(node: KnowledgeTreeNode) {
  if (node.nodeType === "folder") {
    return node.icon
      ? <span className="w-5 shrink-0 text-center text-base leading-none">{node.icon}</span>
      : <Folder size={18} className="shrink-0 text-amber-500" />;
  }
  if (node.nodeType === "markdown") return <FileCode size={18} className="shrink-0 text-emerald-500" />;
  return <FileText size={18} className="shrink-0 text-accent-primary" />;
}

function descendantsOf(nodeId: string, nodes: KnowledgeTreeNode[]) {
  const children = new Map<string, KnowledgeTreeNode[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const siblings = children.get(node.parentId) || [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  }
  const result = new Set<string>();
  const stack = [nodeId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const child of children.get(current) || []) {
      if (result.has(child.id)) continue;
      result.add(child.id);
      stack.push(child.id);
    }
  }
  return result;
}

function formatUpdatedAt(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  const now = new Date();
  const sameYear = parsed.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat("zh-CN", {
    ...(sameYear ? {} : { year: "numeric" as const }),
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

function MovePanel({
  node,
  nodes,
  onMoved,
  onClose,
}: {
  node: KnowledgeTreeNode;
  nodes: KnowledgeTreeNode[];
  onMoved: () => void;
  onClose: () => void;
}) {
  const blocked = useMemo(() => {
    const result = descendantsOf(node.id, nodes);
    result.add(node.id);
    return result;
  }, [node.id, nodes]);
  const candidates = useMemo(() => sortMobileKnowledgeTreeNodes(
    nodes.filter((candidate) => (
      !blocked.has(candidate.id)
      && candidate.access.capabilities.canCreate
      && (node.sharedRootId
        ? candidate.sharedRootId === node.sharedRootId
        : !candidate.sharedRootId)
    )),
    "title-asc",
  ), [blocked, node.sharedRootId, nodes]);
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
      <header className="flex h-12 items-center gap-2 border-b border-app-border px-3">
        <Folder size={17} className="text-amber-500" />
        <div className="min-w-0 flex-1 truncate text-sm font-semibold text-tx-primary">移动“{node.title}”</div>
        <button type="button" onClick={onClose} className="rounded-md p-2 text-tx-tertiary hover:bg-app-hover" aria-label="关闭移动面板"><X size={17} /></button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {allowRoot && (
          <button
            type="button"
            disabled={node.parentId === null}
            onClick={() => void move(null)}
            className="mb-1 flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm text-tx-secondary hover:bg-app-hover hover:text-tx-primary disabled:cursor-not-allowed disabled:opacity-40"
          >
            <TreePine size={17} className="text-accent-primary" /><span className="truncate">当前空间根目录</span>
          </button>
        )}
        {candidates.map((candidate) => (
          <button key={candidate.id} type="button" onClick={() => void move(candidate.id)} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm text-tx-secondary hover:bg-app-hover hover:text-tx-primary">
            {nodeIcon(candidate)}
            <span className="min-w-0 flex-1">
              <span className="block truncate">{candidate.title}</span>
              <span className="block truncate text-[10px] text-tx-tertiary">{buildMobileKnowledgeTreePath(candidate, nodes)}</span>
            </span>
          </button>
        ))}
        {candidates.length === 0 && node.parentId === null && <p className="py-10 text-center text-xs text-tx-tertiary">没有可用目标节点</p>}
      </div>
    </div>
  );
}

export default function MobileKnowledgeTreePanel({
  variant = "mobile",
}: {
  variant?: "mobile" | "desktop";
} = {}) {
  const { state } = useApp();
  const actions = useAppActions();
  const searchRef = useRef<HTMLInputElement>(null);
  const draftInputRef = useRef<HTMLInputElement>(null);
  const longPressRef = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const [nodes, setNodes] = useState<KnowledgeTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sharedLoadError, setSharedLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<MobileView>("recent");
  const [parentId, setParentId] = useState<string | null>(null);
  const [allExpanded, setAllExpanded] = useState(false);
  const [sortMode, setSortMode] = useState<MobileKnowledgeTreeSortMode>(() => loadMobileKnowledgeTreeSortMode());
  const [recentEntries, setRecentEntries] = useState<MobileKnowledgeTreeRecentEntry[]>(() => loadMobileKnowledgeTreeRecentEntries());
  const [permissionsNode, setPermissionsNode] = useState<KnowledgeTreeNode | null>(null);
  const [movingNode, setMovingNode] = useState<KnowledgeTreeNode | null>(null);
  const [unlockedFolderIds, setUnlockedFolderIds] = useState<Set<string>>(() => loadUnlockedFolderIds());
  const [passwordDialog, setPasswordDialog] = useState<{ node: KnowledgeTreeNode; mode: "unlock" | "manage" } | null>(null);
  const [pendingFolderOpenId, setPendingFolderOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<KnowledgeTreeInlineDraft | null>(null);
  const [createMenu, setCreateMenu] = useState<KnowledgeTreeCreateMenuState | null>(null);
  const { menu, menuRef, openMenu, openMenuAt, closeMenu } = useContextMenu();
  const menuNode = menu.targetId ? nodes.find((candidate) => candidate.id === menu.targetId) || null : null;

  useEffect(() => {
    if (!draft) return;
    requestAnimationFrame(() => {
      draftInputRef.current?.focus({ preventScroll: true });
      draftInputRef.current?.scrollIntoView({ block: "nearest" });
      draftInputRef.current?.select();
    });
  }, [draft?.parentId, draft?.kind]);

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
      setNodes(merged);
      setParentId((current) => {
        if (!current) return null;
        const visible = hideLockedFolderDescendants(merged, loadUnlockedFolderIds());
        const parent = visible.find((node) => node.id === current && node.isDeleted !== 1);
        return parent ? current : null;
      });
    } catch (requestError: any) {
      setError(requestError?.message || "加载内容失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    const syncUnlockedFolders = () => setUnlockedFolderIds(loadUnlockedFolderIds());
    window.addEventListener(KNOWLEDGE_TREE_PASSWORD_SESSION_CHANGED_EVENT, syncUnlockedFolders);
    return () => window.removeEventListener(KNOWLEDGE_TREE_PASSWORD_SESSION_CHANGED_EVENT, syncUnlockedFolders);
  }, []);

  useEffect(() => {
    const refresh = () => void reload();
    window.addEventListener("nowen:workspace-changed", refresh);
    window.addEventListener(KNOWLEDGE_TREE_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener("nowen:workspace-changed", refresh);
      window.removeEventListener(KNOWLEDGE_TREE_CHANGED_EVENT, refresh);
    };
  }, [reload]);

  useEffect(() => {
    const focus = () => requestAnimationFrame(() => searchRef.current?.focus());
    window.addEventListener(FOCUS_KNOWLEDGE_TREE_EVENT, focus);
    return () => window.removeEventListener(FOCUS_KNOWLEDGE_TREE_EVENT, focus);
  }, []);

  const rememberOpened = useCallback((nodeId: string) => {
    setRecentEntries((current) => {
      const next = upsertMobileKnowledgeTreeRecentEntry(current, nodeId);
      saveMobileKnowledgeTreeRecentEntries(next);
      return next;
    });
  }, []);

  useEffect(() => {
    const activeNoteId = state.activeNote?.id;
    if (!activeNoteId) return;
    const node = nodes.find((candidate) => candidate.resourceType === "note" && candidate.resourceId === activeNoteId);
    if (node) rememberOpened(node.id);
  }, [nodes, rememberOpened, state.activeNote?.id]);

  const visibleNodes = useMemo(
    () => hideLockedFolderDescendants(nodes, unlockedFolderIds),
    [nodes, unlockedFolderIds],
  );
  const byId = useMemo(() => new Map(visibleNodes.map((node) => [node.id, node])), [visibleNodes]);
  const firstLevelNoteCounts = useMemo(() => buildFirstLevelNoteCounts(visibleNodes), [visibleNodes]);
  const currentFolder = parentId ? byId.get(parentId) || null : null;
  const breadcrumbs = useMemo(() => {
    if (!currentFolder) return [];
    return [...getMobileKnowledgeTreeAncestors(currentFolder, visibleNodes), currentFolder];
  }, [currentFolder, visibleNodes]);
  const currentChildren = useMemo(
    () => getMobileKnowledgeTreeChildren(visibleNodes, parentId, sortMode),
    [visibleNodes, parentId, sortMode],
  );
  const childrenByParent = useMemo(() => {
    const result = new Map<string | null, KnowledgeTreeNode[]>();
    for (const node of sortMobileKnowledgeTreeNodes(
      visibleNodes.filter((candidate) => candidate.isDeleted !== 1),
      sortMode,
    )) {
      const key = node.parentId ?? null;
      const siblings = result.get(key) || [];
      siblings.push(node);
      result.set(key, siblings);
    }
    return result;
  }, [sortMode, visibleNodes]);
  const hasExpandableContent = currentChildren.some((node) => (childrenByParent.get(node.id)?.length || 0) > 0);
  const recentNodes = useMemo(
    () => buildMobileKnowledgeTreeRecentNodes(visibleNodes, recentEntries),
    [visibleNodes, recentEntries],
  );
  const searchResults = useMemo(
    () => filterMobileKnowledgeTreeNodes(visibleNodes, query, sortMode),
    [visibleNodes, query, sortMode],
  );
  const rootOwned = useMemo(() => currentChildren.filter((node) => !node.sharedRootId), [currentChildren]);
  const rootShared = useMemo(() => currentChildren.filter((node) => Boolean(node.sharedRootId)), [currentChildren]);
  const ownedNotebookCount = useMemo(() => countOwnedNotebooks(visibleNodes), [visibleNodes]);

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
    if (variant === "mobile") {
      actions.setMobileView("editor");
      actions.setMobileSidebar(false);
    }
  }, [actions, variant]);

  const openDocument = useCallback(async (node: KnowledgeTreeNode) => {
    closeMenu();
    if (node.nodeType === "folder") {
      if (!isFolderUnlocked(node, unlockedFolderIds)) {
        setPendingFolderOpenId(node.id);
        setPasswordDialog({ node, mode: "unlock" });
        return;
      }
      setView("browse");
      setParentId(node.id);
      setQuery("");
      return;
    }
    if (node.resourceType !== "note") return;
    rememberOpened(node.id);
    try {
      activateNote(await api.getNote(node.resourceId));
    } catch (requestError: any) {
      toast.error(requestError?.message || "打开文档失败");
    }
  }, [activateNote, closeMenu, rememberOpened, unlockedFolderIds]);

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
    setNodes((current) => current.map((node) => node.id === nodeId ? { ...node, ...patch } : node));
  }, []);

  const startInlineCreate = useCallback((
    parent: KnowledgeTreeNode | null,
    kind: KnowledgeTreeInlineCreateKind,
  ) => {
    if (parent && !parent.access.capabilities.canCreate) return;
    if (parent && !isFolderUnlocked(parent, unlockedFolderIds)) {
      setCreateMenu(null);
      setPendingFolderOpenId(null);
      setPasswordDialog({ node: parent, mode: "unlock" });
      return;
    }
    closeMenu();
    setCreateMenu(null);
    setView("browse");
    setQuery("");
    setParentId(parent?.id || null);
    setDraft({
      parentId: parent?.id || null,
      kind,
      title: defaultInlineCreateTitle(kind),
      saving: false,
      error: null,
    });
  }, [closeMenu, unlockedFolderIds]);

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
    try {
      const created = await knowledgeTreeApi.create({
        parentId: snapshot.parentId,
        nodeType: snapshot.kind,
        title,
      });
      setDraft(null);
      emitTreeChanged("node-created-quick-browse");
      await reload();
      actions.refreshNotebooks();
      actions.refreshNotes();
      if (snapshot.kind === "folder") {
        toast.success("已创建文件夹");
        return;
      }
      rememberOpened(created.id);
      activateNote(await api.getNote(created.resourceId));
    } catch (requestError: any) {
      setDraft((current) => current ? {
        ...current,
        saving: false,
        error: requestError?.message || "创建失败，请重试",
      } : null);
      requestAnimationFrame(() => draftInputRef.current?.focus());
    }
  };

  const openCreateDropdown = useCallback((
    event: React.MouseEvent<HTMLButtonElement>,
    parent: KnowledgeTreeNode | null,
  ) => {
    event.stopPropagation();
    const anchor = event.currentTarget.getBoundingClientRect();
    const nextParentId = parent?.id || null;
    setCreateMenu((current) => current?.parentId === nextParentId ? null : { parentId: nextParentId, anchor });
  }, []);

  const closeCreateDropdown = useCallback(() => setCreateMenu(null), []);

  const importIntoTree = useCallback(async (
    targetParentId: string | null,
    kind: "markdown" | "word" | "wechat",
  ) => {
    setCreateMenu(null);
    const parent = targetParentId ? nodes.find((node) => node.id === targetParentId) || null : null;
    if (targetParentId && !parent) return;
    if (parent && !isFolderUnlocked(parent, unlockedFolderIds)) {
      setPendingFolderOpenId(null);
      setPasswordDialog({ node: parent, mode: "unlock" });
      return;
    }
    try {
      const options = {
        parent,
        nodes,
        fallbackNotebookId: state.activeNote?.notebookId || state.selectedNotebookId || state.notebooks[0]?.id || null,
      };
      const imported = kind === "markdown"
        ? await importMarkdownIntoKnowledgeTree(options)
        : kind === "word"
          ? await importWordIntoKnowledgeTree(options)
          : await importWeChatArticleIntoKnowledgeTree(options);
      if (!imported) return;
      activateNote(imported);
      emitTreeChanged("node-imported-quick-browse");
      await reload();
      actions.refreshNotes();
      actions.refreshNotebooks();
    } catch (requestError: any) {
      toast.error(requestError?.message || "导入失败，请重试");
    }
  }, [actions, activateNote, nodes, reload, state.activeNote?.notebookId, state.notebooks, state.selectedNotebookId, unlockedFolderIds]);

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
    const hasChildren = node.childCount > 0 || nodes.some((candidate) => candidate.parentId === node.id);
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
      if (parentId === node.id) setParentId(node.parentId || null);
      emitTreeChanged("node-deleted");
      await reload();
      actions.refreshNotebooks();
      actions.refreshNotes();
      toast.success("已移入回收站");
    } catch (requestError: any) {
      toast.error(requestError?.message || "删除失败");
    }
  };

  const chooseSortMode = async () => {
    const choice = await choose({
      title: "目录排序方式",
      description: "文件夹始终优先显示。",
      choices: (Object.keys(SORT_LABELS) as MobileKnowledgeTreeSortMode[]).map((mode) => ({
        value: mode,
        label: `${mode === sortMode ? "✓ " : ""}${SORT_LABELS[mode]}`,
      })),
    });
    if (!choice || !(choice in SORT_LABELS)) return;
    const next = choice as MobileKnowledgeTreeSortMode;
    setSortMode(next);
    saveMobileKnowledgeTreeSortMode(next);
  };

  const goBack = () => {
    if (!currentFolder) {
      setParentId(null);
      return;
    }
    const parent = currentFolder.parentId ? byId.get(currentFolder.parentId) : null;
    setParentId(parent?.id || null);
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

  const renderDraft = () => {
    if (!draft) return null;
    const DraftIcon = draft.kind === "folder" ? Folder : draft.kind === "markdown" ? FileCode : FileText;
    return (
      <div
        className={cn(
          "mx-1 mb-px flex min-w-0 items-center gap-2 rounded-md bg-accent-primary/5 px-2 py-1",
          variant === "mobile" && "min-h-12 rounded-xl px-3 py-2",
          draft.error && "bg-red-500/5",
        )}
        data-mobile-knowledge-tree-inline-create=""
      >
        <DraftIcon
          size={18}
          className={cn(
            "shrink-0",
            draft.kind === "folder" ? "text-amber-500" : draft.kind === "markdown" ? "text-emerald-500" : "text-accent-primary",
          )}
        />
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
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-accent-primary hover:bg-accent-primary/10 disabled:opacity-50"
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
    );
  };

  const renderNode = (node: KnowledgeTreeNode, showPath = false, depth = 0) => {
    const active = node.resourceType === "note" && state.activeNote?.id === node.resourceId;
    const hasChildren = node.childCount > 0 || nodes.some((candidate) => candidate.parentId === node.id);
    const path = showPath ? buildMobileKnowledgeTreePath(node, nodes) : "";
    const updatedAt = formatUpdatedAt(node.updatedAt);
    const actionVisibility = variant === "mobile" ? "flex" : "hidden group-hover:flex";
    const desktopHoverHidden = variant === "desktop" ? "[@media(hover:hover)]:group-hover:hidden" : "";
    const firstLevelNoteCount = parentId === null && depth === 0 && !showPath && node.nodeType === "folder" && !node.sharedRootId && isFolderUnlocked(node, unlockedFolderIds)
      ? firstLevelNoteCounts.get(node.id) ?? 0
      : null;
    return (
      <div
        key={node.id}
        className={cn(
          "group relative mx-1 flex min-w-0 items-center text-tx-secondary active:bg-app-active/80",
          variant === "mobile" ? "mb-0.5 min-h-12 rounded-xl" : "mb-px min-h-9 rounded-md",
          active ? "bg-app-active text-tx-primary" : "hover:bg-app-hover hover:text-tx-primary",
        )}
        onContextMenu={(event) => openMenu(event, node.id, "knowledge-node")}
        onTouchStart={variant === "mobile" ? (event) => beginLongPress(event, node) : undefined}
        onTouchMove={variant === "mobile" ? moveLongPress : undefined}
        onTouchEnd={variant === "mobile" ? cancelLongPress : undefined}
        onTouchCancel={variant === "mobile" ? cancelLongPress : undefined}
        style={variant === "desktop" && depth > 0 ? { paddingLeft: `${Math.min(depth, 8) * 14}px` } : undefined}
        data-mobile-knowledge-tree-node-id={node.id}
        data-desktop-knowledge-tree-node-id={variant === "desktop" ? node.id : undefined}
      >
        <button
          type="button"
          onClick={() => void openDocument(node)}
          className={cn(
            "flex min-w-0 flex-1 items-center text-left",
            variant === "mobile" ? "gap-2.5 px-3 py-2.5" : "gap-2 px-2 py-1.5",
          )}
          title={node.title}
        >
          {nodeIcon(node)}
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className={cn("min-w-0 flex-1 truncate", variant === "mobile" ? "text-sm" : "text-xs")}>{node.title}</span>
              {node.nodeType === "folder" && node.isPasswordProtected === 1 && (
                <LockKeyhole size={12} className="shrink-0 text-tx-tertiary" aria-label="密码保护" />
              )}
              {firstLevelNoteCount !== null && (
                <span
                  className="min-w-4 shrink-0 rounded-full bg-app-hover px-1.5 text-center text-[10px] leading-4 tabular-nums text-tx-tertiary transition-opacity [@media(hover:hover)]:group-hover:opacity-0"
                  aria-label={`“${node.title}”下共 ${firstLevelNoteCount} 条笔记`}
                  data-mobile-knowledge-tree-first-level-note-count=""
                >
                  {firstLevelNoteCount}
                </span>
              )}
              {node.resourceType === "note" && node.isPinned === 1 && (
                <Pin size={11} className={cn("shrink-0 fill-current text-accent-primary", desktopHoverHidden)} />
              )}
              {node.resourceType === "note" && node.isFavorite === 1 && (
                <Star size={11} className={cn("shrink-0 fill-current text-amber-400", desktopHoverHidden)} />
              )}
              {isSharedRoot(node) && (
                <span className={cn("shrink-0 rounded bg-accent-primary/10 px-1 text-[9px] text-accent-primary", desktopHoverHidden)}>共享</span>
              )}
            </span>
            {(showPath || updatedAt) && (
              <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[10px] text-tx-tertiary">
                {showPath && <span className="min-w-0 truncate">{path}</span>}
                {showPath && updatedAt && <span className="shrink-0">·</span>}
                {updatedAt && <span className="shrink-0">{updatedAt}</span>}
              </span>
            )}
          </span>
          {node.nodeType === "folder" && <ChevronRight size={16} className={cn("shrink-0 text-tx-tertiary", desktopHoverHidden)} />}
        </button>
        {node.nodeType !== "folder" && hasChildren && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setView("browse");
              setParentId(node.id);
              setQuery("");
            }}
            className={cn(
              "flex shrink-0 items-center justify-center text-tx-tertiary hover:bg-app-active hover:text-tx-primary",
              variant === "mobile" ? "h-9 w-9 rounded-lg" : "h-7 w-7 rounded-md",
              desktopHoverHidden,
            )}
            aria-label={`查看“${node.title}”的子内容`}
          >
            <ChevronRight size={16} />
          </button>
        )}
        {node.access.capabilities.canCreate && (
          <button
            type="button"
            onClick={(event) => {
              openCreateDropdown(event, node);
            }}
            className={cn(
              "shrink-0 items-center justify-center text-tx-tertiary hover:bg-app-active hover:text-tx-primary",
              variant === "mobile" ? "h-9 w-9 rounded-lg" : "h-7 w-7 rounded-md",
              actionVisibility,
            )}
            aria-label={`在“${node.title}”下新建内容`}
            aria-haspopup="menu"
          >
            <Plus size={16} />
          </button>
        )}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            openMenuAt(rect.right, rect.bottom + 4, node.id, "knowledge-node");
          }}
          className={cn(
            "mr-1 shrink-0 items-center justify-center text-tx-tertiary hover:bg-app-active hover:text-tx-primary",
            variant === "mobile" ? "h-9 w-9 rounded-lg" : "h-7 w-7 rounded-md",
            actionVisibility,
          )}
          aria-label={`更多：${node.title}`}
        >
          <MoreHorizontal size={17} />
        </button>
      </div>
    );
  };

  const renderExpandedBranch = (node: KnowledgeTreeNode, depth = 0): React.ReactNode => (
    <React.Fragment key={`expanded-${node.id}`}>
      {renderNode(node, false, depth)}
      {(childrenByParent.get(node.id) || []).map((child) => renderExpandedBranch(child, depth + 1))}
    </React.Fragment>
  );

  const renderEmpty = (title: string, description?: string) => (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <TreePine size={30} className="mb-2 text-tx-tertiary/35" />
      <p className="text-sm text-tx-secondary">{title}</p>
      {description && <p className="mt-1 text-xs leading-relaxed text-tx-tertiary">{description}</p>}
    </div>
  );

  const renderBrowseContent = () => {
    if (parentId !== null) {
      if (currentChildren.length === 0 && !draft) return renderEmpty("当前目录为空", "点击右上角加号创建文档或子目录。");
      return <>{draft && renderDraft()}{currentChildren.map((node) => (
        variant === "desktop" && allExpanded ? renderExpandedBranch(node) : renderNode(node)
      ))}</>;
    }
    if (rootOwned.length === 0 && rootShared.length === 0 && !draft) return renderEmpty("暂无内容", "点击右上角加号创建第一个根目录。");
    return (
      <>
        {(draft || rootOwned.length > 0) && (
          <section data-mobile-knowledge-tree-section="owned">
            <div className="flex items-center justify-between px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-tx-tertiary">
              <span>当前空间</span>
              <span
                className="min-w-4 rounded-full bg-app-hover px-1.5 text-center leading-4"
                aria-label={`当前空间共 ${ownedNotebookCount} 个笔记本`}
                data-mobile-knowledge-tree-notebook-count=""
              >
                {ownedNotebookCount}
              </span>
            </div>
            {draft && renderDraft()}
            {rootOwned.map((node) => (
              variant === "desktop" && allExpanded ? renderExpandedBranch(node) : renderNode(node)
            ))}
          </section>
        )}
        {rootShared.length > 0 && (
          <section className={cn("mt-2 border-t border-app-border pt-2", rootOwned.length === 0 && "mt-0 border-t-0 pt-0")} data-mobile-knowledge-tree-section="shared">
            <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-tx-tertiary">共享给我</div>
            {rootShared.map((node) => (
              variant === "desktop" && allExpanded ? renderExpandedBranch(node) : renderNode(node)
            ))}
          </section>
        )}
      </>
    );
  };

  return (
    <section
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      data-nowen-mobile-knowledge-tree={variant === "mobile" ? "flat-navigation" : undefined}
      data-nowen-desktop-knowledge-tree={variant === "desktop" ? "quick-navigation" : undefined}
    >
      <div className="px-2 pb-2">
        <div className={cn("grid grid-cols-2 bg-app-hover/70", variant === "mobile" ? "rounded-xl p-1" : "rounded-lg p-0.5")} role="tablist" aria-label="内容浏览方式">
          <button
            type="button"
            role="tab"
            aria-selected={view === "recent"}
            onClick={() => { setView("recent"); setQuery(""); }}
            className={cn(
              "flex items-center justify-center gap-1.5 px-3 text-xs font-medium transition-colors",
              variant === "mobile" ? "rounded-lg py-2" : "rounded-md py-1.5",
              view === "recent" ? "bg-app-bg text-tx-primary shadow-sm" : "text-tx-tertiary",
            )}
          >
            <Clock3 size={14} />最近
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "browse"}
            onClick={() => { setView("browse"); setQuery(""); }}
            className={cn(
              "flex items-center justify-center gap-1.5 px-3 text-xs font-medium transition-colors",
              variant === "mobile" ? "rounded-lg py-2" : "rounded-md py-1.5",
              view === "browse" ? "bg-app-bg text-tx-primary shadow-sm" : "text-tx-tertiary",
            )}
          >
            <TreePine size={14} />全部
          </button>
        </div>
      </div>

      <div className={cn("flex items-center px-2", variant === "mobile" ? "gap-1.5 pb-2" : "gap-0.5 pb-1.5")}>
        <div className={cn(
          "flex min-w-0 flex-1 items-center gap-2 border border-app-border bg-app-bg",
          variant === "mobile" ? "rounded-xl px-3 py-2" : "rounded-lg px-2.5 py-1.5",
        )}>
          <Search size={15} className="shrink-0 text-tx-tertiary" />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索目录与文档"
            className={cn("min-w-0 flex-1 bg-transparent text-tx-primary outline-none placeholder:text-tx-tertiary", variant === "mobile" ? "text-sm" : "text-xs")}
            data-mobile-knowledge-tree-search=""
          />
          {variant === "desktop" && (
            !query ? (
              <kbd
                aria-label="快捷键 Ctrl+K"
                className="inline-flex h-5 shrink-0 items-center rounded border border-app-border bg-app-hover px-1.5 font-sans text-[9px] font-medium text-tx-tertiary shadow-sm"
              >
                Ctrl K
              </kbd>
            ) : null
          )}
          {query && <button type="button" onClick={() => setQuery("")} className="text-tx-tertiary hover:text-tx-primary" aria-label="清空搜索"><X size={14} /></button>}
        </div>
        {view === "browse" && (
          <button
            type="button"
            onClick={() => void chooseSortMode()}
            className={cn(
              "flex shrink-0 items-center justify-center text-accent-primary hover:bg-app-hover",
              variant === "mobile" ? "h-9 w-9 rounded-lg" : "h-7 w-6 rounded-md",
            )}
            title={`排序：${SORT_LABELS[sortMode]}`}
            aria-label={`目录排序，当前为${SORT_LABELS[sortMode]}`}
          >
            <ArrowUpDown size={variant === "mobile" ? 16 : 13} />
          </button>
        )}
        {variant === "desktop" && view === "browse" && (
          <button
            type="button"
            onClick={() => setAllExpanded((current) => !current)}
            disabled={Boolean(query.trim()) || (!allExpanded && !hasExpandableContent)}
            className="flex h-7 w-6 shrink-0 items-center justify-center rounded-md text-tx-tertiary hover:bg-app-hover hover:text-tx-primary disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-tx-tertiary"
            title={query.trim() ? "清除搜索后可批量展开或收起" : allExpanded ? "全部收起" : "全部展开"}
            aria-label={allExpanded ? "全部收起" : "全部展开"}
          >{allExpanded ? <ChevronsUp size={14} /> : <ChevronsDown size={14} />}</button>
        )}
        <button
          type="button"
          onClick={(event) => openCreateDropdown(event, view === "browse" ? currentFolder : null)}
          disabled={view === "browse" && !!currentFolder && !currentFolder.access.capabilities.canCreate}
          className={cn(
            "flex shrink-0 items-center justify-center text-tx-tertiary hover:bg-app-hover hover:text-tx-primary disabled:opacity-40",
            variant === "mobile" ? "h-9 w-9 rounded-lg" : "h-7 w-6 rounded-md",
          )}
          title={currentFolder ? `在“${currentFolder.title}”中新建` : "新建"}
          aria-label={currentFolder ? `在“${currentFolder.title}”中新建` : "新建"}
          aria-haspopup="menu"
        >
          <Plus size={variant === "mobile" ? 17 : 14} />
        </button>
        <button
          type="button"
          onClick={() => void reload()}
          disabled={loading}
          className={cn(
            "flex shrink-0 items-center justify-center text-tx-tertiary hover:bg-app-hover hover:text-tx-primary disabled:opacity-50",
            variant === "mobile" ? "h-9 w-9 rounded-lg" : "h-7 w-6 rounded-md",
          )}
          title="刷新内容"
        ><RefreshCw size={variant === "mobile" ? 15 : 13} className={loading ? "animate-spin" : undefined} /></button>
      </div>

      {view === "browse" && !query && (
        <div className="flex min-h-10 items-center gap-1 border-y border-app-border/60 px-2 py-1.5" data-mobile-knowledge-tree-breadcrumb="">
          {currentFolder ? (
            <button type="button" onClick={goBack} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-tx-secondary hover:bg-app-hover" aria-label="返回上一级">
              <ArrowLeft size={17} />
            </button>
          ) : (
            <span className="h-8 w-2 shrink-0" />
          )}
          <div className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-xs text-tx-tertiary [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <button type="button" onClick={() => setParentId(null)} className={cn("rounded px-1.5 py-1", !currentFolder && "font-medium text-tx-primary")}>当前空间</button>
            {breadcrumbs.map((breadcrumb) => (
              <React.Fragment key={breadcrumb.id}>
                <span className="px-0.5">/</span>
                <button
                  type="button"
                  onClick={() => setParentId(breadcrumb.id)}
                  className={cn("rounded px-1.5 py-1", breadcrumb.id === parentId && "font-medium text-tx-primary")}
                >
                  {breadcrumb.title}
                </button>
              </React.Fragment>
            ))}
          </div>
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-1 pb-3" data-swipe-blocker="knowledge-tree-scroll">
        {loading && nodes.length === 0 ? (
          <div className="flex justify-center py-16"><Loader2 size={22} className="animate-spin text-tx-tertiary" /></div>
        ) : error ? (
          <div role="status" className="mx-2 mt-4 rounded-2xl border border-app-border bg-app-surface/70 px-5 py-6 text-center shadow-sm">
            <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
              <CircleAlert size={20} aria-hidden="true" />
            </span>
            <p className="mt-3 text-sm font-medium text-tx-primary">内容暂时未加载</p>
            <p className="mx-auto mt-1 max-w-[280px] text-xs leading-relaxed text-tx-tertiary">
              可能是网络波动或服务暂时不可用，本次加载失败不会修改你的笔记数据。
            </p>
            <button
              type="button"
              onClick={() => void reload()}
              className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-accent-primary px-3.5 py-2 text-xs font-medium text-white transition-colors hover:bg-accent-primary/90"
            >
              <RefreshCw size={13} aria-hidden="true" />
              重新加载
            </button>
            <details className="mx-auto mt-3 max-w-[280px] text-left text-[10px] text-tx-tertiary">
              <summary className="cursor-pointer select-none text-center hover:text-tx-secondary">查看错误详情</summary>
              <p className="mt-1.5 break-words rounded-md bg-app-bg px-2 py-1.5 leading-relaxed">{error}</p>
            </details>
          </div>
        ) : query.trim() ? (
          searchResults.length > 0 ? (
            <section data-mobile-knowledge-tree-view="search">
              <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-tx-tertiary">搜索结果 · {searchResults.length}</div>
              {searchResults.map((node) => renderNode(node, true))}
            </section>
          ) : renderEmpty("没有匹配内容", "可尝试缩短关键词或检查名称。")
        ) : view === "recent" ? (
          recentNodes.length > 0 ? (
            <section data-mobile-knowledge-tree-view="recent">
              <div className="px-3 pb-1 pt-2">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-tx-tertiary">最近使用</div>
                <div className="mt-0.5 text-[10px] text-tx-tertiary">最近打开优先，其他文档按最近更新时间补充</div>
              </div>
              {recentNodes.map((node) => renderNode(node, true))}
            </section>
          ) : renderEmpty("暂无最近文档", "打开过或最近更新的文档会出现在这里。")
        ) : renderBrowseContent()}

        {sharedLoadError && (
          <div className="mx-2 mt-2 flex items-center justify-between gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[10px] text-amber-600 dark:text-amber-400">
            <span className="min-w-0 flex-1 truncate" title={sharedLoadError}>共享内容加载失败</span>
            <button type="button" onClick={() => void reload()} className="shrink-0 underline underline-offset-2">重试</button>
          </div>
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
                setView("browse");
                setParentId(nodeId);
                setQuery("");
              }
            }}
            onChanged={(nodeId) => {
              setUnlockedFolderIds(forgetUnlockedFolder(nodeId));
              if (parentId === nodeId) {
                const changedNode = nodes.find((node) => node.id === nodeId);
                setParentId(changedNode?.parentId || null);
              }
              setNodes((current) => current.map((node) => (
                node.id === nodeId ? { ...node, isPasswordProtected: 1, isExpanded: 0 } : node
              )));
              emitTreeChanged("folder-password-changed");
            }}
          />
        )}
        {movingNode && <MovePanel node={movingNode} nodes={visibleNodes.filter((node) => isFolderUnlocked(node, unlockedFolderIds))} onMoved={() => void reload()} onClose={() => setMovingNode(null)} />}
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
      <KnowledgeTreeCreateDropdown
        menu={createMenu}
        onClose={closeCreateDropdown}
        onCreate={(targetParentId, kind) => {
          const parent = targetParentId ? visibleNodes.find((node) => node.id === targetParentId) || null : null;
          if (targetParentId && !parent) return;
          startInlineCreate(parent, kind);
        }}
        onImport={(targetParentId, kind) => { void importIntoTree(targetParentId, kind); }}
      />
    </section>
  );
}
