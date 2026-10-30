import type { NativeDatabase } from "./nativeDatabase";

// Matches the existing server's complete negotiated set. Partial subscriptions
// are rejected by Sync V2; workspace clients retain their legacy subscription.
export const NATIVE_TREE_ENTITY_SET = "notebook,note,tag,note_tag,favorite,attachment,task,task_reminder,diary,mindmap,knowledge_tree_node";
export const NATIVE_TREE_PENDING_SUBSCRIPTION = `pending:${NATIVE_TREE_ENTITY_SET}`;

export function nativeTreeSubscriptionKey(profileId: string): string {
  return `nativeTreeSubscription:${profileId}:personal`;
}

export interface NativeTreeEntry {
  entityId: string;
  payload: Record<string, unknown>;
}

function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: "INVALID_TREE_STRUCTURE" });
}

const nodeTypes: Record<string, readonly string[]> = {
  notebook: ["folder"], note: ["note", "markdown", "word"], mindmap: ["mindmap"], file: ["file"],
};

export function assertNativePersonalTreeEntry(entityId: string, p: Record<string,unknown>, userId: string): void {
  // Root-document placement can allocate negative sort positions. Keep signed safe integers.
  const type = p.resourceType;
  if (p.__delete === true) return;
  if (typeof type !== "string" || !Object.hasOwn(nodeTypes,type)
    || typeof p.resourceId !== "string" || !p.resourceId
    || entityId !== `${type}:${p.resourceId}` || p.id !== entityId
    || p.userId !== userId || p.workspaceId !== null
    || (p.scopeKey !== undefined && p.scopeKey !== `personal:${userId}`)
    || typeof p.nodeType !== "string" || !nodeTypes[type].includes(p.nodeType)
    || (p.parentId !== null && (typeof p.parentId !== "string" || !p.parentId))
    || p.parentId === entityId
    || !Number.isSafeInteger(p.sortOrder)
    || (p.isDeleted !== 0 && p.isDeleted !== 1)
    || (p.deletedAt !== null && typeof p.deletedAt !== "string")
    || typeof p.createdAt !== "string" || !p.createdAt
    || typeof p.updatedAt !== "string" || !p.updatedAt
    || entityId.startsWith("notebook:__nowen_root_documents__:")) {
    invalid("知识树资源身份、作用域或结构字段无效");
  }
}

/** Caller owns the Apply transaction. Never writes business rows, Outbox or access proofs. */
export async function applyNativePersonalTree(
  tx: NativeDatabase, entries: NativeTreeEntry[], userId: string, snapshot: boolean,
): Promise<void> {
  const seen = new Set<string>();
  if (snapshot) await tx.run("DELETE FROM native_knowledge_tree_nodes WHERE scopeKey='personal'");
  for (const { entityId, payload: p } of entries) {
    if (seen.has(entityId)) invalid("知识树批次包含重复节点");
    seen.add(entityId);
    if (p.__delete) {
      if (snapshot || p.__delete !== true) invalid("知识树 Snapshot 不接受删除标记");
      await tx.run("DELETE FROM native_knowledge_tree_nodes WHERE scopeKey='personal' AND id=?", [entityId]);
      continue;
    }
    assertNativePersonalTreeEntry(entityId,p,userId);
    const type = p.resourceType as string;
    const tables: Record<string,string> = { notebook: "notebooks", note: "notes", mindmap: "mindmaps", file: "attachments" };
    const table = tables[type];
    const resource = await tx.query(`SELECT id FROM ${table} WHERE scopeKey='personal' AND id=?`, [p.resourceId]);
    if (!resource.length) invalid("知识树业务资源尚未同步");
    await tx.run(`INSERT INTO native_knowledge_tree_nodes
      (scopeKey,workspaceId,id,userId,parentId,nodeType,resourceType,resourceId,sortOrder,isDeleted,deletedAt,createdAt,updatedAt)
      VALUES ('personal',NULL,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scopeKey,id) DO UPDATE SET
      parentId=excluded.parentId,nodeType=excluded.nodeType,sortOrder=excluded.sortOrder,
      isDeleted=excluded.isDeleted,deletedAt=excluded.deletedAt,updatedAt=excluded.updatedAt`,
    [entityId,userId,p.parentId,p.nodeType,type,p.resourceId,p.sortOrder,p.isDeleted,p.deletedAt,p.createdAt,p.updatedAt]);
  }
  // Validate the final graph rather than each intermediate move. A valid batch
  // may reverse old ancestry; temporary intermediate cycles must not reject it.
  const rows = await tx.query<{id:string;parentId:string|null;isDeleted:number}>(
    "SELECT id,parentId,isDeleted FROM native_knowledge_tree_nodes WHERE scopeKey='personal'",
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const done = new Set<string>();
  for (const row of rows) {
    const path = new Set<string>();
    let current: typeof row | undefined = row;
    while (current && !done.has(current.id)) {
      if (path.has(current.id)) invalid("知识树不能形成循环");
      path.add(current.id);
      if (!current.parentId) break;
      const parent = byId.get(current.parentId);
      if (!parent || (parent.isDeleted && !current.isDeleted)) invalid("知识树父节点缺失或已删除");
      current = parent;
    }
    for (const id of path) done.add(id);
  }
}
