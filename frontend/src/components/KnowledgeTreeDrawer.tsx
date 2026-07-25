import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
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

import { choose, confirm, prompt } from "@/components/ui/confirm";
import { api } from "@/lib/api";
import {
  knowledgeTreeApi,
  type KnowledgePermissionRow,
  type KnowledgeRolePreset,
  type KnowledgeTreeNode,
} from "@/lib/knowledgeTreeApi";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { useAppActions } from "@/store/AppContext";

export const OPEN_KNOWLEDGE_TREE_EVENT = "nowen:open-knowledge-tree";

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
  if (node.nodeType === "folder") return <Folder size={15} className="text-amber-500" />;
  if (node.nodeType === "markdown") return <FileCode size={15} className="text-emerald-500" />;
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
      toast.success("已恢复继承");
    } catch (error: any) {
      toast.error(error?.message || "操作失败");
    }
  };

  return (
    <div className="absolute inset-0 z-[220] flex flex-col bg-app-elevated">
      <header className="flex h-12 items-center gap-2 border-b border-app-border px-3">
        <ShieldCheck size={16} className="text-accent-primary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-tx-primary">成员与权限</div>
          <div className="truncate text-[10px] text-tx-tertiary">{node.title}</div>
        </div>
        <button type="button" onClick={onClose} className="rounded-md p-1.5 text-tx-tertiary hover:bg-app-hover"><X size={16} /></button>
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
  const candidates = nodes.filter((candidate) => !blocked.has(candidate.id) && candidate.access.capabilities.canCreate);

  const move = async (parentId: string) => {
    try {
      await knowledgeTreeApi.move(node.id, { parentId });
      toast.success("已移动");
      onMoved();
      onClose();
    } catch (error: any) {
      toast.error(error?.message || "移动失败");
    }
  };

  return (
    <div className="absolute inset-0 z-[220] flex flex-col bg-app-elevated">
      <header className="flex h-12 items-center gap-2 border-b border-app-border px-3">
        <Folder size={16} className="text-amber-500" />
        <div className="min-w-0 flex-1 truncate text-sm font-semibold text-tx-primary">移动“{node.title}”</div>
        <button type="button" onClick={onClose} className="rounded-md p-1.5 text-tx-tertiary hover:bg-app-hover"><X size={16} /></button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {candidates.map((candidate) => (
          <button key={candidate.id} type="button" onClick={() => void move(candidate.id)} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-tx-secondary hover:bg-app-hover hover:text-tx-primary">
            {nodeIcon(candidate)}<span className="truncate">{candidate.title}</span>
          </button>
        ))}
        {candidates.length === 0 && <p className="py-10 text-center text-xs text-tx-tertiary">没有可用目标节点</p>}
      </div>
    </div>
  );
}

export default function KnowledgeTreeDrawer() {
  const actions = useAppActions();
  const [open, setOpen] = useState(false);
  const [nodes, setNodes] = useState<KnowledgeTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menuNodeId, setMenuNodeId] = useState<string | null>(null);
  const [permissionsNode, setPermissionsNode] = useState<KnowledgeTreeNode | null>(null);
  const [movingNode, setMovingNode] = useState<KnowledgeTreeNode | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const response = await knowledgeTreeApi.list();
      setNodes(response.nodes);
      setExpanded((current) => current.size
        ? current
        : new Set(response.nodes.filter((node) => node.parentId === null || node.isExpanded).map((node) => node.id)));
    } catch (error: any) {
      toast.error(error?.message || "加载知识树失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const show = () => setOpen(true);
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      }
      if (event.key === "Escape") {
        setMenuNodeId(null);
        setPermissionsNode(null);
        setMovingNode(null);
      }
    };
    window.addEventListener(OPEN_KNOWLEDGE_TREE_EVENT, show);
    window.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener(OPEN_KNOWLEDGE_TREE_EVENT, show);
      window.removeEventListener("keydown", keydown);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      setMenuNodeId(null);
      void reload();
    }
  }, [open, reload]);

  const allChildren = useMemo(() => buildChildren(nodes), [nodes]);
  const filteredNodes = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return nodes;
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const visible = new Set(nodes.filter((node) => node.title.toLocaleLowerCase().includes(normalized)).map((node) => node.id));
    for (const id of Array.from(visible)) {
      let parentId = byId.get(id)?.parentId;
      while (parentId) {
        visible.add(parentId);
        parentId = byId.get(parentId)?.parentId;
      }
    }
    return nodes.filter((node) => visible.has(node.id));
  }, [nodes, query]);
  const children = useMemo(() => buildChildren(filteredNodes), [filteredNodes]);
  const effectiveExpanded = query.trim() ? new Set(filteredNodes.map((node) => node.id)) : expanded;

  const toggle = async (node: KnowledgeTreeNode) => {
    const next = new Set(expanded);
    const opening = !next.has(node.id);
    if (opening) next.add(node.id); else next.delete(node.id);
    setExpanded(next);
    try { await knowledgeTreeApi.update(node.id, { isExpanded: opening }); } catch { /* preference only */ }
  };

  const openDocument = async (node: KnowledgeTreeNode) => {
    setMenuNodeId(null);
    if (node.nodeType === "folder") {
      await toggle(node);
      return;
    }
    if (node.resourceType !== "note") return;
    try {
      const note = await api.getNote(node.resourceId);
      actions.setActiveNote(note);
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
      setOpen(false);
    } catch (error: any) {
      toast.error(error?.message || "打开文档失败");
    }
  };

  const openSplit = (node: KnowledgeTreeNode, direction: "right" | "down") => {
    if (node.resourceType !== "note") return;
    actions.splitEditor({ noteId: node.resourceId, direction });
    setMenuNodeId(null);
    setOpen(false);
  };

  const createChild = async (parent: KnowledgeTreeNode | null) => {
    setMenuNodeId(null);
    const choice = await choose({
      title: parent ? `在“${parent.title}”下新建` : "新建根内容",
      choices: parent
        ? [
            { value: "folder", label: "子文件夹" },
            { value: "note", label: "子文档" },
            { value: "markdown", label: "Markdown 文档" },
            { value: "word", label: "Word 文档" },
          ]
        : [{ value: "folder", label: "根文件夹" }],
    });
    if (!choice || !["folder", "note", "markdown", "word"].includes(choice)) return;
    const title = await prompt({
      title: "输入名称",
      confirmText: "创建",
      validate: (value) => value.trim() ? null : "名称不能为空",
    });
    if (title == null) return;
    try {
      await knowledgeTreeApi.create({
        parentId: parent?.id || null,
        nodeType: choice as "folder" | "note" | "markdown" | "word",
        title: title.trim(),
      });
      if (parent) setExpanded((current) => new Set(current).add(parent.id));
      await reload();
      toast.success("已创建");
    } catch (error: any) {
      toast.error(error?.message || "创建失败");
    }
  };

  const rename = async (node: KnowledgeTreeNode) => {
    setMenuNodeId(null);
    const title = await prompt({ title: "重命名", defaultValue: node.title, confirmText: "保存" });
    if (title == null || !title.trim() || title.trim() === node.title) return;
    try {
      await knowledgeTreeApi.update(node.id, { title: title.trim() });
      await reload();
      toast.success("已重命名");
    } catch (error: any) {
      toast.error(error?.message || "重命名失败");
    }
  };

  const remove = async (node: KnowledgeTreeNode) => {
    setMenuNodeId(null);
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
      await reload();
      toast.success("已移入回收站");
    } catch (error: any) {
      toast.error(error?.message || "删除失败");
    }
  };

  const dropMove = async (sourceId: string, targetId: string) => {
    if (!sourceId || sourceId === targetId) return;
    try {
      await knowledgeTreeApi.move(sourceId, { parentId: targetId });
      setExpanded((current) => new Set(current).add(targetId));
      await reload();
      toast.success("已移动");
    } catch (error: any) {
      toast.error(error?.message || "移动失败");
    }
  };

  const renderNode = (node: KnowledgeTreeNode, depth: number): React.ReactNode => {
    const childNodes = children.get(node.id) || [];
    const hasChildren = childNodes.length > 0 || node.childCount > 0;
    const isExpanded = effectiveExpanded.has(node.id);
    const menuOpen = menuNodeId === node.id;
    return (
      <div key={node.id}>
        <div
          className="group relative flex min-w-0 items-center rounded-md text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
          style={{ paddingLeft: `${depth * 16 + 4}px` }}
          draggable={node.access.capabilities.canMove}
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
        >
          <button type="button" onClick={() => hasChildren && void toggle(node)} className="flex h-7 w-5 shrink-0 items-center justify-center text-tx-tertiary">
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
            {node.access.source === "inherited" && <span className="rounded bg-app-active px-1 text-[9px] text-tx-tertiary">继承</span>}
          </button>
          {node.access.capabilities.canCreate && (
            <button type="button" onClick={() => void createChild(node)} className="hidden h-6 w-6 items-center justify-center rounded text-tx-tertiary hover:bg-app-active group-hover:flex" title="新建子内容"><Plus size={13} /></button>
          )}
          <button type="button" onClick={() => setMenuNodeId(menuOpen ? null : node.id)} className="hidden h-6 w-6 items-center justify-center rounded text-tx-tertiary hover:bg-app-active group-hover:flex" title="更多"><MoreHorizontal size={14} /></button>

          {menuOpen && (
            <div className="absolute right-1 top-7 z-[210] w-52 rounded-lg border border-app-border bg-app-elevated py-1 shadow-xl">
              {node.resourceType === "note" && (
                <>
                  <button type="button" onClick={() => openSplit(node, "right")} className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-tx-secondary hover:bg-app-hover"><SplitSquareHorizontal size={13} />在右侧分屏打开</button>
                  <button type="button" onClick={() => openSplit(node, "down")} className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-tx-secondary hover:bg-app-hover"><SplitSquareVertical size={13} />在下方分屏打开</button>
                  <div className="my-1 border-t border-app-border" />
                </>
              )}
              {node.access.capabilities.canEdit && <button type="button" onClick={() => void rename(node)} className="flex w-full px-3 py-1.5 text-xs text-tx-secondary hover:bg-app-hover">重命名</button>}
              {node.access.capabilities.canMove && <button type="button" onClick={() => { setMenuNodeId(null); setMovingNode(node); }} className="flex w-full px-3 py-1.5 text-xs text-tx-secondary hover:bg-app-hover">移动</button>}
              {node.access.capabilities.canManageMembers && <button type="button" onClick={() => { setMenuNodeId(null); setPermissionsNode(node); }} className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-tx-secondary hover:bg-app-hover"><ShieldCheck size={13} />成员与权限</button>}
              {node.access.capabilities.canDelete && (
                <>
                  <div className="my-1 border-t border-app-border" />
                  <button type="button" onClick={() => void remove(node)} className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-red-500 hover:bg-red-500/10"><Trash2 size={13} />删除</button>
                </>
              )}
            </div>
          )}
        </div>
        {isExpanded && childNodes.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  const drawer = open ? (
    <div className="fixed inset-0 z-[190]" role="dialog" aria-modal="true" aria-label="统一内容树">
      <div className="absolute inset-0 bg-black/35 backdrop-blur-[1px]" onClick={() => setOpen(false)} />
      <aside className="absolute inset-y-0 left-0 flex w-[min(420px,92vw)] flex-col border-r border-app-border bg-app-elevated shadow-2xl">
        <header className="flex min-h-12 items-center gap-2 border-b border-app-border px-3" style={{ paddingTop: "var(--safe-area-top)" }}>
          <TreePine size={17} className="text-accent-primary" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-tx-primary">统一内容树</div>
            <div className="text-[10px] text-tx-tertiary">文件夹和文档均可包含子内容</div>
          </div>
          <button type="button" onClick={() => void createChild(null)} className="rounded-md p-1.5 text-tx-tertiary hover:bg-app-hover" title="新建根文件夹"><Plus size={16} /></button>
          <button type="button" onClick={() => void reload()} disabled={loading} className="rounded-md p-1.5 text-tx-tertiary hover:bg-app-hover" title="刷新"><RefreshCw size={15} className={loading ? "animate-spin" : undefined} /></button>
          <button type="button" onClick={() => setOpen(false)} className="rounded-md p-1.5 text-tx-tertiary hover:bg-app-hover"><X size={17} /></button>
        </header>

        <div className="border-b border-app-border p-2">
          <div className="flex items-center gap-2 rounded-md border border-app-border bg-app-bg px-2.5 py-1.5">
            <Search size={14} className="text-tx-tertiary" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选树节点…" className="min-w-0 flex-1 bg-transparent text-sm text-tx-primary outline-none placeholder:text-tx-tertiary" />
            <kbd className="rounded border border-app-border px-1 text-[9px] text-tx-tertiary">Ctrl/⌘⇧K</kbd>
          </div>
        </div>

        <div className="relative min-h-0 flex-1 overflow-y-auto p-2">
          {loading && nodes.length === 0 ? (
            <div className="flex justify-center py-16"><Loader2 size={20} className="animate-spin text-tx-tertiary" /></div>
          ) : filteredNodes.length === 0 ? (
            <div className="flex flex-col items-center py-16 text-center">
              <TreePine size={30} className="mb-3 text-tx-tertiary/40" />
              <p className="text-sm text-tx-secondary">暂无内容</p>
              <p className="mt-1 max-w-[260px] text-xs text-tx-tertiary">先创建根文件夹，再在任意文件夹或文档下创建子文件夹和子文档。</p>
            </div>
          ) : (children.get(null) || []).map((node) => renderNode(node, 0))}
          {permissionsNode && <PermissionsPanel node={permissionsNode} onClose={() => setPermissionsNode(null)} />}
          {movingNode && <MovePanel node={movingNode} nodes={nodes} children={allChildren} onMoved={() => void reload()} onClose={() => setMovingNode(null)} />}
        </div>
      </aside>
    </div>
  ) : null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "fixed bottom-4 left-16 z-[80] hidden h-9 items-center gap-2 rounded-full border border-app-border",
          "bg-app-elevated px-3 text-xs text-tx-secondary shadow-lg transition-colors hover:bg-app-hover hover:text-tx-primary md:flex",
        )}
        title="统一内容树（Ctrl/Cmd + Shift + K）"
      >
        <TreePine size={15} className="text-accent-primary" /><span>内容树</span>
      </button>
      {typeof document !== "undefined" && drawer ? createPortal(drawer, document.body) : null}
    </>
  );
}
