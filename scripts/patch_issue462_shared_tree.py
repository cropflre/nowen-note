from pathlib import Path

path = Path("backend/src/services/knowledgeTreeCore.ts")
text = path.read_text(encoding="utf-8")

import_anchor = '''} from "./knowledgeCapabilities.js";

export type KnowledgeNodeType'''
if text.count(import_anchor) != 1:
    raise SystemExit("shared boundary import anchor changed")
text = text.replace(
    import_anchor,
    '''} from "./knowledgeCapabilities.js";
import { resolveSharedKnowledgeRoot } from "./sharedKnowledgeTreeBoundary.js";

export type KnowledgeNodeType''',
    1,
)

move_anchor = '''  const node = requireNode(db, input.nodeId);
  requireCapability(db, node.id, input.actorUserId, "canMove");

  const parent = input.parentId ? requireNode(db, input.parentId) : null;
  if (!parent && !node.workspaceId && node.userId !== input.actorUserId) {
    throw new KnowledgeTreeError(
      "KNOWLEDGE_SHARED_ROOT_MOVE_FORBIDDEN",
      403,
      "共享根节点不能移出所有者目录",
    );
  }
  if (parent && parent.scopeKey !== node.scopeKey) {
'''
if text.count(move_anchor) != 1:
    raise SystemExit("shared move boundary anchor changed")
text = text.replace(
    move_anchor,
    '''  const node = requireNode(db, input.nodeId);
  requireCapability(db, node.id, input.actorUserId, "canMove");
  const sharedRootId = resolveSharedKnowledgeRoot(node.id, input.actorUserId, db);

  const parent = input.parentId ? requireNode(db, input.parentId) : null;
  if (sharedRootId) {
    if (node.id == sharedRootId) {
      throw new KnowledgeTreeError(
        "KNOWLEDGE_SHARED_ROOT_MOVE_FORBIDDEN",
        403,
        "共享根节点不能由接收者移动",
      );
    }
    const targetSharedRootId = parent
      ? resolveSharedKnowledgeRoot(parent.id, input.actorUserId, db)
      : null;
    if (!parent || targetSharedRootId !== sharedRootId) {
      throw new KnowledgeTreeError(
        "KNOWLEDGE_SHARED_ROOT_SCOPE_MISMATCH",
        403,
        "共享内容只能在同一个共享根内移动",
        { sharedRootId, targetSharedRootId },
      );
    }
  }
  if (parent && parent.scopeKey !== node.scopeKey) {
''',
    1,
)

path.write_text(text, encoding="utf-8")
print("patched server-side shared-root move boundary")
