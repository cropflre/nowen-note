/**
 * 思维导图路由（工作区数据隔离 Phase 2 - Y4）
 * ---------------------------------------------------------------------------
 * 与 diary / tasks 同构：
 *   - 集合接口（list / create）：挂 `requireWorkspaceFeature("mindmaps")`，
 *     通过 `?workspaceId=` 切换 scope（不传/空 = 个人空间）。
 *   - 单资源按 id 接口（read / update / delete）：**不**挂 feature 中间件，
 *     这样工作区关闭 mindmaps 后，老成员依然可以读/善后自己已有的导图。
 *   - 读取：
 *       personal → userId = ? AND workspaceId IS NULL
 *       workspace → workspaceId = ? （全员可见，与 diary 同）
 *   - 写/删：`canManageResource(creatorId, workspaceId, actorId)`
 *     （本人 + 工作区 admin/owner）
 *   - 不允许通过 PUT 修改 workspaceId——导图一旦落到一个空间就不迁移，
 *     避免权限与附件归属的连带错位。
 */
import { Hono } from "hono";
import { getDb } from "../db/schema";
import { v4 as uuidv4 } from "uuid";
import {
  canManageResource,
  getUserWorkspaceRole,
  requireWorkspaceFeature,
} from "../middleware/acl";
import { ensureMindmapSchema } from "../lib/mindmap-schema";
import { deleteKnowledgeNode, KnowledgeTreeError } from "../services/knowledgeTree.js";
import { resolveResourceKnowledgeAccessForTombstone } from "../services/knowledgeCapabilities.js";

const app = new Hono();

// 初始化表（统一兜底：mindmaps + starred + folderId + mindmap_folders）
ensureMindmapSchema();

interface MindmapRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  title: string;
  data: string;
  starred: number;
  folderId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 解析请求的 scope（personal / workspace）。
 *   - 没传 workspaceId（空串/缺省）→ 个人空间
 *   - 传了但用户不是该工作区成员 → error
 */
function resolveMindmapScope(
  workspaceIdRaw: string,
  userId: string,
): { scope: "personal" | "workspace"; workspaceId: string | null; error?: string } {
  const workspaceId = workspaceIdRaw?.trim() || "";
  if (!workspaceId || workspaceId === "personal") return { scope: "personal", workspaceId: null };
  const role = getUserWorkspaceRole(workspaceId, userId);
  if (!role) return { scope: "workspace", workspaceId, error: "无权访问该工作区" };
  return { scope: "workspace", workspaceId };
}

/** 读权限：本人个人空间 OR 工作区成员。 */
function canReadMindmap(row: MindmapRow, userId: string): boolean {
  if (!row.workspaceId) return row.userId === userId;
  return getUserWorkspaceRole(row.workspaceId, userId) !== null;
}

// The knowledge-tree tombstone is the canonical trash state for mindmaps. A legacy map
// without a projected tree node remains readable until the migration repairs it.
const ACTIVE_MINDMAP = `NOT EXISTS (
  SELECT 1 FROM knowledge_tree_nodes tree
  WHERE tree.resourceType = 'mindmap' AND tree.resourceId = m.id AND tree.isDeleted = 1
)`;

function readActiveMindmap(db: ReturnType<typeof getDb>, id: string): MindmapRow | undefined {
  return db.prepare(`SELECT m.* FROM mindmaps m WHERE m.id = ? AND ${ACTIVE_MINDMAP}`)
    .get(id) as MindmapRow | undefined;
}

// ---------- 列表 ----------
app.get("/", requireWorkspaceFeature("mindmaps"), (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const scope = resolveMindmapScope(c.req.query("workspaceId") || "", userId);
  if (scope.error) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);

  // creatorName：与 notes/tasks/diary 同款——LEFT JOIN users 拉创建者用户名，
  // 工作区下导图列表用来展示"谁建的"。LEFT JOIN 兜底用户被删除的极端窗口期。
  const sql =
    scope.scope === "workspace"
      ? `SELECT m.id, m.userId, m.workspaceId, m.title, m.starred, m.folderId, m.createdAt, m.updatedAt,
                u.username AS creatorName
         FROM mindmaps m LEFT JOIN users u ON u.id = m.userId
         WHERE m.workspaceId = ? AND ${ACTIVE_MINDMAP} ORDER BY m.starred DESC, m.updatedAt DESC`
      : `SELECT m.id, m.userId, m.workspaceId, m.title, m.starred, m.folderId, m.createdAt, m.updatedAt,
                u.username AS creatorName
         FROM mindmaps m LEFT JOIN users u ON u.id = m.userId
         WHERE m.userId = ? AND m.workspaceId IS NULL AND ${ACTIVE_MINDMAP} ORDER BY m.starred DESC, m.updatedAt DESC`;
  const param = scope.scope === "workspace" ? scope.workspaceId : userId;
  const rows = db.prepare(sql).all(param);
  return c.json(rows);
});

// ---------- 单个读取 ----------
// 不挂 feature 中间件：功能关闭后仍允许按 id 读取（善后用）。
app.get("/:id", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const row = readActiveMindmap(db, id);
  if (!row) return c.json({ error: "思维导图不存在" }, 404);
  if (!canReadMindmap(row, userId)) {
    return c.json({ error: "无权访问该导图", code: "FORBIDDEN" }, 403);
  }
  return c.json({
    ...row,
    canEdit: canManageResource(row.userId, row.workspaceId, userId),
  });
});

// ---------- 创建 ----------
app.post("/", requireWorkspaceFeature("mindmaps"), async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const body = await c.req.json();
  const scope = resolveMindmapScope(c.req.query("workspaceId") || "", userId);
  if (scope.error) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);

  const id = uuidv4();
  const title = body.title || "无标题导图";

  // 默认初始数据：一个根节点
  const defaultData = JSON.stringify({
    root: {
      id: "root",
      text: title,
      children: [],
    },
  });
  const data = body.data || defaultData;

  db.prepare(
    "INSERT INTO mindmaps (id, userId, workspaceId, title, data) VALUES (?, ?, ?, ?, ?)",
  ).run(
    id,
    userId,
    scope.workspaceId,
    title,
    typeof data === "string" ? data : JSON.stringify(data),
  );

  const row = db.prepare("SELECT * FROM mindmaps WHERE id = ?").get(id);
  return c.json(row, 201);
});

// ---------- 更新 ----------
app.put("/:id", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const body = await c.req.json<{
    title?: string;
    data?: string | Record<string, unknown>;
    /**
     * 可选乐观锁。文档内弹层编辑等多入口编辑场景必须携带读取时的 updatedAt，
     * 防止独立脑图中心/另一个浏览器窗口的更新被静默覆盖。
     */
    expectedUpdatedAt?: string;
  }>();

  const existing = readActiveMindmap(db, id);
  if (!existing) return c.json({ error: "思维导图不存在" }, 404);

  if (!canManageResource(existing.userId, existing.workspaceId, userId)) {
    return c.json({ error: "无权修改此导图", code: "FORBIDDEN" }, 403);
  }

  const expectedUpdatedAt =
    typeof body.expectedUpdatedAt === "string" && body.expectedUpdatedAt.trim()
      ? body.expectedUpdatedAt.trim()
      : null;

  if (expectedUpdatedAt && expectedUpdatedAt !== existing.updatedAt) {
    return c.json({
      error: "思维导图已在其他窗口更新，请重新加载后再保存",
      code: "MINDMAP_CONFLICT",
      currentUpdatedAt: existing.updatedAt,
    }, 409);
  }

  const updates: string[] = [];
  const values: any[] = [];

  if (body.title !== undefined) {
    updates.push("title = ?");
    values.push(body.title);
  }
  if (body.data !== undefined) {
    updates.push("data = ?");
    values.push(typeof body.data === "string" ? body.data : JSON.stringify(body.data));
  }
  // 显式忽略 body.workspaceId：不允许跨空间迁移

  if (updates.length > 0) {
    // 使用毫秒精度，确保同一秒内连续保存也能可靠参与下一次乐观锁比较。
    updates.push("updatedAt = strftime('%Y-%m-%d %H:%M:%f', 'now')");
    const where = expectedUpdatedAt
      ? "WHERE id = ? AND updatedAt = ?"
      : "WHERE id = ?";
    values.push(id);
    if (expectedUpdatedAt) values.push(expectedUpdatedAt);
    const result = db.prepare(`UPDATE mindmaps SET ${updates.join(", ")} ${where}`).run(...values);
    if (expectedUpdatedAt && result.changes === 0) {
      const latest = db.prepare("SELECT updatedAt FROM mindmaps WHERE id = ?").get(id) as
        | { updatedAt: string }
        | undefined;
      return c.json({
        error: "思维导图已在其他窗口更新，请重新加载后再保存",
        code: "MINDMAP_CONFLICT",
        currentUpdatedAt: latest?.updatedAt || null,
      }, 409);
    }
  }

  const row = db.prepare("SELECT * FROM mindmaps WHERE id = ?").get(id) as MindmapRow;
  return c.json({
    ...row,
    canEdit: canManageResource(row.userId, row.workspaceId, userId),
  });
});

// ---------- 删除 ----------
app.delete("/:id", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");

  const existing = readActiveMindmap(db, id);
  if (!existing) return c.json({ error: "思维导图不存在" }, 404);

  if (!canManageResource(existing.userId, existing.workspaceId, userId)) {
    return c.json({ error: "无权删除此导图", code: "FORBIDDEN" }, 403);
  }

  const node = db.prepare(`
    SELECT id FROM knowledge_tree_nodes
    WHERE resourceType = 'mindmap' AND resourceId = ? AND isDeleted = 0
  `).get(id) as { id: string } | undefined;
  if (!node) return c.json({ error: "脑图目录节点不存在，请先修复数据", code: "KNOWLEDGE_NODE_SYNC_FAILED" }, 409);
  try {
    deleteKnowledgeNode({ actorUserId: userId, nodeId: node.id, mode: "subtree", db });
  } catch (error) {
    if (error instanceof KnowledgeTreeError) return c.json({ error: error.message, code: error.code }, error.status);
    throw error;
  }
  return c.json({ success: true });
});

// Permanent deletion is deliberately separate from the legacy DELETE action, which now
// moves a map to the same recoverable tree trash as documents and folders.
app.delete("/:id/permanent", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const row = db.prepare("SELECT * FROM mindmaps WHERE id = ?").get(id) as MindmapRow | undefined;
  if (!row) return c.json({ error: "思维导图不存在" }, 404);
  if (!canManageResource(row.userId, row.workspaceId, userId)) {
    return c.json({ error: "无权删除此导图", code: "FORBIDDEN" }, 403);
  }
  const node = db.prepare(`
    SELECT isDeleted FROM knowledge_tree_nodes WHERE resourceType = 'mindmap' AND resourceId = ?
  `).get(id) as { isDeleted: number } | undefined;
  if (!node?.isDeleted) return c.json({ error: "请先将脑图移入回收站", code: "MINDMAP_NOT_TRASHED" }, 409);
  if (!resolveResourceKnowledgeAccessForTombstone("mindmap", id, userId, db).capabilities.canDelete) {
    return c.json({ error: "无权删除此导图", code: "FORBIDDEN" }, 403);
  }
  db.prepare("DELETE FROM mindmaps WHERE id = ?").run(id);
  return c.json({ success: true });
});

// ---------- ??/???? ----------
app.patch("/:id/star", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");

  const existing = readActiveMindmap(db, id);
  if (!existing) return c.json({ error: "思维导图不存在" }, 404);
  if (!canManageResource(existing.userId, existing.workspaceId, userId)) {
    return c.json({ error: "无权修改此导图", code: "FORBIDDEN" }, 403);
  }

  const newStarred = existing.starred ? 0 : 1;
  db.prepare("UPDATE mindmaps SET starred = ?, updatedAt = datetime('now') WHERE id = ?").run(newStarred, id);
  const row = db.prepare("SELECT * FROM mindmaps WHERE id = ?").get(id);
  return c.json(row);
});

// ---------- ???????? ----------
app.patch("/:id/move", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const body = await c.req.json<{ folderId: string | null }>();

  const existing = readActiveMindmap(db, id);
  if (!existing) return c.json({ error: "Mindmap not found" }, 404);
  if (!canManageResource(existing.userId, existing.workspaceId, userId)) {
    return c.json({ error: "???????", code: "FORBIDDEN" }, 403);
  }

  const folderId = body.folderId || null;
  if (folderId) {
    const folder = db.prepare("SELECT * FROM mindmap_folders WHERE id = ?").get(folderId) as any;
    if (!folder) return c.json({ error: "??????" }, 404);
  }

  db.prepare("UPDATE mindmaps SET folderId = ?, updatedAt = datetime('now') WHERE id = ?").run(folderId, id);
  const row = db.prepare("SELECT * FROM mindmaps WHERE id = ?").get(id);
  return c.json(row);
});

export default app;
