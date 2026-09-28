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

function normalizeFolderName(value: unknown): { name?: string; error?: string } {
  if (value === undefined || value === null) return { name: "未命名文件夹" };
  if (typeof value !== "string") return { error: "文件夹名称格式无效" };
  const name = value.trim();
  if (!name) return { error: "文件夹名称不能为空" };
  if (name.length > 120) return { error: "文件夹名称不能超过 120 个字符" };
  return { name };
}

function parentMatchesScope(parent: FolderRow, userId: string, workspaceId: string | null): boolean {
  return workspaceId
    ? parent.workspaceId === workspaceId
    : parent.workspaceId === null && parent.userId === userId;
}

function validateParent(
  parentId: string | null,
  userId: string,
  workspaceId: string | null,
): { error?: string; status?: 403 | 404 } {
  if (!parentId) return {};
  const parent = mindmapFoldersRepository.getById(parentId) as FolderRow | undefined;
  if (!parent) return { error: "父文件夹不存在", status: 404 };
  if (!parentMatchesScope(parent, userId, workspaceId)) {
    return { error: "不能跨个人空间或工作区使用父文件夹", status: 403 };
  }
  return {};
}

function isDuplicateFolderName(
  name: string,
  userId: string,
  workspaceId: string | null,
  parentId: string | null,
  excludeId?: string,
): boolean {
  const db = getDb();
  const scopeSql = workspaceId ? "workspaceId = ?" : "userId = ? AND workspaceId IS NULL";
  const scopeValue = workspaceId || userId;
  const sql = `
    SELECT id FROM mindmap_folders
    WHERE ${scopeSql}
      AND parentId IS ?
      AND lower(trim(name)) = lower(?)
      ${excludeId ? "AND id <> ?" : ""}
    LIMIT 1
  `;
  const params = excludeId
    ? [scopeValue, parentId, name, excludeId]
    : [scopeValue, parentId, name];
  return Boolean(db.prepare(sql).get(...params));
}

function wouldCreateCycle(folderId: string, parentId: string | null): boolean {
  if (!parentId) return false;
  const visited = new Set<string>();
  let currentId: string | null = parentId;
  while (currentId && !visited.has(currentId)) {
    if (currentId === folderId) return true;
    visited.add(currentId);
    currentId = mindmapFoldersRepository.getById(currentId)?.parentId || null;
  }
  return false;
}

function folderSubtreeHeight(folderId: string): number {
  const rows = getDb().prepare("SELECT id, parentId FROM mindmap_folders").all() as Array<{
    id: string;
    parentId: string | null;
  }>;
  const children = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.parentId) continue;
    const list = children.get(row.parentId) || [];
    list.push(row.id);
    children.set(row.parentId, list);
  }
  const walk = (id: string, visiting: Set<string>): number => {
    if (visiting.has(id)) return 1;
    const next = new Set(visiting);
    next.add(id);
    return 1 + Math.max(0, ...(children.get(id) || []).map((childId) => walk(childId, next)));
  };
  return walk(folderId, new Set());
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

  const parentId = typeof body.parentId === "string" && body.parentId.trim()
    ? body.parentId.trim()
    : null;
  const parentCheck = validateParent(parentId, userId, scope.workspaceId);
  if (parentCheck.error) {
    return c.json(
      { error: parentCheck.error, code: "MINDMAP_FOLDER_PARENT_SCOPE_MISMATCH" },
      parentCheck.status || 400,
    );
  }

  const nameResult = normalizeFolderName(body.name);
  if (!nameResult.name) {
    return c.json({ error: nameResult.error || "文件夹名称无效", code: "INVALID_FOLDER_NAME" }, 400);
  }
  const depth = mindmapFoldersRepository.getFolderDepth(parentId);
  if (depth >= 3) return c.json({ error: "最多支持三级文件夹", code: "MINDMAP_FOLDER_DEPTH_LIMIT" }, 400);
  if (isDuplicateFolderName(nameResult.name, userId, scope.workspaceId, parentId)) {
    return c.json({ error: "同级已存在同名文件夹", code: "MINDMAP_FOLDER_DUPLICATE" }, 409);
  }

  const id = uuidv4();
  mindmapFoldersRepository.create({
    id,
    userId,
    workspaceId: scope.workspaceId,
    parentId,
    name: nameResult.name,
  });

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

  const nextParentId = body.parentId === undefined
    ? existing.parentId
    : typeof body.parentId === "string" && body.parentId.trim()
      ? body.parentId.trim()
      : null;

  if (body.parentId !== undefined) {
    const parentCheck = validateParent(nextParentId, existing.userId, existing.workspaceId);
    if (parentCheck.error) {
      return c.json(
        { error: parentCheck.error, code: "MINDMAP_FOLDER_PARENT_SCOPE_MISMATCH" },
        parentCheck.status || 400,
      );
    }
    if (wouldCreateCycle(id, nextParentId)) {
      return c.json({ error: "不能把文件夹移动到自身或其子文件夹下", code: "MINDMAP_FOLDER_CYCLE" }, 400);
    }
    const newDepth = mindmapFoldersRepository.getFolderDepth(nextParentId);
    if (newDepth + folderSubtreeHeight(id) > 3) {
      return c.json({ error: "最多支持三级文件夹", code: "MINDMAP_FOLDER_DEPTH_LIMIT" }, 400);
    }
  }

  const nextNameResult = body.name === undefined
    ? { name: existing.name }
    : normalizeFolderName(body.name);
  if (!nextNameResult.name) {
    return c.json({ error: nextNameResult.error || "文件夹名称无效", code: "INVALID_FOLDER_NAME" }, 400);
  }
  if (isDuplicateFolderName(nextNameResult.name, existing.userId, existing.workspaceId, nextParentId, id)) {
    return c.json({ error: "同级已存在同名文件夹", code: "MINDMAP_FOLDER_DUPLICATE" }, 409);
  }

  if (body.name !== undefined) {
    mindmapFoldersRepository.updateName(id, nextNameResult.name);
  }
  if (body.parentId !== undefined) {
    mindmapFoldersRepository.updateParentId(id, nextParentId);
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
