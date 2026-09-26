import { Hono } from "hono";
import { getDb } from "../db/schema";
import { v4 as uuidv4 } from "uuid";
import {
  canManageResource,
  getUserWorkspaceRole,
  requireWorkspaceFeature,
} from "../middleware/acl";
import { ensureMindmapSchema } from "../lib/mindmap-schema";
import { mindmapFoldersRepository } from "../repositories";
import { MINDMAP_LEGACY_NOTEBOOK_PREFIX } from "../db/knowledgeTreeMindmapFolderMigration.js";

const app = new Hono();

// 初始化表（统一兜底：mindmaps + starred + folderId + mindmap_folders）
ensureMindmapSchema();

interface FolderRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  parentId: string | null;
  name: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

function resolveScope(
  workspaceIdRaw: string,
  userId: string,
): { scope: "personal" | "workspace"; workspaceId: string | null; error?: string } {
  const workspaceId = workspaceIdRaw?.trim() || "";
  if (!workspaceId || workspaceId === "personal") return { scope: "personal", workspaceId: null };
  const role = getUserWorkspaceRole(workspaceId, userId);
  if (!role) return { scope: "workspace", workspaceId, error: "无权访问该工作区" };
  return { scope: "workspace", workspaceId };
}

// ---------- 列表 ----------
app.get("/", requireWorkspaceFeature("mindmaps"), (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const scope = resolveScope(c.req.query("workspaceId") || "", userId);
  if (scope.error) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);

  const folderState = db.prepare("SELECT isDeleted FROM notebooks WHERE id = ?");
  const rows = mindmapFoldersRepository.listByUser(userId, scope.workspaceId).filter((folder) =>
    !(folderState.get(`${MINDMAP_LEGACY_NOTEBOOK_PREFIX}${folder.id}`) as { isDeleted: number } | undefined)?.isDeleted,
  );

  // 附加每个文件夹内的导图数量
  const countStmt = db.prepare(`
    SELECT COUNT(*) AS cnt FROM mindmaps map WHERE map.folderId = ?
      AND NOT EXISTS (SELECT 1 FROM knowledge_tree_nodes tree
        WHERE tree.resourceType = 'mindmap' AND tree.resourceId = map.id AND tree.isDeleted = 1)
  `);
  const result = rows.map((r) => ({
    ...r,
    mindmapCount: (countStmt.get(r.id) as any).cnt,
  }));

  return c.json(result);
});

// ---------- 创建 ----------
app.post("/", requireWorkspaceFeature("mindmaps"), async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const body = await c.req.json();
  const scope = resolveScope(c.req.query("workspaceId") || "", userId);
  if (scope.error) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);

  const parentId = body.parentId || null;
  const depth = mindmapFoldersRepository.getFolderDepth(parentId);
  if (depth >= 3) return c.json({ error: "最多支持三级文件夹" }, 400);

  const id = uuidv4();
  const name = body.name || "未命名文件夹";
  mindmapFoldersRepository.create({ id, userId, workspaceId: scope.workspaceId, parentId, name });

  const row = mindmapFoldersRepository.getById(id);
  return c.json(row, 201);
});

// ---------- 重命名 ----------
app.patch("/:id", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const body = await c.req.json();

  const existing = mindmapFoldersRepository.getById(id);
  if (!existing) return c.json({ error: "文件夹不存在" }, 404);
  if (!canManageResource(existing.userId, existing.workspaceId, userId)) {
    return c.json({ error: "无权修改此文件夹", code: "FORBIDDEN" }, 403);
  }

  if (body.name !== undefined) {
    mindmapFoldersRepository.updateName(id, body.name);
  }
  if (body.parentId !== undefined) {
    const newDepth = mindmapFoldersRepository.getFolderDepth(body.parentId);
    if (newDepth >= 3) return c.json({ error: "最多支持三级文件夹" }, 400);
    mindmapFoldersRepository.updateParentId(id, body.parentId);
  }
  if (body.sortOrder !== undefined) {
    mindmapFoldersRepository.updateSortOrder(id, body.sortOrder);
  }

  const row = mindmapFoldersRepository.getById(id);
  return c.json(row);
});

// ---------- 删除（导图移到未分类） ----------
app.delete("/:id", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");

  const existing = mindmapFoldersRepository.getById(id);
  if (!existing) return c.json({ error: "文件夹不存在" }, 404);
  if (!canManageResource(existing.userId, existing.workspaceId, userId)) {
    return c.json({ error: "无权删除此文件夹", code: "FORBIDDEN" }, 403);
  }

  // 把文件夹内的导图移到未分类
  db.prepare("UPDATE mindmaps SET folderId = NULL, updatedAt = datetime('now') WHERE folderId = ?").run(id);
  // 删除文件夹（Repository 会处理子文件夹移到顶层）
  mindmapFoldersRepository.delete(id);
  return c.json({ success: true });
});

export default app;
