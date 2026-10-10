import { getDb } from "../../db/schema.js";
import { canManageResource } from "../../middleware/acl.js";
import { resolveResourceKnowledgeAccessForTombstone } from "../knowledgeCapabilities.js";
import { KnowledgeTreeError } from "../knowledgeTree.js";

export function permanentlyDeleteMindmap(id: string, userId: string): void {
  const db = getDb();
  const row = db.prepare("SELECT * FROM mindmaps WHERE id = ?").get(id) as { userId: string; workspaceId: string | null } | undefined;
  if (!row) throw new KnowledgeTreeError("MINDMAP_NOT_FOUND", 404, "思维导图不存在");
  if (!canManageResource(row.userId, row.workspaceId, userId)) {
    throw new KnowledgeTreeError("FORBIDDEN", 403, "无权删除此导图");
  }
  const node = db.prepare(`
    SELECT isDeleted FROM knowledge_tree_nodes WHERE resourceType = 'mindmap' AND resourceId = ?
  `).get(id) as { isDeleted: number } | undefined;
  if (!node?.isDeleted) throw new KnowledgeTreeError("MINDMAP_NOT_TRASHED", 409, "请先将脑图移入回收站");
  if (!resolveResourceKnowledgeAccessForTombstone("mindmap", id, userId, db).capabilities.canDelete) {
    throw new KnowledgeTreeError("FORBIDDEN", 403, "无权删除此导图");
  }
  db.prepare("DELETE FROM mindmaps WHERE id = ?").run(id);
}
