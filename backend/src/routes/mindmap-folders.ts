import { Hono } from "hono";
import { getDb } from "../db/schema";
import { v4 as uuidv4 } from "uuid";
import {
  canManageResource,
  getUserWorkspaceRole,
  requireWorkspaceFeature,
} from "../middleware/acl";

const app = new Hono();

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

// 验证文件夹层级深度（最多三级）
function getFolderDepth(db: any, folderId: string | null): number {
  if (!folderId) return 0;
  let depth = 0;
  let currentId: string | null = folderId;
  while (currentId) {
    depth++;
    if (depth > 3) return depth;
    const row = db.prepare("SELECT parentId FROM mindmap_folders WHERE id = ?").get(currentId) as FolderRow | undefined;
    currentId = row?.parentId || null;
  }
  return depth;
}

// ---------- 列表 ----------
app.get("/", requireWorkspaceFeature("mindmaps"), (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const scope = resolveScope(c.req.query("workspaceId") || "", userId);
  if (scope.error) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);

  const sql =
    scope.scope === "workspace"
      ? "SELECT * FROM mindmap_folders WHERE workspaceId = ? ORDER BY sortOrder, name"
      : "SELECT * FROM mindmap_folders WHERE userId = ? AND workspaceId IS NULL ORDER BY sortOrder, name";
  const param = scope.scope === "workspace" ? scope.workspaceId : userId;
  const rows = db.prepare(sql).all(param) as FolderRow[];

  // 附加每个文件夹内的导图数量
  const countStmt = db.prepare("SELECT COUNT(*) as cnt FROM mindmaps WHERE folderId = ?");
  const result = rows.map((r: FolderRow) => ({
    ...r,
    mindmapCount: (countStmt.get(r.id) as any).cnt,
  }));

  return c.json(result);
});

// ---------- 创建 ----------
app.post("/", requireWorkspaceFeature("mindmaps"), async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const body = await c.req.json();
  const scope = resolveScope(c.req.query("workspaceId") || "", userId);
  if (scope.error) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);

  const parentId = body.parentId || null;
  const depth = getFolderDepth(db, parentId);
  if (depth >= 3) return c.json({ error: "最多支持三级文件夹" }, 400);

  const id = uuidv4();
  const name = body.name || "未命名文件夹";
  db.prepare(
    "INSERT INTO mindmap_folders (id, userId, workspaceId, parentId, name) VALUES (?, ?, ?, ?, ?)"
  ).run(id, userId, scope.workspaceId, parentId, name);

  const row = db.prepare("SELECT * FROM mindmap_folders WHERE id = ?").get(id);
  return c.json(row, 201);
});

// ---------- 重命名 ----------
app.patch("/:id", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const body = await c.req.json();

  const existing = db.prepare("SELECT * FROM mindmap_folders WHERE id = ?").get(id) as FolderRow | undefined;
  if (!existing) return c.json({ error: "文件夹不存在" }, 404);
  if (!canManageResource(existing.userId, existing.workspaceId, userId)) {
    return c.json({ error: "无权修改此文件夹", code: "FORBIDDEN" }, 403);
  }

  if (body.name !== undefined) {
    db.prepare("UPDATE mindmap_folders SET name = ?, updatedAt = datetime('now') WHERE id = ?").run(body.name, id);
  }
  if (body.parentId !== undefined) {
    const newDepth = getFolderDepth(db, body.parentId);
    if (newDepth >= 3) return c.json({ error: "最多支持三级文件夹" }, 400);
    db.prepare("UPDATE mindmap_folders SET parentId = ?, updatedAt = datetime('now') WHERE id = ?").run(body.parentId, id);
  }
  if (body.sortOrder !== undefined) {
    db.prepare("UPDATE mindmap_folders SET sortOrder = ?, updatedAt = datetime('now') WHERE id = ?").run(body.sortOrder, id);
  }

  const row = db.prepare("SELECT * FROM mindmap_folders WHERE id = ?").get(id);
  return c.json(row);
});

// ---------- 删除（导图移到未分类） ----------
app.delete("/:id", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");

  const existing = db.prepare("SELECT * FROM mindmap_folders WHERE id = ?").get(id) as FolderRow | undefined;
  if (!existing) return c.json({ error: "文件夹不存在" }, 404);
  if (!canManageResource(existing.userId, existing.workspaceId, userId)) {
    return c.json({ error: "无权删除此文件夹", code: "FORBIDDEN" }, 403);
  }

  // 把文件夹内的导图移到未分类
  db.prepare("UPDATE mindmaps SET folderId = NULL, updatedAt = datetime('now') WHERE folderId = ?").run(id);
  // 把子文件夹也移到顶层
  db.prepare("UPDATE mindmap_folders SET parentId = NULL, updatedAt = datetime('now') WHERE parentId = ?").run(id);
  db.prepare("DELETE FROM mindmap_folders WHERE id = ?").run(id);
  return c.json({ success: true });
});

export default app;