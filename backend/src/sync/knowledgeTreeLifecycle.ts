import type Database from "better-sqlite3";
import { deleteKnowledgeNode, restoreKnowledgeNode } from "../services/knowledgeTree.js";
import { hasKnowledgeCapability, resolveKnowledgeNodeAccess } from "../services/knowledgeCapabilities.js";
import { SyncError } from "./errors.js";

export function readKnowledgeTreeLifecycleSubtree(db: Database.Database, id: string): Record<string,unknown>[] {
  return db.prepare(`WITH RECURSIVE subtree(id) AS (
    SELECT id FROM knowledge_tree_nodes WHERE id=?
    UNION SELECT t.id FROM knowledge_tree_nodes t JOIN subtree s ON t.parentId=s.id
  ) SELECT t.id,t.userId,t.workspaceId,t.parentId,t.nodeType,t.resourceType,t.resourceId,
    t.sortOrder,t.isDeleted,t.deletedAt,t.createdAt,t.updatedAt
    FROM knowledge_tree_nodes t JOIN subtree s ON t.id=s.id ORDER BY t.id`).all(id) as Record<string,unknown>[];
}

/** One existing Sync V2 mutation owns the complete folder lifecycle transaction. */
export function applyKnowledgeTreeLifecycle(db: Database.Database, userId: string, workspaceId: string | null,
  id: string, payload: Record<string,unknown>): void {
  if (workspaceId || !id.startsWith("notebook:") || !["trash","restore"].includes(String(payload.lifecycle))
    || !Array.isArray(payload.baseSubtree) || !Array.isArray(payload.affectedNodeIds) || !Array.isArray(payload.lifecycleNodes)
    || typeof payload.lifecycleMutationId !== "string" || !payload.lifecycleMutationId) {
    throw new SyncError("INVALID_PAYLOAD","个人文件夹回收站操作无效");
  }
  const nodes = readKnowledgeTreeLifecycleSubtree(db,id), root = nodes.find((node)=>node.id===id);
  if (!root || root.userId!==userId || root.workspaceId!==null) throw new SyncError("SCOPE_FORBIDDEN","文件夹不在当前个人空间");
  const expected = payload.baseSubtree as Record<string,unknown>[];
  if (new Set(expected.map((node)=>node?.id)).size!==expected.length
    || expected.length!==nodes.length || nodes.some((node)=>!expected.some((base)=>base?.id===node.id
      && base.parentId===node.parentId && base.sortOrder===node.sortOrder && base.isDeleted===node.isDeleted))) {
    throw new SyncError("VERSION_CONFLICT","文件夹子树已在其他设备变更");
  }
  const restoring = payload.lifecycle==="restore";
  const desiredRoot=(payload.lifecycleNodes as Record<string,unknown>[]).find((node)=>node?.id===id);
  if (root.isDeleted!==(restoring?1:0) || payload.isDeleted!==(restoring?0:1)
    || payload.parentId!==root.parentId || desiredRoot?.sortOrder!==root.sortOrder) {
    throw new SyncError("VERSION_CONFLICT","文件夹位置或回收站状态已变更");
  }
  const affected = new Set(payload.affectedNodeIds as unknown[]);
  if (affected.size!==payload.affectedNodeIds.length || !affected.has(id)
    || [...affected].some((nodeId)=>typeof nodeId!=="string" || !nodes.some((node)=>node.id===nodeId))) {
    throw new SyncError("INVALID_PAYLOAD","文件夹删除批次无效");
  }
  const projected=payload.lifecycleNodes as Record<string,unknown>[];
  if(projected.length!==affected.size || new Set(projected.map((node)=>node?.id)).size!==affected.size
    || projected.some((node)=>!affected.has(node?.id) || !nodes.some((base)=>base.id===node.id
      && base.resourceType===node.resourceType && base.resourceId===node.resourceId
      && base.parentId===node.parentId && base.sortOrder===node.sortOrder && node.isDeleted===(restoring?0:1)))) {
    throw new SyncError("INVALID_PAYLOAD","回收站结构投影与删除批次不匹配");
  }
  for (const node of nodes.filter((node)=>affected.has(node.id))) {
    if (node.userId!==userId || node.workspaceId!==null || !["notebook","note"].includes(String(node.resourceType))) {
      throw new SyncError("SCOPE_FORBIDDEN","子树包含不支持的个人资源");
    }
    const access=resolveKnowledgeNodeAccess(String(node.id),userId,db,{includeDeleted:true});
    if (!hasKnowledgeCapability(access,"canDelete")) throw new SyncError("SCOPE_FORBIDDEN","没有删除或恢复子节点的权限");
    const protectedAncestor=db.prepare(`WITH RECURSIVE ancestry(id,parentId,resourceType,resourceId) AS (
      SELECT id,parentId,resourceType,resourceId FROM knowledge_tree_nodes WHERE id=?
      UNION SELECT t.id,t.parentId,t.resourceType,t.resourceId FROM knowledge_tree_nodes t JOIN ancestry a ON t.id=a.parentId
    ) SELECT 1 FROM ancestry a JOIN notebook_passwords p ON a.resourceType='notebook' AND p.notebookId=a.resourceId LIMIT 1`).get(node.id);
    if(protectedAncestor) throw new SyncError("SCOPE_FORBIDDEN","受密码保护的目录需要使用在线回收站操作");
    if(node.resourceType==="note") {
      const note=db.prepare("SELECT contentFormat,isLocked FROM notes WHERE id=?").get(node.resourceId) as {contentFormat:string;isLocked:number}|undefined;
      if(!note || note.isLocked || !["markdown","tiptap-json","plaintext"].includes(note.contentFormat)) throw new SyncError("SCOPE_FORBIDDEN","当前文档需要使用在线回收站操作");
    }
  }
  if (restoring) {
    const history=db.prepare("SELECT metadata FROM knowledge_tree_history WHERE nodeId=? AND action='delete_subtree' ORDER BY rowid DESC LIMIT 1").get(id) as {metadata:string}|undefined;
    if (!history || JSON.parse(history.metadata||"{}").nativeLifecycleMutationId!==payload.restoreOf) {
      throw new SyncError("VERSION_CONFLICT","文件夹的删除批次已变更，请重新确认回收站内容");
    }
  }
  db.transaction(()=>{
    const changed=restoring
      ? restoreKnowledgeNode({db,actorUserId:userId,nodeId:id}).restoredNodeIds
      : deleteKnowledgeNode({db,actorUserId:userId,nodeId:id,mode:"subtree"}).affectedNodeIds;
    if (changed.length!==affected.size || changed.some((nodeId)=>!affected.has(nodeId))) {
      throw new SyncError("VERSION_CONFLICT","文件夹本次删除或恢复的子节点已变更");
    }
    if (!restoring) {
      const history=db.prepare("SELECT rowid,metadata FROM knowledge_tree_history WHERE nodeId=? AND action='delete_subtree' ORDER BY rowid DESC LIMIT 1").get(id) as {rowid:number;metadata:string};
      db.prepare("UPDATE knowledge_tree_history SET metadata=? WHERE rowid=?").run(
        JSON.stringify({...JSON.parse(history.metadata),nativeLifecycleMutationId:payload.lifecycleMutationId}),history.rowid);
    }
  })();
}
