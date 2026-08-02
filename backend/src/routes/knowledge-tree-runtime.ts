import { Hono, type Context } from "hono";

import type { DatabaseAdapter } from "../db/adapters/types";
import type { DatabaseDialect } from "../db/dialect";
import { createKnowledgeTreeReadRepository } from "../repositories/knowledgeTreeReadRepository";

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

export default function createKnowledgeTreeRuntimeRouter(
  adapter: DatabaseAdapter,
  dialect: DatabaseDialect,
) {
  const app = new Hono();
  const repository = createKnowledgeTreeReadRepository(adapter, dialect);

  app.get("/roles", (c) => c.json({ roles: ROLE_DEFINITIONS }));

  const listKnowledgeTree = async (c: Context) => {
    try {
      const userId = userIdOf(c);
      if (!userId) {
        return c.json({ error: "未授权，请先登录", code: "UNAUTHENTICATED" }, 401);
      }

      const nodes = await repository.list({
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

  return app;
}
