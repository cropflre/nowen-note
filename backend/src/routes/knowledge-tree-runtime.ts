import { Hono, type Context } from "hono";

import type { DatabaseAdapter } from "../db/adapters/types";
import type { DatabaseDialect } from "../db/dialect";
import { createKnowledgeTreeLifecycleMutationRepository } from "../repositories/knowledgeTreeLifecycleMutationRepository";
import {
  createKnowledgeTreeMutationRepository,
  KnowledgeTreeMutationError,
} from "../repositories/knowledgeTreeMutationRepository";
import { createKnowledgeTreeReadRepository } from "../repositories/knowledgeTreeReadRepository";
import { createKnowledgeTreeStructureMutationRepository } from "../repositories/knowledgeTreeStructureMutationRepository";

const ROLE_DEFINITIONS = [
  { id: "readonly", label: "只读成员", capabilities: ["canView", "canDownload"] },
  {
    id: "editor",
    label: "编辑成员",
    capabilities: ["canView", "canComment", "canCreate", "canEdit", "canDownload"],
  },
  {
    id: "maintainer",
    label: "维护成员",
    capabilities: [
      "canView",
      "canComment",
      "canCreate",
      "canEdit",
      "canDelete",
      "canMove",
      "canDownload",
    ],
  },
  {
    id: "admin",
    label: "管理员",
    capabilities: [
      "canView",
      "canComment",
      "canCreate",
      "canEdit",
      "canDelete",
      "canMove",
      "canDownload",
      "canReshare",
      "canManageMembers",
    ],
  },
] as const;

function userIdOf(c: Context): string {
  return c.req.header("X-User-Id") || "";
}

function workspaceIdOf(c: Context): string | null {
  const value = c.req.query("workspaceId");
  return !value || value === "personal" ? null : value;
}

function mutationError(c: Context, error: unknown): Response {
  if (error instanceof KnowledgeTreeMutationError) {
    return c.json(
      { error: error.message, code: error.code, ...error.details },
      error.status,
    );
  }
  console.error(
    "[knowledge-tree-runtime] mutation failed:",
    error instanceof Error ? error.message : error,
  );
  return c.json(
    { error: "知识树操作失败", code: "KNOWLEDGE_TREE_MUTATION_FAILED" },
    500,
  );
}

function unauthenticated(c: Context): Response | null {
  return userIdOf(c)
    ? null
    : c.json({ error: "未授权，请先登录", code: "UNAUTHENTICATED" }, 401);
}

export default function createKnowledgeTreeRuntimeRouter(
  adapter: DatabaseAdapter,
  dialect: DatabaseDialect,
) {
  const app = new Hono();
  const readRepository = createKnowledgeTreeReadRepository(adapter, dialect);
  const mutationRepository = createKnowledgeTreeMutationRepository(adapter, dialect);
  const structureRepository = createKnowledgeTreeStructureMutationRepository(adapter, dialect);
  const lifecycleRepository = createKnowledgeTreeLifecycleMutationRepository(adapter, dialect);

  app.get("/roles", (c) => c.json({ roles: ROLE_DEFINITIONS }));

  const listKnowledgeTree = async (c: Context) => {
    try {
      const userId = userIdOf(c);
      if (!userId) {
        return c.json({ error: "未授权，请先登录", code: "UNAUTHENTICATED" }, 401);
      }

      const nodes = await readRepository.list({
        userId,
        workspaceId: workspaceIdOf(c),
        includeDeleted: c.req.query("includeDeleted") === "1",
      });
      return c.json({ nodes });
    } catch (error) {
      console.error(
        "[knowledge-tree-runtime] list failed:",
        error instanceof Error ? error.message : error,
      );
      return c.json(
        { error: "知识树读取失败", code: "KNOWLEDGE_TREE_READ_FAILED" },
        500,
      );
    }
  };

  app.get("", listKnowledgeTree);
  app.get("/", listKnowledgeTree);

  app.post("/nodes", async (c) => {
    const unauthorized = unauthenticated(c);
    if (unauthorized) return unauthorized;

    try {
      const body = await c.req.json().catch(() => ({}));
      const nodeType = body.nodeType;
      if (!["folder", "note", "markdown", "word"].includes(nodeType)) {
        return c.json(
          { error: "不支持的节点类型", code: "KNOWLEDGE_NODE_TYPE_UNSUPPORTED" },
          400,
        );
      }

      const node = await mutationRepository.createNode({
        actorUserId: userIdOf(c),
        workspaceId: workspaceIdOf(c),
        parentId: typeof body.parentId === "string" && body.parentId
          ? body.parentId
          : null,
        nodeType,
        title: typeof body.title === "string" ? body.title : "",
      });
      return c.json(node, 201);
    } catch (error) {
      return mutationError(c, error);
    }
  });

  app.put("/nodes/:nodeId/move", async (c) => {
    const unauthorized = unauthenticated(c);
    if (unauthorized) return unauthorized;

    try {
      const body = await c.req.json().catch(() => ({}));
      if (body.parentId !== null && typeof body.parentId !== "string") {
        return c.json(
          { error: "目标父级格式错误", code: "KNOWLEDGE_PARENT_INVALID" },
          400,
        );
      }
      if (body.sortOrder !== undefined && !Number.isFinite(Number(body.sortOrder))) {
        return c.json(
          { error: "排序值格式错误", code: "KNOWLEDGE_SORT_ORDER_INVALID" },
          400,
        );
      }

      const node = await structureRepository.moveNode({
        actorUserId: userIdOf(c),
        workspaceId: workspaceIdOf(c),
        nodeId: c.req.param("nodeId"),
        parentId: typeof body.parentId === "string" && body.parentId.trim()
          ? body.parentId.trim()
          : null,
        sortOrder: body.sortOrder === undefined ? undefined : Number(body.sortOrder),
      });
      return c.json(node);
    } catch (error) {
      return mutationError(c, error);
    }
  });

  app.put("/reorder", async (c) => {
    const unauthorized = unauthenticated(c);
    if (unauthorized) return unauthorized;

    try {
      const body = await c.req.json().catch(() => ({}));
      if (!Array.isArray(body.items)) {
        return c.json(
          { error: "排序列表格式错误", code: "KNOWLEDGE_REORDER_INVALID" },
          400,
        );
      }
      const items: Array<{ id: string; sortOrder: number }> = [];
      for (const item of body.items) {
        if (
          !item
          || typeof item.id !== "string"
          || !item.id.trim()
          || !Number.isFinite(Number(item.sortOrder))
        ) {
          return c.json(
            { error: "排序节点格式错误", code: "KNOWLEDGE_REORDER_INVALID" },
            400,
          );
        }
        items.push({ id: item.id.trim(), sortOrder: Number(item.sortOrder) });
      }

      return c.json(await structureRepository.reorderNodes({
        actorUserId: userIdOf(c),
        workspaceId: workspaceIdOf(c),
        items,
      }));
    } catch (error) {
      return mutationError(c, error);
    }
  });

  app.delete("/nodes/:nodeId", async (c) => {
    const unauthorized = unauthenticated(c);
    if (unauthorized) return unauthorized;

    try {
      const mode = c.req.query("mode") === "promote" ? "promote" : "subtree";
      return c.json(await lifecycleRepository.deleteNode({
        actorUserId: userIdOf(c),
        workspaceId: workspaceIdOf(c),
        nodeId: c.req.param("nodeId"),
        mode,
      }));
    } catch (error) {
      return mutationError(c, error);
    }
  });

  app.post("/nodes/:nodeId/restore", async (c) => {
    const unauthorized = unauthenticated(c);
    if (unauthorized) return unauthorized;

    try {
      const body = await c.req.json().catch(() => ({}));
      return c.json(await lifecycleRepository.restoreNode({
        actorUserId: userIdOf(c),
        workspaceId: workspaceIdOf(c),
        nodeId: c.req.param("nodeId"),
        includeSubtree: body.includeSubtree !== false,
      }));
    } catch (error) {
      return mutationError(c, error);
    }
  });

  app.patch("/nodes/:nodeId", async (c) => {
    const unauthorized = unauthenticated(c);
    if (unauthorized) return unauthorized;

    try {
      const body = await c.req.json().catch(() => ({}));
      const title = typeof body.title === "string" ? body.title : undefined;
      const isExpanded = typeof body.isExpanded === "boolean"
        || body.isExpanded === 0
        || body.isExpanded === 1
        ? Boolean(body.isExpanded)
        : undefined;

      const node = await mutationRepository.patchNode({
        actorUserId: userIdOf(c),
        workspaceId: workspaceIdOf(c),
        nodeId: c.req.param("nodeId"),
        title,
        isExpanded,
      });
      return c.json(node);
    } catch (error) {
      return mutationError(c, error);
    }
  });

  return app;
}
