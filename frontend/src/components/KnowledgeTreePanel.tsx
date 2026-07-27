import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  FileCode,
  FileText,
  Folder,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  SplitSquareHorizontal,
  SplitSquareVertical,
  Trash2,
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
  type KnowledgeTreeInlineDraft,
} from "@/lib/knowledgeTreeInlineCreate";
import {
  knowledgeTreeApi,
  type KnowledgePermissionRow,
  type KnowledgeRolePreset,
  type KnowledgeTreeNode,
} from "@/lib/knowledgeTreeApi";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  canMoveWithinSharedRoot,
  filterKnowledgeTreeNodes,
  isSharedRoot,
} from "@/lib/sharedKnowledgeTree";
import { useApp, useAppActions } from "@/store/AppContext";

export const FOCUS_KNOWLEDGE_TREE_EVENT = "nowen:focus-knowledge-tree";
export const KNOWLEDGE_TREE_CHANGED_EVENT = "nowen:knowledge-tree-changed";

const ROLE_LABELS: Record<KnowledgeRolePreset, string> = {
  readonly: "只读成员",
  editor: "编辑成员",
  maintainer: "维护成员",
  admin: "管理员",
};

function buildChildren(nodes: KnowledgeTreeNode[]) {
  const result = new Map<string | null, KnowledgeTreeNode[]>();
  for (const node of nodes) {
    const siblings = result.get(node.parentId) || [];
    siblings.push(node);
    result.set(node.parentId, siblings);
  }
  for (const siblings of result.values()) {
    siblings.sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
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
      <header className="flex h-11 items-center gap-2 border-b border-app-border px-3">
        <ShieldCheck size={16} className="text-accent-primary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-tx-primary">成员与权限</div>
          <div className="truncate text-[10px] text-tx-tertiary">{node.title}</div>
        </div>
        <button type="button" onClick={onClose} className="rounded-md p-1.5 text-tx-tertiary hover:bg-app-hover" aria-label="关闭权限面板"><X size={16} /></button>
      </header>

      <div className="border-b border-app-border p-3">
        <div className="mb-2 flex items-center gap-1.5 text-xs text-tx-secondary"><UserPlus size={13} />添加成员</div>
        <div className="flex gap-2">
          <input
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void addMember(); }}
            placeholder="用户名、邮箱或用户 ID"
            className="min-w-0 flex-1 rounded-md border border-app-border bg-app-bg px-2.5 py-1.5 text-sm text-tx-primary outline-none focus:border-accent-primary"
          />
          <select
            value={role}
            onChange={(event) => setRole(event.target.value as KnowledgeRolePreset)}
            className="rounded-md border border-app-border bg-app-bg px-2 text-xs text-tx-primary"
          >
            {(Object.keys(ROLE_LABELS) as KnowledgeRolePreset[]).map((preset) => (
              <option key={preset} value={preset}>{ROLE_LABELS[preset]}</option>
            ))}
          </select>
          <button
            type="button"
            disabled={!subject.trim() || saving}
            onClick={() => void addMember()}
            className="rounded-md bg-accent-primary px-3 text-xs font-medium text-white disabled:opacity-40"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : "添加"}
          </button>
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-tx-tertiary">
          编辑成员不能移动或删除；维护成员可移动和删除；管理员可以管理成员与再次分享。
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {inheritsFromParent && (
          <div className="mb-2 rounded-md border border-app-border bg-app-hover/50 px-2.5 py-2 text-xs text-tx-tertiary">
            没有直接设置的成员将继承上级节点权限。
          </div>
        )}
        {loading ? (
          <div className="flex justify-center py-10"><Loader2 size={18} className="animate-spin text-tx-tertiary" /></div>
        ) : rows.length === 0 ? (
          <div className="py-10 text-center text-xs text-tx-tertiary">当前节点全部继承上级权限。</div>
        ) : rows.map((row) => (
          <div key={row.userId} className="mb-1 flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-app-hover/60">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-primary/10 text-xs font-semibold text-accent-primary">
              {(row.displayName || row.username || "?").slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-tx-primary">{row.displayName || row.username}</div>
              <div className="truncate text-[10px] text-tx-tertiary">直接设置 · {ROLE_LABELS[row.rolePreset]}</div>
            </div>
            <button type="button" onClick={() => void restoreInheritance(row)} className="rounded-md px-2 py-1 text-[10px] text-tx-tertiary hover:bg-app-active hover:text-tx-primary">
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
}

export function KnowledgeTreePanel({
  variant = "desktop",
  className,
}: KnowledgeTreePanelProps) {
  const { state } = useApp();
  const actions = useAppActions();
  const surfaceActive = useActiveSidebarSurface(variant);
  const searchRef = useRef<HTMLInputElement>(null);
  const draftInputRef = useRef<HTMLInputElement>(null);
  const [nodes, setNodes] = useState<KnowledgeTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sharedLoadError, setSharedLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<KnowledgeTreeInlineDraft | null>(null);
  const [permissionsNode, setPermissionsNode] = useState<KnowledgeTreeNode | null>(null);
  const [movingNode, setMovingNode] = useState<KnowledgeTreeNode | null>(null);
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

  const allChildren = useMemo(() => buildChildren(nodes), [nodes]);
  const filteredNodes = useMemo(() => filterKnowledgeTreeNodes(nodes, query), [nodes, query]);
  const children = useMemo(() => buildChildren(filteredNodes), [filteredNodes]);
  const effectiveExpanded = query.trim() ? new Set(filteredNodes.map((node) => node.id)) : expanded;

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

  const toggle = async (node: KnowledgeTreeNode) => {
    const next = new Set(expanded);
    const opening = !next.has(node.id);
    if (opening) next.add(node.id); else next.delete(node.id);
    setExpanded(next);
    if (!node.sharedRootId) {
      try { await knowledgeTreeApi.update(node.id, { isExpanded: opening }); } catch { /* local navigation remains usable */ }
    }
  };

  const openDocument = async (node: KnowledgeTreeNode) => {
    closeMenu();
    if (node.nodeType === "folder") {
      await toggle(node);
      return;
    }
    if (node.resourceType !== "note") return;
    try {
      activateNote(await api.getNote(node.resourceId));
    } catch (requestError: any) {
      toast.error(requestError?.message || "打开文档失败");
    }
  };

  const openSplit = (node: KnowledgeTreeNode, direction: "right" | "down") => {
    if (node.resourceType !== "note") return;
    actions.splitEditor({ noteId: node.resourceId, direction });
    closeMenu();
  };

  const startInlineCreate = useCallback((parent: KnowledgeTreeNode | null, kind: KnowledgeTreeInlineCreateKind) => {
    if (parent && !parent.access.capabilities.canCreate) return;
    if (!parent && kind !== "folder") return;
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
  }, [closeMenu]);

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

  const renderDraft = (depth: number) => {
    if (!draft) return null;
    return (
      <div
        key={`inline-create:${draft.parentId ?? "root"}`}
        className={cn(
          "rounded-md bg-accent-primary/5",
          draft.error && "bg-red-500/5",
        )}
        style={{ paddingLeft: `${depth * 16 + 2}px` }}
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
    return (
      <div key={node.id}>
        <div
          className={cn(
            "group relative flex min-w-0 items-center rounded-md text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
            active && "bg-app-active text-tx-primary",
          )}
          style={{ paddingLeft: `${depth * 16 + 2}px` }}
          draggable={node.access.capabilities.canMove && !isSharedRoot(node)}
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("application/x-nowen-tree-node", node.id);
          }}
          onDragOver={(event) => {
            if (!node.access.capabilities.canCreate) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }}
          onDrop={(event) => {
            if (!node.access.capabilities.canCreate) return;
            event.preventDefault();
            void dropMove(event.dataTransfer.getData("application/x-nowen-tree-node"), node.id);
          }}
          onContextMenu={(event) => openMenu(event, node.id, "knowledge-node")}
          onTouchStart={(event) => beginLongPress(event, node)}
          onTouchMove={moveLongPress}
          onTouchEnd={cancelLongPress}
          onTouchCancel={cancelLongPress}
          data-knowledge-tree-node-id={node.id}
        >
          <button type="button" onClick={() => hasChildren && void toggle(node)} className="flex h-7 w-5 shrink-0 items-center justify-center text-tx-tertiary" aria-label={isExpanded ? "折叠" : "展开"}>
            {hasChildren ? (isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : null}
          </button>
          <button
            type="button"
            onClick={(event) => {
              if ((event.ctrlKey || event.metaKey) && node.resourceType === "note") openSplit(node, "right");
              else void openDocument(node);
            }}
            className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left text-xs"
            title={node.title}
          >
            {nodeIcon(node)}
            <span className="min-w-0 flex-1 truncate">{node.title}</span>
            {isSharedRoot(node) && <span className="rounded bg-accent-primary/10 px-1 text-[9px] text-accent-primary">共享</span>}
            {node.access.source === "inherited" && <span className="rounded bg-app-active px-1 text-[9px] text-tx-tertiary">继承</span>}
          </button>
          {node.access.capabilities.canCreate && (
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
  const hasRootDraft = draft?.parentId === null;

  return (
    <section className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col", className)} data-nowen-knowledge-tree="embedded" data-sidebar-surface-active={surfaceActive ? "true" : "false"}>
      <div className="flex items-center gap-1.5 px-2 pb-1.5">
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
          onClick={() => startInlineCreate(null, "folder")}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-tx-tertiary hover:bg-app-hover hover:text-tx-primary"
          title="新建根文件夹"
        ><Plus size={14} /></button>
        <button type="button" onClick={() => void reload()} disabled={loading} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-tx-tertiary hover:bg-app-hover hover:text-tx-primary disabled:opacity-50" title="刷新内容树"><RefreshCw size={13} className={loading ? "animate-spin" : undefined} /></button>
      </div>

      <div className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-1 pb-3" data-swipe-blocker="knowledge-tree-scroll">
        {loading && nodes.length === 0 ? (
          <div className="flex justify-center py-14"><Loader2 size={20} className="animate-spin text-tx-tertiary" /></div>
        ) : error ? (
          <div className="mx-2 mt-4 rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-center">
            <p className="text-xs font-medium text-red-500">内容树加载失败</p>
            <p className="mt-1 break-words text-[10px] text-tx-tertiary">{error}</p>
            <div className="mt-3 flex justify-center gap-2">
              <button type="button" onClick={() => void reload()} className="rounded-md bg-accent-primary px-2.5 py-1 text-[10px] font-medium text-white">重试</button>
            </div>
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
                <div className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-tx-tertiary">当前空间</div>
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
        {permissionsNode && <PermissionsPanel node={permissionsNode} onClose={() => setPermissionsNode(null)} />}
        {movingNode && <MovePanel node={movingNode} nodes={nodes} children={allChildren} onMoved={() => void reload()} onClose={() => setMovingNode(null)} />}
      </div>
      <KnowledgeTreeNodeMenu
        menu={menu}
        menuRef={menuRef}
        node={menuNode}
        nodes={nodes}
        onClose={closeMenu}
        onOpen={openDocument}
        onSplit={openSplit}
        onCreate={startInlineCreate}
        onRename={rename}
        onMove={setMovingNode}
        onPermissions={setPermissionsNode}
        onDelete={remove}
        onReload={reload}
      />
    </section>
  );
}

export default KnowledgeTreePanel;
