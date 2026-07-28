import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpDown,
  ChevronRight,
  Clock3,
  FileCode,
  FileText,
  Folder,
  Loader2,
  MoreHorizontal,
  Pin,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Star,
  TreePine,
  UserPlus,
  X,
} from "lucide-react";

import KnowledgeTreeNodeMenu from "@/components/KnowledgeTreeNodeMenu";
import { choose, confirm, prompt } from "@/components/ui/confirm";
import { useContextMenu } from "@/hooks/useContextMenu";
import { api } from "@/lib/api";
import {
  defaultInlineCreateTitle,
  normalizeInlineCreateTitle,
  type KnowledgeTreeInlineCreateKind,
} from "@/lib/knowledgeTreeInlineCreate";
import {
  knowledgeTreeApi,
  type KnowledgePermissionRow,
  type KnowledgeRolePreset,
  type KnowledgeTreeNode,
} from "@/lib/knowledgeTreeApi";
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

const ROLE_LABELS: Record<KnowledgeRolePreset, string> = {
  readonly: "只读成员",
  editor: "编辑成员",
  maintainer: "维护成员",
  admin: "管理员",
};

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

function PermissionsPanel({ node, onClose }: { node: KnowledgeTreeNode; onClose: () => void }) {
  const [rows, setRows] = useState<KnowledgePermissionRow[]>([]);
  const [inheritsFromParent, setInheritsFromParent] = useState<string | null>(null);
  const [subject, setSubject] = useState("");
  const [role, setRole] = useState<KnowledgeRolePreset>("readonly");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const response = await knowledgeTreeApi.getPermissions(node.id);
      setRows(response.direct);
      setInheritsFromParent(response.inheritsFromParent);
    } catch (error: any) {
      toast.error(error?.message || "读取权限失败");
    } finally {
      setLoading(false);
    }
  }, [node.id]);

  useEffect(() => { void reload(); }, [reload]);

  const addMember = async () => {
    if (!subject.trim() || saving) return;
    setSaving(true);
    try {
      await knowledgeTreeApi.setPermission(node.id, subject.trim(), role);
      setSubject("");
      await reload();
      emitTreeChanged("permission-updated");
      toast.success("成员权限已更新");
    } catch (error: any) {
      toast.error(error?.message || "更新权限失败");
    } finally {
      setSaving(false);
    }
  };

  const restoreInheritance = async (row: KnowledgePermissionRow) => {
    const ok = await confirm({
      title: "恢复继承权限？",
      description: `${row.displayName || row.username} 将改为继承上级节点的权限。`,
      confirmText: "恢复继承",
    });
    if (!ok) return;
    try {
      await knowledgeTreeApi.clearPermission(node.id, row.userId);
      await reload();
      emitTreeChanged("permission-inheritance-restored");
      toast.success("已恢复继承");
    } catch (error: any) {
      toast.error(error?.message || "操作失败");
    }
  };

  return (
    <div className="absolute inset-0 z-[220] flex flex-col bg-app-sidebar">
      <header className="flex h-12 items-center gap-2 border-b border-app-border px-3">
        <ShieldCheck size={17} className="text-accent-primary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-tx-primary">成员与权限</div>
          <div className="truncate text-[10px] text-tx-tertiary">{node.title}</div>
        </div>
        <button type="button" onClick={onClose} className="rounded-md p-2 text-tx-tertiary hover:bg-app-hover" aria-label="关闭权限面板"><X size={17} /></button>
      </header>

      <div className="border-b border-app-border p-3">
        <div className="mb-2 flex items-center gap-1.5 text-xs text-tx-secondary"><UserPlus size={14} />添加成员</div>
        <div className="flex flex-col gap-2">
          <input
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void addMember(); }}
            placeholder="用户名、邮箱或用户 ID"
            className="w-full rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-tx-primary outline-none focus:border-accent-primary"
          />
          <div className="flex gap-2">
            <select
              value={role}
              onChange={(event) => setRole(event.target.value as KnowledgeRolePreset)}
              className="min-w-0 flex-1 rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-tx-primary"
            >
              {(Object.keys(ROLE_LABELS) as KnowledgeRolePreset[]).map((preset) => (
                <option key={preset} value={preset}>{ROLE_LABELS[preset]}</option>
              ))}
            </select>
            <button
              type="button"
              disabled={!subject.trim() || saving}
              onClick={() => void addMember()}
              className="flex min-w-20 items-center justify-center rounded-lg bg-accent-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              {saving ? <Loader2 size={15} className="animate-spin" /> : "添加"}
            </button>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {inheritsFromParent && (
          <div className="mb-2 rounded-lg border border-app-border bg-app-hover/50 px-3 py-2 text-xs text-tx-tertiary">
            没有直接设置的成员将继承上级节点权限。
          </div>
        )}
        {loading ? (
          <div className="flex justify-center py-10"><Loader2 size={20} className="animate-spin text-tx-tertiary" /></div>
        ) : rows.length === 0 ? (
          <div className="py-10 text-center text-xs text-tx-tertiary">当前节点全部继承上级权限。</div>
        ) : rows.map((row) => (
          <div key={row.userId} className="mb-1 flex items-center gap-2 rounded-xl px-2 py-2.5 hover:bg-app-hover/60">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-primary/10 text-sm font-semibold text-accent-primary">
              {(row.displayName || row.username || "?").slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-tx-primary">{row.displayName || row.username}</div>
              <div className="truncate text-[10px] text-tx-tertiary">直接设置 · {ROLE_LABELS[row.rolePreset]}</div>
            </div>
            <button type="button" onClick={() => void restoreInheritance(row)} className="rounded-lg px-2 py-1.5 text-[10px] text-tx-tertiary hover:bg-app-active hover:text-tx-primary">
              恢复继承
            </button>
          </div>
        ))}
      </div>
    </div>
  );
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

export default function MobileKnowledgeTreePanel() {
  const { state } = useApp();
  const actions = useAppActions();
  const searchRef = useRef<HTMLInputElement>(null);
  const longPressRef = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const [nodes, setNodes] = useState<KnowledgeTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sharedLoadError, setSharedLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<MobileView>("recent");
  const [parentId, setParentId] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<MobileKnowledgeTreeSortMode>(() => loadMobileKnowledgeTreeSortMode());
  const [recentEntries, setRecentEntries] = useState<MobileKnowledgeTreeRecentEntry[]>(() => loadMobileKnowledgeTreeRecentEntries());
  const [permissionsNode, setPermissionsNode] = useState<KnowledgeTreeNode | null>(null);
  const [movingNode, setMovingNode] = useState<KnowledgeTreeNode | null>(null);
  const { menu, menuRef, openMenu, openMenuAt, closeMenu } = useContextMenu();
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
      setNodes(merged);
      setParentId((current) => {
        if (!current) return null;
        const parent = merged.find((node) => node.id === current && node.isDeleted !== 1);
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

  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const currentFolder = parentId ? byId.get(parentId) || null : null;
  const breadcrumbs = useMemo(() => {
    if (!currentFolder) return [];
    return [...getMobileKnowledgeTreeAncestors(currentFolder, nodes), currentFolder];
  }, [currentFolder, nodes]);
  const currentChildren = useMemo(
    () => getMobileKnowledgeTreeChildren(nodes, parentId, sortMode),
    [nodes, parentId, sortMode],
  );
  const recentNodes = useMemo(
    () => buildMobileKnowledgeTreeRecentNodes(nodes, recentEntries),
    [nodes, recentEntries],
  );
  const searchResults = useMemo(
    () => filterMobileKnowledgeTreeNodes(nodes, query, sortMode),
    [nodes, query, sortMode],
  );
  const rootOwned = useMemo(() => currentChildren.filter((node) => !node.sharedRootId), [currentChildren]);
  const rootShared = useMemo(() => currentChildren.filter((node) => Boolean(node.sharedRootId)), [currentChildren]);

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
    actions.setMobileSidebar(false);
  }, [actions]);

  const openDocument = useCallback(async (node: KnowledgeTreeNode) => {
    closeMenu();
    if (node.nodeType === "folder") {
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
  }, [activateNote, closeMenu, rememberOpened]);

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

  const createNode = useCallback(async (
    parent: KnowledgeTreeNode | null,
    kind: KnowledgeTreeInlineCreateKind,
  ) => {
    if (parent && !parent.access.capabilities.canCreate) return;
    if (!parent && kind !== "folder") return;
    const title = await prompt({
      title: kind === "folder" ? "新建文件夹" : kind === "markdown" ? "新建 Markdown 文档" : "新建文档",
      defaultValue: defaultInlineCreateTitle(kind),
      confirmText: "创建",
      validate: (value) => normalizeInlineCreateTitle(value) ? null : "名称不能为空",
    });
    if (title == null) return;
    const normalizedTitle = normalizeInlineCreateTitle(title);
    if (!normalizedTitle) return;
    try {
      const created = await knowledgeTreeApi.create({
        parentId: parent?.id || null,
        nodeType: kind,
        title: normalizedTitle,
      });
      emitTreeChanged("node-created-mobile");
      await reload();
      actions.refreshNotebooks();
      actions.refreshNotes();
      if (kind === "folder") {
        toast.success("已创建文件夹");
        return;
      }
      rememberOpened(created.id);
      activateNote(await api.getNote(created.resourceId));
    } catch (requestError: any) {
      toast.error(requestError?.message || "创建失败");
    }
  }, [actions, activateNote, reload, rememberOpened]);

  const openCreateMenu = useCallback(async (parent: KnowledgeTreeNode | null) => {
    if (!parent) {
      await createNode(null, "folder");
      return;
    }
    const choice = await choose({
      title: `在“${parent.title}”中新建`,
      choices: [
        { value: "note", label: "文档" },
        { value: "markdown", label: "Markdown 文档" },
        { value: "folder", label: "文件夹" },
      ],
    });
    if (choice === "note" || choice === "markdown" || choice === "folder") {
      await createNode(parent, choice);
    }
  }, [createNode]);

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

  const renderNode = (node: KnowledgeTreeNode, showPath = false) => {
    const active = node.resourceType === "note" && state.activeNote?.id === node.resourceId;
    const hasChildren = node.childCount > 0 || nodes.some((candidate) => candidate.parentId === node.id);
    const path = showPath ? buildMobileKnowledgeTreePath(node, nodes) : "";
    const updatedAt = formatUpdatedAt(node.updatedAt);
    return (
      <div
        key={node.id}
        className={cn(
          "group relative mx-1 mb-0.5 flex min-h-12 min-w-0 items-center rounded-xl text-tx-secondary active:bg-app-active/80",
          active ? "bg-app-active text-tx-primary" : "hover:bg-app-hover hover:text-tx-primary",
        )}
        onContextMenu={(event) => openMenu(event, node.id, "knowledge-node")}
        onTouchStart={(event) => beginLongPress(event, node)}
        onTouchMove={moveLongPress}
        onTouchEnd={cancelLongPress}
        onTouchCancel={cancelLongPress}
        data-mobile-knowledge-tree-node-id={node.id}
      >
        <button
          type="button"
          onClick={() => void openDocument(node)}
          className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2.5 text-left"
          title={node.title}
        >
          {nodeIcon(node)}
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-sm">{node.title}</span>
              {node.resourceType === "note" && node.isPinned === 1 && <Pin size={11} className="shrink-0 fill-current text-accent-primary" />}
              {node.resourceType === "note" && node.isFavorite === 1 && <Star size={11} className="shrink-0 fill-current text-amber-400" />}
              {isSharedRoot(node) && <span className="shrink-0 rounded bg-accent-primary/10 px-1 text-[9px] text-accent-primary">共享</span>}
            </span>
            {(showPath || updatedAt) && (
              <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[10px] text-tx-tertiary">
                {showPath && <span className="min-w-0 truncate">{path}</span>}
                {showPath && updatedAt && <span className="shrink-0">·</span>}
                {updatedAt && <span className="shrink-0">{updatedAt}</span>}
              </span>
            )}
          </span>
          {node.nodeType === "folder" && <ChevronRight size={16} className="shrink-0 text-tx-tertiary" />}
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
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-tx-tertiary hover:bg-app-active hover:text-tx-primary"
            aria-label={`查看“${node.title}”的子内容`}
          >
            <ChevronRight size={16} />
          </button>
        )}
        {node.access.capabilities.canCreate && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              void openCreateMenu(node);
            }}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-tx-tertiary hover:bg-app-active hover:text-tx-primary"
            aria-label={`在“${node.title}”下新建内容`}
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
          className="mr-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-tx-tertiary hover:bg-app-active hover:text-tx-primary"
          aria-label={`更多：${node.title}`}
        >
          <MoreHorizontal size={17} />
        </button>
      </div>
    );
  };

  const renderEmpty = (title: string, description?: string) => (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <TreePine size={30} className="mb-2 text-tx-tertiary/35" />
      <p className="text-sm text-tx-secondary">{title}</p>
      {description && <p className="mt-1 text-xs leading-relaxed text-tx-tertiary">{description}</p>}
    </div>
  );

  const renderBrowseContent = () => {
    if (parentId !== null) {
      if (currentChildren.length === 0) return renderEmpty("当前目录为空", "点击右上角加号创建文档或子目录。");
      return <>{currentChildren.map((node) => renderNode(node))}</>;
    }
    if (rootOwned.length === 0 && rootShared.length === 0) return renderEmpty("暂无内容", "点击右上角加号创建第一个根目录。");
    return (
      <>
        {rootOwned.length > 0 && (
          <section data-mobile-knowledge-tree-section="owned">
            <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-tx-tertiary">当前空间</div>
            {rootOwned.map((node) => renderNode(node))}
          </section>
        )}
        {rootShared.length > 0 && (
          <section className={cn("mt-2 border-t border-app-border pt-2", rootOwned.length === 0 && "mt-0 border-t-0 pt-0")} data-mobile-knowledge-tree-section="shared">
            <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-tx-tertiary">共享给我</div>
            {rootShared.map((node) => renderNode(node))}
          </section>
        )}
      </>
    );
  };

  return (
    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-nowen-mobile-knowledge-tree="flat-navigation">
      <div className="px-2 pb-2">
        <div className="grid grid-cols-2 rounded-xl bg-app-hover/70 p-1" role="tablist" aria-label="内容浏览方式">
          <button
            type="button"
            role="tab"
            aria-selected={view === "recent"}
            onClick={() => { setView("recent"); setQuery(""); }}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors",
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
              "flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors",
              view === "browse" ? "bg-app-bg text-tx-primary shadow-sm" : "text-tx-tertiary",
            )}
          >
            <TreePine size={14} />全部
          </button>
        </div>
      </div>

      <div className="flex items-center gap-1.5 px-2 pb-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-app-border bg-app-bg px-3 py-2">
          <Search size={15} className="shrink-0 text-tx-tertiary" />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索目录与文档"
            className="min-w-0 flex-1 bg-transparent text-sm text-tx-primary outline-none placeholder:text-tx-tertiary"
            data-mobile-knowledge-tree-search=""
          />
          {query && <button type="button" onClick={() => setQuery("")} className="text-tx-tertiary hover:text-tx-primary" aria-label="清空搜索"><X size={14} /></button>}
        </div>
        {view === "browse" && (
          <button
            type="button"
            onClick={() => void chooseSortMode()}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-accent-primary hover:bg-app-hover"
            title={`排序：${SORT_LABELS[sortMode]}`}
            aria-label={`目录排序，当前为${SORT_LABELS[sortMode]}`}
          >
            <ArrowUpDown size={16} />
          </button>
        )}
        <button
          type="button"
          onClick={() => void openCreateMenu(view === "browse" ? currentFolder : null)}
          disabled={view === "browse" && !!currentFolder && !currentFolder.access.capabilities.canCreate}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-tx-tertiary hover:bg-app-hover hover:text-tx-primary disabled:opacity-40"
          title={currentFolder ? `在“${currentFolder.title}”中新建` : "新建根文件夹"}
          aria-label={currentFolder ? `在“${currentFolder.title}”中新建` : "新建根文件夹"}
        >
          <Plus size={17} />
        </button>
        <button type="button" onClick={() => void reload()} disabled={loading} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-tx-tertiary hover:bg-app-hover hover:text-tx-primary disabled:opacity-50" title="刷新内容"><RefreshCw size={15} className={loading ? "animate-spin" : undefined} /></button>
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
          <div className="mx-2 mt-4 rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-center">
            <p className="text-sm font-medium text-red-500">内容加载失败</p>
            <p className="mt-1 break-words text-xs text-tx-tertiary">{error}</p>
            <button type="button" onClick={() => void reload()} className="mt-3 rounded-lg bg-accent-primary px-3 py-1.5 text-xs font-medium text-white">重试</button>
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

        {permissionsNode && <PermissionsPanel node={permissionsNode} onClose={() => setPermissionsNode(null)} />}
        {movingNode && <MovePanel node={movingNode} nodes={nodes} onMoved={() => void reload()} onClose={() => setMovingNode(null)} />}
      </div>

      <KnowledgeTreeNodeMenu
        menu={menu}
        menuRef={menuRef}
        node={menuNode}
        nodes={nodes}
        onClose={closeMenu}
        onOpen={openDocument}
        onSplit={openSplit}
        onCreate={(node, kind) => { void createNode(node, kind); }}
        onRename={rename}
        onMove={setMovingNode}
        onPermissions={setPermissionsNode}
        onDelete={remove}
        onReload={reload}
        onNotePatched={patchNoteStatus}
      />
    </section>
  );
}
