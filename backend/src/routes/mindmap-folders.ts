import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import {
  canManageResource,
  getUserWorkspaceRole,
  requireWorkspaceFeature,
} from "../middleware/acl";
import { ensureMindmapSchema } from "../lib/mindmap-schema";
import {
  mindmapFolderOperationsRepository,
  mindmapFoldersRepository,
} from "../repositories";

const app = new Hono();

// 初始化表（统一兜底：mindmaps + starred + folderId + mindmap_folders）
ensureMindmapSchema();

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

  const rows = await mindmapFoldersRepository.listByUserAsync(userId, scope.workspaceId);
  const counts = await mindmapFolderOperationsRepository.listCountsByFolderIdsAsync(
    rows.map((row) => row.id),
  );
  const countMap = new Map(counts.map((row) => [row.folderId, row.count]));

  return c.json(rows.map((row) => ({
    ...row,
    mindmapCount: countMap.get(row.id) || 0,
  })));
});

// ---------- 创建 ----------
app.post("/", requireWorkspaceFeature("mindmaps"), async (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const body = await c.req.json();
  const scope = resolveScope(c.req.query("workspaceId") || "", userId);
  if (scope.error) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);

  const parentId = body.parentId || null;
  const depth = await mindmapFoldersRepository.getFolderDepthAsync(parentId);
  if (depth >= 3) return c.json({ error: "最多支持三级文件夹" }, 400);

  const id = uuidv4();
  const name = body.name || "未命名文件夹";
  await mindmapFoldersRepository.createAsync({
    id,
    userId,
    workspaceId: scope.workspaceId,
    parentId,
    name,
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

  if (body.name !== undefined) {
    await mindmapFoldersRepository.updateNameAsync(id, body.name);
  }
  if (body.parentId !== undefined) {
    const newDepth = await mindmapFoldersRepository.getFolderDepthAsync(body.parentId);
    if (newDepth >= 3) return c.json({ error: "最多支持三级文件夹" }, 400);
    await mindmapFoldersRepository.updateParentIdAsync(id, body.parentId);
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
