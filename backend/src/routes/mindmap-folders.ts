import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import {
  canManageResource,
  getUserWorkspaceRole,
  requireWorkspaceFeature,
} from "../middleware/acl";
import { ensureMindmapSchema } from "../lib/mindmap-schema";
import { mindmapFoldersRepository, mindmapFolderOperationsRepository } from "../repositories";
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

async function validateParent(
  parentId: string | null, userId: string, workspaceId: string | null,
): Promise<{ error?: string; status?: 403 | 404 }> {
  if (!parentId) return {};
  const parent = await mindmapFoldersRepository.getByIdAsync(parentId);
  if (!parent) return { error: "父文件夹不存在", status: 404 };
  if (!parentMatchesScope(parent, userId, workspaceId)) {
    return { error: "不能跨个人空间或工作区使用父文件夹", status: 403 };
  }
  return {};
}

async function isDuplicateFolderName(
  name: string, userId: string, workspaceId: string | null,
  parentId: string | null, excludeId?: string,
): Promise<boolean> {
  const rows = await mindmapFoldersRepository.listByUserAsync(userId, workspaceId);
  return rows.some(row => row.id !== excludeId &&
    row.parentId === parentId &&
    row.name.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase());
}

async function wouldCreateCycle(folderId: string, parentId: string | null): Promise<boolean> {
  if (!parentId) return false;
  const visited = new Set<string>();
  let currentId: string | null = parentId;
  while (currentId && !visited.has(currentId)) {
    if (currentId === folderId) return true;
    visited.add(currentId);
    currentId = (await mindmapFoldersRepository.getByIdAsync(currentId))?.parentId || null;
  }
  return currentId !== null;
}

async function folderSubtreeHeight(
  folderId: string, userId: string, workspaceId: string | null,
): Promise<number> {
  const rows = await mindmapFoldersRepository.listByUserAsync(userId, workspaceId);
  const children = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.parentId) continue;
    const list = children.get(row.parentId) || [];
    list.push(row.id);
    children.set(row.parentId, list);
  }
  const walk = (id: string, seen: Set<string>): number => {
    if (seen.has(id)) return 4;
    const next = new Set(seen);
    next.add(id);
    return 1 + Math.max(0, ...(children.get(id) || []).map(childId => walk(childId, next)));
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
app.get("/", requireWorkspaceFeature("mindmaps"), async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const scope = resolveScope(c.req.query("workspaceId") || "", userId);
  if (scope.error) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);

  const allRows = await mindmapFoldersRepository.listByUserAsync(userId, scope.workspaceId);
  const deletedIds = new Set(await mindmapFolderOperationsRepository.listDeletedLegacyFolderIdsAsync(
    allRows.map(row => MINDMAP_LEGACY_NOTEBOOK_PREFIX + row.id),
  ));
  const rows = allRows.filter(row => !deletedIds.has(MINDMAP_LEGACY_NOTEBOOK_PREFIX + row.id));
  const counts = await mindmapFolderOperationsRepository.listCountsByFolderIdsAsync(rows.map(row => row.id));
  const countMap = new Map(counts.map(row => [row.folderId, row.count]));
  return c.json(rows.map(row => ({ ...row, mindmapCount: countMap.get(row.id) || 0 })));
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
  const parentCheck = await validateParent(parentId, userId, scope.workspaceId);
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
  const depth = await mindmapFoldersRepository.getFolderDepthAsync(parentId);
  if (depth >= 3) return c.json({ error: "最多支持三级文件夹", code: "MINDMAP_FOLDER_DEPTH_LIMIT" }, 400);
  if (await isDuplicateFolderName(nameResult.name, userId, scope.workspaceId, parentId)) {
    return c.json({ error: "同级已存在同名文件夹", code: "MINDMAP_FOLDER_DUPLICATE" }, 409);
  }

  const id = uuidv4();
  await mindmapFoldersRepository.createAsync({
    id,
    userId,
    workspaceId: scope.workspaceId,
    parentId,
    name: nameResult.name,
  });

  const row = await mindmapFoldersRepository.getByIdAsync(id);
  return c.json(row, 201);
});

// ---------- 重命名 ----------
app.patch("/:id", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const body = await c.req.json();

  const existing = await mindmapFoldersRepository.getByIdAsync(id);
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
    const parentCheck = await validateParent(nextParentId, existing.userId, existing.workspaceId);
    if (parentCheck.error) {
      return c.json(
        { error: parentCheck.error, code: "MINDMAP_FOLDER_PARENT_SCOPE_MISMATCH" },
        parentCheck.status || 400,
      );
    }
    if (await wouldCreateCycle(id, nextParentId)) {
      return c.json({ error: "不能把文件夹移动到自身或其子文件夹下", code: "MINDMAP_FOLDER_CYCLE" }, 400);
    }
    const newDepth = await mindmapFoldersRepository.getFolderDepthAsync(nextParentId);
    if (newDepth + await folderSubtreeHeight(id, existing.userId, existing.workspaceId) > 3) {
      return c.json({ error: "最多支持三级文件夹", code: "MINDMAP_FOLDER_DEPTH_LIMIT" }, 400);
    }
  }

  const nextNameResult = body.name === undefined
    ? { name: existing.name }
    : normalizeFolderName(body.name);
  if (!nextNameResult.name) {
    return c.json({ error: nextNameResult.error || "文件夹名称无效", code: "INVALID_FOLDER_NAME" }, 400);
  }
  if (await isDuplicateFolderName(nextNameResult.name, existing.userId, existing.workspaceId, nextParentId, id)) {
    return c.json({ error: "同级已存在同名文件夹", code: "MINDMAP_FOLDER_DUPLICATE" }, 409);
  }

  if (body.name !== undefined) {
    await mindmapFoldersRepository.updateNameAsync(id, nextNameResult.name);
  }
  if (body.parentId !== undefined) {
    await mindmapFoldersRepository.updateParentIdAsync(id, nextParentId);
  }
  if (body.sortOrder !== undefined) {
    await mindmapFoldersRepository.updateSortOrderAsync(id, body.sortOrder);
  }

  const row = await mindmapFoldersRepository.getByIdAsync(id);
  return c.json(row);
});

// ---------- 删除（导图移到未分类） ----------
app.delete("/:id", async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const existing = await mindmapFoldersRepository.getByIdAsync(id);
  if (!existing) return c.json({ error: "文件夹不存在" }, 404);
  if (!canManageResource(existing.userId, existing.workspaceId, userId)) {
    return c.json({ error: "无权删除此文件夹", code: "FORBIDDEN" }, 403);
  }
  await mindmapFolderOperationsRepository.deleteFolderAndUnassignAsync(id);
  return c.json({ success: true });
});

export default app;
