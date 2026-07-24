import { Hono } from "hono";

import { getDb } from "../db/schema.js";
import {
  clearKnowledgeNodeRole,
  hasKnowledgeCapability,
  listKnowledgeNodeRoles,
  parseKnowledgeRolePreset,
  resolveKnowledgeNodeAccess,
  resolveKnowledgePermissionSubject,
  setKnowledgeNodeRole,
} from "../services/knowledgeCapabilities.js";
import {
  createKnowledgeChild,
  deleteKnowledgeNode,
  KnowledgeTreeError,
  listKnowledgeTree,
  listKnowledgeTreeHistory,
  moveKnowledgeNode,
  reorderKnowledgeNodes,
  restoreKnowledgeNode,
} from "../services/knowledgeTree.js";

const app = new Hono();

function userIdOf(c: any): string {
  return c.req.header("X-User-Id") || "";
}

function workspaceIdOf(c: any): string | null {
  const value = c.req.query("workspaceId");
  return !value || value === "personal" ? null : value;
}

function mapError(c: any, error: unknown): Response {
  if (error instanceof KnowledgeTreeError) {
    return c.json({ error: error.message, code: error.code, ...error.details }, error.status);
  }
  if (error instanceof Error && /KNOWLEDGE_TREE_/.test(error.message)) {
    return c.json({ error: "目录结构不合法", code: error.message }, 409);
  }
  console.error("[knowledge-tree] request failed:", error);
  return c.json({ error: "知识树操作失败", code: "KNOWLEDGE_TREE_FAILED" }, 500);
}

app.get("/roles", (c) => c.json({
  roles: [
    { id: "readonly", label: "只读成员", capabilities: ["canView", "canDownload"] },
    { id: "editor", label: "编辑成员", capabilities: ["canView", "canComment", "canCreate", "canEdit", "canDownload"] },
    { id: "maintainer", label: "维护成员", capabilities: ["canView", "canComment", "canCreate", "canEdit", "canDelete", "canMove", "canDownload"] },
    { id: "admin", label: "管理员", capabilities: ["canView", "canComment", "canCreate", "canEdit", "canDelete", "canMove", "canDownload", "canReshare", "canManageMembers"] },
  ],
}));

app.get("/", (c) => {
  try {
    return c.json({
      nodes: listKnowledgeTree({
        userId: userIdOf(c),
        workspaceId: workspaceIdOf(c),
        includeDeleted: c.req.query("includeDeleted") === "1",
      }),
    });
  } catch (error) {
    return mapError(c, error);
  }
});

app.post("/nodes", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const nodeType = body.nodeType;
    if (!["folder", "note", "markdown", "word"].includes(nodeType)) {
      return c.json({ error: "不支持的节点类型", code: "KNOWLEDGE_NODE_TYPE_UNSUPPORTED" }, 400);
    }
    const node = createKnowledgeChild({
      actorUserId: userIdOf(c),
      workspaceId: workspaceIdOf(c),
      parentId: typeof body.parentId === "string" && body.parentId ? body.parentId : null,
      nodeType,
      title: typeof body.title === "string" ? body.title : "",
    });
    return c.json(node, 201);
  } catch (error) {
    return mapError(c, error);
  }
});

app.patch("/nodes/:nodeId", async (c) => {
  try {
    const db = getDb();
    const nodeId = c.req.param("nodeId");
    const access = resolveKnowledgeNodeAccess(nodeId, userIdOf(c), db);
    const body = await c.req.json().catch(() => ({}));
    const title = typeof body.title === "string" ? body.title.trim() : undefined;
    const isExpanded = typeof body.isExpanded === "boolean" || body.isExpanded === 0 || body.isExpanded === 1
      ? Number(Boolean(body.isExpanded))
      : undefined;
    if (title !== undefined && !hasKnowledgeCapability(access, "canEdit")) {
      return c.json({ error: "没有重命名权限", code: "KNOWLEDGE_CAPABILITY_FORBIDDEN", required: "canEdit" }, 403);
    }
    if (isExpanded !== undefined && !access.capabilities.canView) {
      return c.json({ error: "权限不足", code: "KNOWLEDGE_CAPABILITY_FORBIDDEN", required: "canView" }, 403);
    }
    const node = db.prepare("SELECT resourceType, resourceId FROM knowledge_tree_nodes WHERE id = ? AND isDeleted = 0")
      .get(nodeId) as { resourceType: string; resourceId: string } | undefined;
    if (!node) return c.json({ error: "内容节点不存在", code: "KNOWLEDGE_NODE_NOT_FOUND" }, 404);
    db.transaction(() => {
      if (title !== undefined) {
        if (!title) throw new KnowledgeTreeError("KNOWLEDGE_TITLE_REQUIRED", 400, "名称不能为空");
        if (node.resourceType === "notebook") {
          db.prepare("UPDATE notebooks SET name = ?, updatedAt = datetime('now') WHERE id = ?").run(title, node.resourceId);
        } else if (node.resourceType === "note") {
          db.prepare("UPDATE notes SET title = ?, version = version + 1, updatedAt = datetime('now') WHERE id = ?").run(title, node.resourceId);
        } else if (node.resourceType === "mindmap") {
          db.prepare("UPDATE mindmaps SET title = ?, updatedAt = datetime('now') WHERE id = ?").run(title, node.resourceId);
        }
      }
      if (isExpanded !== undefined) {
        db.prepare("UPDATE knowledge_tree_nodes SET isExpanded = ?, updatedAt = datetime('now') WHERE id = ?")
          .run(isExpanded, nodeId);
        if (node.resourceType === "notebook") {
          db.prepare("UPDATE notebooks SET isExpanded = ? WHERE id = ?").run(isExpanded, node.resourceId);
        }
      }
    })();
    const refreshed = listKnowledgeTree({ userId: userIdOf(c), workspaceId: workspaceIdOf(c) })
      .find((entry) => entry.id === nodeId);
    return c.json(refreshed || { success: true });
  } catch (error) {
    return mapError(c, error);
  }
});

app.put("/nodes/:nodeId/move", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const node = moveKnowledgeNode({
      actorUserId: userIdOf(c),
      nodeId: c.req.param("nodeId"),
      parentId: typeof body.parentId === "string" && body.parentId ? body.parentId : null,
      sortOrder: typeof body.sortOrder === "number" ? body.sortOrder : undefined,
    });
    return c.json(node);
  } catch (error) {
    return mapError(c, error);
  }
});

app.put("/reorder", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    if (!Array.isArray(body.items)) return c.json({ error: "items is required" }, 400);
    return c.json(reorderKnowledgeNodes({ actorUserId: userIdOf(c), items: body.items }));
  } catch (error) {
    return mapError(c, error);
  }
});

app.delete("/nodes/:nodeId", (c) => {
  try {
    const mode = c.req.query("mode") === "promote" ? "promote" : "subtree";
    return c.json(deleteKnowledgeNode({
      actorUserId: userIdOf(c),
      nodeId: c.req.param("nodeId"),
      mode,
    }));
  } catch (error) {
    return mapError(c, error);
  }
});

app.post("/nodes/:nodeId/restore", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    return c.json(restoreKnowledgeNode({
      actorUserId: userIdOf(c),
      nodeId: c.req.param("nodeId"),
      includeSubtree: body.includeSubtree !== false,
    }));
  } catch (error) {
    return mapError(c, error);
  }
});

app.get("/nodes/:nodeId/permissions", (c) => {
  try {
    const nodeId = c.req.param("nodeId");
    const access = resolveKnowledgeNodeAccess(nodeId, userIdOf(c));
    if (!access.capabilities.canManageMembers) {
      return c.json({ error: "没有成员管理权限", code: "KNOWLEDGE_CAPABILITY_FORBIDDEN", required: "canManageMembers" }, 403);
    }
    return c.json({ ...listKnowledgeNodeRoles(nodeId), currentUserAccess: access });
  } catch (error) {
    return mapError(c, error);
  }
});

app.put("/nodes/:nodeId/permissions", async (c) => {
  try {
    const nodeId = c.req.param("nodeId");
    const actorUserId = userIdOf(c);
    const access = resolveKnowledgeNodeAccess(nodeId, actorUserId);
    if (!access.capabilities.canManageMembers) {
      return c.json({ error: "没有成员管理权限", code: "KNOWLEDGE_CAPABILITY_FORBIDDEN", required: "canManageMembers" }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    const preset = parseKnowledgeRolePreset(body.rolePreset);
    if (!preset) return c.json({ error: "无效角色预设", code: "KNOWLEDGE_ROLE_INVALID" }, 400);
    const subject = resolveKnowledgePermissionSubject(String(body.subject || body.userId || ""));
    if (!subject) return c.json({ error: "用户不存在", code: "KNOWLEDGE_PERMISSION_USER_NOT_FOUND" }, 404);
    const row = setKnowledgeNodeRole({
      nodeId,
      targetUserId: subject.id,
      rolePreset: preset,
      actorUserId,
    });
    return c.json({ ...row, user: subject, effective: resolveKnowledgeNodeAccess(nodeId, subject.id) });
  } catch (error) {
    return mapError(c, error);
  }
});

app.delete("/nodes/:nodeId/permissions/:userId", (c) => {
  try {
    const nodeId = c.req.param("nodeId");
    const actorUserId = userIdOf(c);
    const access = resolveKnowledgeNodeAccess(nodeId, actorUserId);
    if (!access.capabilities.canManageMembers) {
      return c.json({ error: "没有成员管理权限", code: "KNOWLEDGE_CAPABILITY_FORBIDDEN", required: "canManageMembers" }, 403);
    }
    const targetUserId = c.req.param("userId");
    return c.json({
      success: true,
      removed: clearKnowledgeNodeRole({ nodeId, targetUserId, actorUserId }),
      effective: resolveKnowledgeNodeAccess(nodeId, targetUserId),
    });
  } catch (error) {
    return mapError(c, error);
  }
});

app.get("/nodes/:nodeId/history", (c) => {
  try {
    return c.json({ history: listKnowledgeTreeHistory(c.req.param("nodeId"), userIdOf(c)) });
  } catch (error) {
    return mapError(c, error);
  }
});

export default app;
