from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    if text.count(old) != 1:
        raise SystemExit(f"{label} anchor changed: {text.count(old)} matches")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


# Personal notebooks shared through the legacy membership tables must remain visible to the
# unified capability resolver. Workspace fallback still runs only after member/note ACL checks.
replace_once(
    "backend/src/services/knowledgeCapabilitiesResolver.ts",
    '''function legacyAccess(db: Database.Database, node: TreeNodeRow, userId: string) {
  if (!node.workspaceId) return legacyPermission(null);

  if (node.resourceType === "notebook") {
    const member = memberQueryService.getNotebookMemberAccess(node.resourceId, userId);
    if (member) return legacyPermission(member.role);
  } else if (node.resourceType === "note") {
    const member = memberQueryService.getNoteNotebookMemberAccess(node.resourceId, userId);
    if (member) return legacyPermission(member.role);
    const noteAcl = db.prepare("SELECT permission FROM note_acl WHERE noteId = ? AND userId = ?")
      .get(node.resourceId, userId) as { permission: string } | undefined;
    if (noteAcl) return legacyPermission(noteAcl.permission);
  }

  const workspaceRole = db.prepare("SELECT role FROM workspace_members WHERE workspaceId = ? AND userId = ?")
''',
    '''function legacyAccess(db: Database.Database, node: TreeNodeRow, userId: string) {
  if (node.resourceType === "notebook") {
    const member = memberQueryService.getNotebookMemberAccess(node.resourceId, userId);
    if (member) return legacyPermission(member.role);
  } else if (node.resourceType === "note") {
    const member = memberQueryService.getNoteNotebookMemberAccess(node.resourceId, userId);
    if (member) return legacyPermission(member.role);
    const noteAcl = db.prepare("SELECT permission FROM note_acl WHERE noteId = ? AND userId = ?")
      .get(node.resourceId, userId) as { permission: string } | undefined;
    if (noteAcl) return legacyPermission(noteAcl.permission);
  }

  if (!node.workspaceId) return legacyPermission(null);
  const workspaceRole = db.prepare("SELECT role FROM workspace_members WHERE workspaceId = ? AND userId = ?")
''',
    "knowledge capability resolver",
)

replace_once(
    "backend/src/services/knowledgeCapabilitiesCore.ts",
    '''function legacyAccess(db: Database.Database, node: TreeNodeRow, userId: string): Pick<EffectiveKnowledgeAccess, "rolePreset" | "capabilities"> {
  if (!node.workspaceId) return permissionToAccess(null);

  if (node.resourceType === "notebook") {
    const member = memberQueryService.getNotebookMemberAccess(node.resourceId, userId);
    if (member) return permissionToAccess(member.role);
  } else if (node.resourceType === "note") {
    const member = memberQueryService.getNoteNotebookMemberAccess(node.resourceId, userId);
    if (member) return permissionToAccess(member.role);
    const noteAcl = db.prepare("SELECT permission FROM note_acl WHERE noteId = ? AND userId = ?")
      .get(node.resourceId, userId) as { permission: string } | undefined;
    if (noteAcl) return permissionToAccess(noteAcl.permission);
  }

  const workspaceRole = db.prepare("SELECT role FROM workspace_members WHERE workspaceId = ? AND userId = ?")
''',
    '''function legacyAccess(db: Database.Database, node: TreeNodeRow, userId: string): Pick<EffectiveKnowledgeAccess, "rolePreset" | "capabilities"> {
  if (node.resourceType === "notebook") {
    const member = memberQueryService.getNotebookMemberAccess(node.resourceId, userId);
    if (member) return permissionToAccess(member.role);
  } else if (node.resourceType === "note") {
    const member = memberQueryService.getNoteNotebookMemberAccess(node.resourceId, userId);
    if (member) return permissionToAccess(member.role);
    const noteAcl = db.prepare("SELECT permission FROM note_acl WHERE noteId = ? AND userId = ?")
      .get(node.resourceId, userId) as { permission: string } | undefined;
    if (noteAcl) return permissionToAccess(noteAcl.permission);
  }

  if (!node.workspaceId) return permissionToAccess(null);
  const workspaceRole = db.prepare("SELECT role FROM workspace_members WHERE workspaceId = ? AND userId = ?")
''',
    "knowledge capability core",
)

# A shared parent is authoritative for scope. Personal shared children belong to the owner's
# personal scope, while workspace content still records the acting member as creator.
replace_once(
    "backend/src/services/knowledgeTreeCore.ts",
    '''  const parent = input.parentId ? requireNode(db, input.parentId) : null;
  const normalizedWorkspaceId = input.workspaceId || null;
  const expectedScope = scopeKey(input.actorUserId, normalizedWorkspaceId);
  if (parent && parent.scopeKey !== expectedScope) {
    throw new KnowledgeTreeError("KNOWLEDGE_TREE_SCOPE_MISMATCH", 400, "父节点不在当前空间");
  }
  const targetAccess = resolveTargetAccess(db, input.parentId, input.actorUserId, normalizedWorkspaceId);
''',
    '''  const parent = input.parentId ? requireNode(db, input.parentId) : null;
  const requestedWorkspaceId = input.workspaceId || null;
  const normalizedWorkspaceId = parent ? parent.workspaceId : requestedWorkspaceId;
  const resourceOwnerUserId = parent && !parent.workspaceId ? parent.userId : input.actorUserId;
  const expectedScope = parent?.scopeKey || scopeKey(resourceOwnerUserId, normalizedWorkspaceId);
  const targetAccess = resolveTargetAccess(db, input.parentId, input.actorUserId, normalizedWorkspaceId);
''',
    "shared child scope",
)
replace_once(
    "backend/src/services/knowledgeTreeCore.ts",
    '''  const key = parent?.scopeKey || expectedScope;
''',
    '''  const key = expectedScope;
''',
    "shared child sort scope",
)
replace_once(
    "backend/src/services/knowledgeTreeCore.ts",
    '''      `).run(notebookId, input.actorUserId, normalizedWorkspaceId, physicalParentId, title, sortOrder);
''',
    '''      `).run(notebookId, resourceOwnerUserId, normalizedWorkspaceId, physicalParentId, title, sortOrder);
''',
    "shared folder owner",
)
replace_once(
    "backend/src/services/knowledgeTreeCore.ts",
    '''        noteId, input.actorUserId, normalizedWorkspaceId, notebookId, title,
''',
    '''        noteId, resourceOwnerUserId, normalizedWorkspaceId, notebookId, title,
''',
    "shared note owner",
)
replace_once(
    "backend/src/services/knowledgeTreeCore.ts",
    '''  const parent = input.parentId ? requireNode(db, input.parentId) : null;
  if (parent && parent.scopeKey !== node.scopeKey) {
''',
    '''  const parent = input.parentId ? requireNode(db, input.parentId) : null;
  if (!parent && !node.workspaceId && node.userId !== input.actorUserId) {
    throw new KnowledgeTreeError(
      "KNOWLEDGE_SHARED_ROOT_MOVE_FORBIDDEN",
      403,
      "共享根节点不能移出所有者目录",
    );
  }
  if (parent && parent.scopeKey !== node.scopeKey) {
''',
    "shared root move guard",
)

# Route and service barrel.
replace_once(
    "backend/src/routes/knowledge-tree.ts",
    '''  listKnowledgeTree,
  listKnowledgeTreeHistory,
''',
    '''  listKnowledgeTree,
  listSharedKnowledgeTree,
  listKnowledgeTreeHistory,
''',
    "shared route import",
)
replace_once(
    "backend/src/routes/knowledge-tree.ts",
    '''app.post("/nodes", async (c) => {
''',
    '''app.get("/shared-with-me", (c) => {
  try {
    return c.json({
      nodes: listSharedKnowledgeTree({
        userId: userIdOf(c),
        workspaceId: workspaceIdOf(c),
      }),
    });
  } catch (error) {
    return mapError(c, error);
  }
});

app.post("/nodes", async (c) => {
''',
    "shared route endpoint",
)

# Frontend API contract.
replace_once(
    "frontend/src/lib/knowledgeTreeApi.ts",
    '''  access: EffectiveKnowledgeAccess;
}
''',
    '''  access: EffectiveKnowledgeAccess;
  sharedRootId?: string;
  sharedDepth?: number;
}
''',
    "shared node fields",
)
replace_once(
    "frontend/src/lib/knowledgeTreeApi.ts",
    '''  list(includeDeleted = false) {
    return request<{ nodes: KnowledgeTreeNode[] }>(`/?${workspaceQuery(includeDeleted)}`);
  },

  create(input: { parentId: string | null; nodeType: "folder" | "note" | "markdown" | "word"; title: string }) {
''',
    '''  list(includeDeleted = false) {
    return request<{ nodes: KnowledgeTreeNode[] }>(`/?${workspaceQuery(includeDeleted)}`);
  },

  listShared() {
    return request<{ nodes: KnowledgeTreeNode[] }>(`/shared-with-me?${workspaceQuery()}`);
  },

  create(input: { parentId: string | null; nodeType: "folder" | "note" | "markdown" | "word"; title: string }) {
''',
    "shared frontend API",
)

# One panel renders owned and shared sections. Shared failures never hide the owned tree.
replace_once(
    "frontend/src/components/KnowledgeTreePanel.tsx",
    '''import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
''',
    '''import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  canMoveWithinSharedRoot,
  filterKnowledgeTreeNodes,
  isSharedRoot,
} from "@/lib/sharedKnowledgeTree";
''',
    "shared panel imports",
)
replace_once(
    "frontend/src/components/KnowledgeTreePanel.tsx",
    '''  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
''',
    '''  const [error, setError] = useState<string | null>(null);
  const [sharedLoadError, setSharedLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
''',
    "shared panel state",
)
replace_once(
    "frontend/src/components/KnowledgeTreePanel.tsx",
    '''    try {
      const response = await knowledgeTreeApi.list();
      const ids = new Set(response.nodes.map((node) => node.id));
      setNodes(response.nodes);
      setExpanded((current) => {
        if (current.size === 0) {
          return new Set(response.nodes.filter((node) => node.parentId === null || node.isExpanded).map((node) => node.id));
        }
        return new Set(Array.from(current).filter((id) => ids.has(id)));
      });
    } catch (requestError: any) {
''',
    '''    try {
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
''',
    "shared panel loading",
)
replace_once(
    "frontend/src/components/KnowledgeTreePanel.tsx",
    '''  const filteredNodes = useMemo(() => {
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
''',
    '''  const filteredNodes = useMemo(() => filterKnowledgeTreeNodes(nodes, query), [nodes, query]);
''',
    "shared panel filtering",
)
replace_once(
    "frontend/src/components/KnowledgeTreePanel.tsx",
    '''    try { await knowledgeTreeApi.update(node.id, { isExpanded: opening }); } catch { /* local navigation remains usable */ }
''',
    '''    if (!node.sharedRootId) {
      try { await knowledgeTreeApi.update(node.id, { isExpanded: opening }); } catch { /* local navigation remains usable */ }
    }
''',
    "shared expansion persistence",
)
replace_once(
    "frontend/src/components/KnowledgeTreePanel.tsx",
    '''  const dropMove = async (sourceId: string, targetId: string) => {
    if (!sourceId || sourceId === targetId) return;
    const blockedTargets = descendantsOf(sourceId, allChildren);
''',
    '''  const dropMove = async (sourceId: string, targetId: string) => {
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
''',
    "shared drag boundary",
)
replace_once(
    "frontend/src/components/KnowledgeTreePanel.tsx",
    '''  const candidates = nodes.filter((candidate) => !blocked.has(candidate.id) && candidate.access.capabilities.canCreate);

  const move = async (parentId: string | null) => {
''',
    '''  const candidates = nodes.filter((candidate) =>
    !blocked.has(candidate.id)
    && candidate.access.capabilities.canCreate
    && (node.sharedRootId
      ? candidate.sharedRootId === node.sharedRootId
      : !candidate.sharedRootId),
  );
  const allowRoot = !node.sharedRootId;

  const move = async (parentId: string | null) => {
''',
    "shared move candidates",
)
replace_once(
    "frontend/src/components/KnowledgeTreePanel.tsx",
    '''        <button
          type="button"
          disabled={node.parentId === null}
          onClick={() => void move(null)}
          className="mb-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-tx-secondary hover:bg-app-hover hover:text-tx-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          <TreePine size={14} className="text-accent-primary" /><span className="truncate">根目录</span>
        </button>
''',
    '''        {allowRoot && (
          <button
            type="button"
            disabled={node.parentId === null}
            onClick={() => void move(null)}
            className="mb-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-tx-secondary hover:bg-app-hover hover:text-tx-primary disabled:cursor-not-allowed disabled:opacity-40"
          >
            <TreePine size={14} className="text-accent-primary" /><span className="truncate">根目录</span>
          </button>
        )}
''',
    "shared root move target",
)
replace_once(
    "frontend/src/components/KnowledgeTreePanel.tsx",
    '''           draggable={node.access.capabilities.canMove}
''',
    '''           draggable={node.access.capabilities.canMove && !isSharedRoot(node)}
''',
    "shared root draggable",
)
replace_once(
    "frontend/src/components/KnowledgeTreePanel.tsx",
    '''             {node.access.source === "inherited" && <span className="rounded bg-app-active px-1 text-[9px] text-tx-tertiary">继承</span>}
''',
    '''             {isSharedRoot(node) && <span className="rounded bg-accent-primary/10 px-1 text-[9px] text-accent-primary">共享</span>}
             {node.access.source === "inherited" && <span className="rounded bg-app-active px-1 text-[9px] text-tx-tertiary">继承</span>}
''',
    "shared root badge",
)
replace_once(
    "frontend/src/components/KnowledgeTreePanel.tsx",
    '''              {node.access.capabilities.canMove && <button type="button" onClick={() => { setMenuNodeId(null); setMovingNode(node); }} className="flex w-full px-3 py-1.5 text-xs text-tx-secondary hover:bg-app-hover">移动</button>}
''',
    '''              {node.access.capabilities.canMove && !isSharedRoot(node) && <button type="button" onClick={() => { setMenuNodeId(null); setMovingNode(node); }} className="flex w-full px-3 py-1.5 text-xs text-tx-secondary hover:bg-app-hover">移动</button>}
''',
    "shared root move menu",
)
replace_once(
    "frontend/src/components/KnowledgeTreePanel.tsx",
    '''  return (
    <section ref={menuRootRef} className={cn("relative flex min-h-0 flex-1 flex-col", className)} data-nowen-knowledge-tree="embedded" data-sidebar-surface-active={surfaceActive ? "true" : "false"}>
''',
    '''  const rootNodes = children.get(null) || [];
  const ownedRoots = rootNodes.filter((node) => !node.sharedRootId);
  const sharedRoots = rootNodes.filter((node) => Boolean(node.sharedRootId));

  return (
    <section ref={menuRootRef} className={cn("relative flex min-h-0 flex-1 flex-col", className)} data-nowen-knowledge-tree="embedded" data-sidebar-surface-active={surfaceActive ? "true" : "false"}>
''',
    "shared section roots",
)
replace_once(
    "frontend/src/components/KnowledgeTreePanel.tsx",
    ''') : filteredNodes.length === 0 ? (
''',
    ''') : filteredNodes.length === 0 && !sharedLoadError ? (
''',
    "shared error empty boundary",
)
replace_once(
    "frontend/src/components/KnowledgeTreePanel.tsx",
    ''') : (children.get(null) || []).map((node) => renderNode(node, 0))}
''',
    ''') : (
          <>
            {ownedRoots.length > 0 && (
              <div data-knowledge-tree-section="owned">
                <div className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-tx-tertiary">当前空间</div>
                {ownedRoots.map((node) => renderNode(node, 0))}
              </div>
            )}
            {sharedRoots.length > 0 && (
              <div className={cn("mt-2 border-t border-app-border pt-2", ownedRoots.length === 0 && "mt-0 border-t-0 pt-0")} data-knowledge-tree-section="shared">
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
''',
    "shared section rendering",
)

print("issue 462 shared knowledge tree integration patched")
