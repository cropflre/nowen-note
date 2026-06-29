import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { getDb } from "../db/schema";
import { v4 as uuid } from "uuid";
import {
  getUserWorkspaceRole,
  hasRole,
  resolveNotebookPermission,
  hasPermission,
  buildVisibilityWhere,
} from "../middleware/acl";
import { notebookRoleToPermission } from "../services/notebook-permissions";
import { broadcastNoteDeleted } from "../services/realtime";
import { notebookShareLinksRepository, notebookMembersRepository } from "../repositories";

const app = new Hono();

function parseNotebookMemberRole(role: unknown): "editor" | "viewer" | null {
  return role === "editor" || role === "viewer" ? role : null;
}

function notebookMemberId(notebookId: string, userId: string) {
  return `${notebookId}:${userId}`;
}

function generateShareToken() {
  return randomBytes(24).toString("base64url");
}

/**
 * 获取所有笔记本（树形结构）
 * 支持可选 workspaceId 查询参数：
 *   未传 → 返回个人空间 + 所有加入的工作区笔记本（用于旧客户端兼容）
 *   传 'personal' → 仅个人空间
 *   传 <workspaceId> → 指定工作区
 */
app.get("/", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const workspaceId = c.req.query("workspaceId");

  let rows: any[];

  // noteCount 采用「递归口径」：每个笔记本的徽标数 = 自身直属笔记 + 所有子孙笔记本下的笔记
  // 通过递归 CTE 建立 ancestor → descendant 映射，再 JOIN notes 计数
  //
  // 软删除过滤（v14 起）：
  //   - 主 WHERE 加 nb.isDeleted = 0：软删的笔记本不再出现在侧边栏；
  //   - 递归 CTE 内的 notebooks 也加 isDeleted = 0：避免子孙笔记本被父级软删
  //     后从 nb_tree 里漏掉父子链；
  //   - notes 计数已经过滤了 isTrashed=0，配合上面的笔记本过滤后，软删笔记本
  //     里被一并 isTrashed=1 的笔记不会再贡献徽标计数。
  if (workspaceId === "personal") {
    rows = db
      .prepare(
        `
        WITH RECURSIVE nb_tree(ancestorId, descendantId) AS (
          SELECT id, id FROM notebooks
          WHERE userId = ? AND workspaceId IS NULL AND isDeleted = 0
          UNION ALL
          SELECT t.ancestorId, n.id
          FROM nb_tree t
          INNER JOIN notebooks n ON n.parentId = t.descendantId
          WHERE n.userId = ? AND n.workspaceId IS NULL AND n.isDeleted = 0
        )
        SELECT nb.*, COALESCE(nc.noteCount, 0) AS noteCount
        FROM notebooks nb
        LEFT JOIN (
          SELECT t.ancestorId AS notebookId, COUNT(notes.id) AS noteCount
          FROM nb_tree t
          INNER JOIN notes ON notes.notebookId = t.descendantId
          WHERE notes.userId = ? AND notes.isTrashed = 0 AND notes.workspaceId IS NULL
          GROUP BY t.ancestorId
        ) nc ON nb.id = nc.notebookId
        WHERE nb.userId = ? AND nb.workspaceId IS NULL AND nb.isDeleted = 0
        ORDER BY nb.sortOrder ASC
      `,
      )
      .all(userId, userId, userId, userId);
  } else if (workspaceId) {
    // 指定工作区：校验成员身份
    const role = getUserWorkspaceRole(workspaceId, userId);
    if (!role) return c.json({ error: "无权访问该工作区" }, 403);

    rows = db
      .prepare(
        `
        WITH RECURSIVE nb_tree(ancestorId, descendantId) AS (
          SELECT id, id FROM notebooks WHERE workspaceId = ? AND isDeleted = 0
          UNION ALL
          SELECT t.ancestorId, n.id
          FROM nb_tree t
          INNER JOIN notebooks n ON n.parentId = t.descendantId
          WHERE n.workspaceId = ? AND n.isDeleted = 0
        )
        SELECT nb.*, COALESCE(nc.noteCount, 0) AS noteCount
        FROM notebooks nb
        LEFT JOIN (
          SELECT t.ancestorId AS notebookId, COUNT(notes.id) AS noteCount
          FROM nb_tree t
          INNER JOIN notes ON notes.notebookId = t.descendantId
          WHERE notes.isTrashed = 0 AND notes.workspaceId = ?
          GROUP BY t.ancestorId
        ) nc ON nb.id = nc.notebookId
        WHERE nb.workspaceId = ? AND nb.isDeleted = 0
        ORDER BY nb.sortOrder ASC
      `,
      )
      .all(workspaceId, workspaceId, workspaceId, workspaceId);
  } else {
    // 兼容模式：个人空间
    rows = db
      .prepare(
        `
        WITH RECURSIVE nb_tree(ancestorId, descendantId) AS (
          SELECT id, id FROM notebooks
          WHERE userId = ? AND workspaceId IS NULL AND isDeleted = 0
          UNION ALL
          SELECT t.ancestorId, n.id
          FROM nb_tree t
          INNER JOIN notebooks n ON n.parentId = t.descendantId
          WHERE n.userId = ? AND n.workspaceId IS NULL AND n.isDeleted = 0
        )
        SELECT nb.*, COALESCE(nc.noteCount, 0) AS noteCount
        FROM notebooks nb
        LEFT JOIN (
          SELECT t.ancestorId AS notebookId, COUNT(notes.id) AS noteCount
          FROM nb_tree t
          INNER JOIN notes ON notes.notebookId = t.descendantId
          WHERE notes.userId = ? AND notes.isTrashed = 0 AND notes.workspaceId IS NULL
          GROUP BY t.ancestorId
        ) nc ON nb.id = nc.notebookId
        WHERE nb.userId = ? AND nb.workspaceId IS NULL AND nb.isDeleted = 0
        ORDER BY nb.sortOrder ASC
      `,
      )
      .all(userId, userId, userId, userId);
  }

  return c.json(rows);
});

// User-facing collaboration entry: notebooks shared with the current user.
app.get("/shared-with-me", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";

  const rows = db
    .prepare(
      `
      WITH shared AS (
        SELECT nb.id
        FROM notebook_members nm
        JOIN notebooks nb ON nb.id = nm.notebookId
        WHERE nm.userId = ?
          AND nm.status = 'active'
          AND nb.userId <> ?
          AND nb.isDeleted = 0
      ),
      nb_tree(ancestorId, descendantId) AS (
        SELECT id, id FROM notebooks
        WHERE id IN (SELECT id FROM shared) AND isDeleted = 0
        UNION ALL
        SELECT t.ancestorId, n.id
        FROM nb_tree t
        JOIN notebooks n ON n.parentId = t.descendantId
        WHERE n.isDeleted = 0
      )
      SELECT nb.*, COALESCE(nc.noteCount, 0) AS noteCount, nm.role AS myRole
      FROM notebooks nb
      JOIN notebook_members nm
        ON nm.notebookId = nb.id AND nm.userId = ? AND nm.status = 'active'
      LEFT JOIN (
        SELECT t.ancestorId AS notebookId, COUNT(notes.id) AS noteCount
        FROM nb_tree t
        JOIN notes ON notes.notebookId = t.descendantId
        WHERE notes.isTrashed = 0
        GROUP BY t.ancestorId
      ) nc ON nb.id = nc.notebookId
      WHERE nb.id IN (SELECT id FROM shared)
      ORDER BY nb.updatedAt DESC, nb.id ASC
    `,
    )
    .all(userId, userId, userId) as any[];

  return c.json(
    rows.map((row) => ({
      ...row,
      permission: notebookRoleToPermission(row.myRole),
    })),
  );
});

app.get("/share/:token", (c) => {
  const token = c.req.param("token");
  const link = notebookShareLinksRepository.getByTokenWithDetails(token);
  if (!link) return c.json({ error: "share link not found" }, 404);
  return c.json(link);
});

app.post("/share/:token/join", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const token = c.req.param("token");

  const link = notebookShareLinksRepository.getEnabledByToken(token);
  if (!link) return c.json({ error: "share link not found" }, 404);
  if (link.ownerId === userId) {
    return c.json({ success: true, notebookId: link.notebookId, role: "owner" });
  }

  const role = parseNotebookMemberRole(link.role) || "viewer";
  notebookMembersRepository.upsert({
    id: notebookMemberId(link.notebookId, userId),
    notebookId: link.notebookId,
    userId,
    role,
    invitedBy: link.createdBy,
  });

  return c.json({ success: true, notebookId: link.notebookId, role });
});

app.get("/:id/share-link", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");

  const { permission } = resolveNotebookPermission(id, userId);
  if (!hasPermission(permission, "manage")) {
    return c.json({ error: "forbidden" }, 403);
  }

  const link = notebookShareLinksRepository.getLatestEnabledByNotebook(id);
  return c.json(link || null);
});

app.post("/:id/share-link", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const role = parseNotebookMemberRole(body.role) || "viewer";
  const expiresAt = typeof body.expiresAt === "string" && body.expiresAt.trim()
    ? body.expiresAt.trim()
    : null;

  const { permission } = resolveNotebookPermission(id, userId);
  if (!hasPermission(permission, "manage")) {
    return c.json({ error: "forbidden" }, 403);
  }

  notebookShareLinksRepository.disableAllByNotebook(id);

  const linkId = uuid();
  const token = generateShareToken();
  notebookShareLinksRepository.create({
    id: linkId,
    notebookId: id,
    token,
    role,
    expiresAt,
    createdBy: userId,
  });

  const link = notebookShareLinksRepository.getById(linkId);
  return c.json(link, 201);
});

app.patch("/:id/share-link", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const body = await c.req.json();

  const { permission } = resolveNotebookPermission(id, userId);
  if (!hasPermission(permission, "manage")) {
    return c.json({ error: "forbidden" }, 403);
  }

  const link = notebookShareLinksRepository.getLatestEnabledByNotebook(id);
  if (!link) return c.json({ error: "share link not found" }, 404);

  const updates: any = {};
  if (body.role !== undefined) {
    const role = parseNotebookMemberRole(body.role);
    if (!role) return c.json({ error: "role must be editor or viewer" }, 400);
    updates.role = role;
  }
  if (body.expiresAt !== undefined) {
    updates.expiresAt = body.expiresAt ? String(body.expiresAt) : null;
  }
  if (body.enabled !== undefined) {
    updates.enabled = body.enabled ? 1 : 0;
  }
  if (Object.keys(updates).length === 0) return c.json({ error: "no changes" }, 400);

  notebookShareLinksRepository.update(link.id, updates);
  const updated = notebookShareLinksRepository.getById(link.id);
  return c.json(updated);
});

app.delete("/:id/share-link", (c) => {
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");

  const { permission } = resolveNotebookPermission(id, userId);
  if (!hasPermission(permission, "manage")) {
    return c.json({ error: "forbidden" }, 403);
  }

  notebookShareLinksRepository.disableAllByNotebook(id);

  return c.json({ success: true });
});

app.get("/:id/members", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");

  const { permission } = resolveNotebookPermission(id, userId);
  if (!hasPermission(permission, "manage")) {
    return c.json({ error: "forbidden" }, 403);
  }

  const members = notebookMembersRepository.listByNotebook(id);

  return c.json(members);
});

app.post("/:id/members", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const body = await c.req.json();
  const targetUserId = String(body.userId || "").trim();
  const role = parseNotebookMemberRole(body.role);

  const { permission } = resolveNotebookPermission(id, userId);
  if (!hasPermission(permission, "manage")) {
    return c.json({ error: "forbidden" }, 403);
  }
  if (!targetUserId || !role) {
    return c.json({ error: "userId and role are required" }, 400);
  }

  const target = db
    .prepare("SELECT id FROM users WHERE id = ? AND isDisabled = 0")
    .get(targetUserId) as { id: string } | undefined;
  if (!target) return c.json({ error: "user not found" }, 404);

  notebookMembersRepository.upsert({
    id: notebookMemberId(id, targetUserId),
    notebookId: id,
    userId: targetUserId,
    role,
    invitedBy: userId,
  });

  const member = notebookMembersRepository.getByNotebookAndUser(id, targetUserId);
  return c.json(member, 201);
});

app.patch("/:id/members/:memberUserId", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const memberUserId = c.req.param("memberUserId");
  const body = await c.req.json();
  const role = parseNotebookMemberRole(body.role);

  const { permission } = resolveNotebookPermission(id, userId);
  if (!hasPermission(permission, "manage")) {
    return c.json({ error: "forbidden" }, 403);
  }
  if (!role) return c.json({ error: "role must be editor or viewer" }, 400);

  const member = notebookMembersRepository.getRole(id, memberUserId);
  if (!member) return c.json({ error: "member not found" }, 404);
  if (member.role === "owner") {
    return c.json({ error: "owner role cannot be changed here" }, 400);
  }

  notebookMembersRepository.updateRole(id, memberUserId, role);

  return c.json({ success: true });
});

app.delete("/:id/members/:memberUserId", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const memberUserId = c.req.param("memberUserId");

  const { permission } = resolveNotebookPermission(id, userId);
  if (!hasPermission(permission, "manage")) {
    return c.json({ error: "forbidden" }, 403);
  }

  const member = notebookMembersRepository.getRole(id, memberUserId);
  if (!member) return c.json({ error: "member not found" }, 404);
  if (member.role === "owner") {
    return c.json({ error: "owner cannot be removed here" }, 400);
  }

  notebookMembersRepository.remove(id, memberUserId);

  return c.json({ success: true });
});

// 创建笔记本
app.post("/", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const body = await c.req.json();
  const workspaceId: string | null = body.workspaceId || null;

  // 如果指定了工作区，必须是 editor 以上角色
  if (workspaceId) {
    const role = getUserWorkspaceRole(workspaceId, userId);
    if (!hasRole(role, "editor")) {
      return c.json({ error: "您在该工作区无创建权限" }, 403);
    }
  }

  // v14：父笔记本若已被软删（在回收站里），不允许在其下创建子笔记本——
  // 否则新建的子笔记本会立刻 "看不见"（被父级 isDeleted 过滤掉）。
  if (body.parentId) {
    const parent = db
      .prepare("SELECT isDeleted FROM notebooks WHERE id = ?")
      .get(body.parentId) as { isDeleted: number } | undefined;
    if (!parent) return c.json({ error: "父笔记本不存在" }, 404);
    if (parent.isDeleted === 1) {
      return c.json(
        { error: "父笔记本已删除，无法在其下创建", code: "PARENT_NOTEBOOK_TRASHED" },
        400,
      );
    }
  }

  const id = uuid();
  db.prepare(
    `INSERT INTO notebooks (id, userId, workspaceId, parentId, name, icon, color, sortOrder)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    userId,
    workspaceId,
    body.parentId || null,
    body.name,
    body.icon || "📒",
    body.color || null,
    body.sortOrder || 0,
  );
  const notebook = db.prepare("SELECT * FROM notebooks WHERE id = ?").get(id);
  return c.json(notebook, 201);
});

// 移动笔记本
app.put("/:id/move", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const body = await c.req.json();

  const newParentId: string | null | undefined = body.parentId;
  const newSortOrder: number | undefined =
    typeof body.sortOrder === "number" ? body.sortOrder : undefined;

  const { permission, workspaceId } = resolveNotebookPermission(id, userId);
  if (!hasPermission(permission, "write")) {
    return c.json({ error: "forbidden" }, 403);
  }

  // v14：禁止操作已软删（在回收站）的笔记本——视同不存在
  const cur = db
    .prepare("SELECT isDeleted FROM notebooks WHERE id = ?")
    .get(id) as { isDeleted: number } | undefined;
  if (!cur || cur.isDeleted === 1) {
    return c.json({ error: "notebook not found" }, 404);
  }

  if (newParentId !== undefined && newParentId !== null) {
    if (newParentId === id) {
      return c.json({ error: "cannot move notebook into itself" }, 400);
    }
    const parent = db
      .prepare(
        "SELECT id, userId, workspaceId FROM notebooks WHERE id = ? AND isDeleted = 0",
      )
      .get(newParentId) as { id: string; userId: string; workspaceId: string | null } | undefined;
    if (!parent) return c.json({ error: "target parent not found" }, 404);

    // 父笔记本必须和当前笔记本同属一个空间
    if ((parent.workspaceId || null) !== (workspaceId || null)) {
      return c.json({ error: "cannot move notebook across workspaces" }, 400);
    }
    const parentPerm = resolveNotebookPermission(newParentId, userId);
    if (!hasPermission(parentPerm.permission, "write")) {
      return c.json({ error: "forbidden" }, 403);
    }

    // 循环引用防护
    let cursor: string | null = newParentId;
    const visited = new Set<string>();
    while (cursor) {
      if (visited.has(cursor)) break;
      visited.add(cursor);
      if (cursor === id) {
        return c.json({ error: "cannot move notebook into its own descendant" }, 400);
      }
      const row = db.prepare("SELECT parentId FROM notebooks WHERE id = ?").get(cursor) as
        | { parentId: string | null }
        | undefined;
      cursor = row?.parentId ?? null;
    }
  }

  const sets: string[] = [];
  const args: any[] = [];
  if (newParentId !== undefined) {
    sets.push("parentId = ?");
    args.push(newParentId);
  }
  if (newSortOrder !== undefined) {
    sets.push("sortOrder = ?");
    args.push(newSortOrder);
  }
  sets.push("updatedAt = datetime('now')");
  args.push(id);

  db.prepare(`UPDATE notebooks SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  const notebook = db.prepare("SELECT * FROM notebooks WHERE id = ?").get(id);
  return c.json(notebook);
});

// 批量更新笔记本排序
app.put("/reorder/batch", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const body = await c.req.json();
  const items: { id: string; sortOrder: number }[] = body.items;
  if (!Array.isArray(items)) return c.json({ error: "items is required" }, 400);

  // 逐条校验权限
  const stmt = db.prepare("UPDATE notebooks SET sortOrder = ? WHERE id = ?");
  const updateMany = db.transaction((list: { id: string; sortOrder: number }[]) => {
    for (const item of list) {
      const { permission } = resolveNotebookPermission(item.id, userId);
      if (hasPermission(permission, "write")) {
        stmt.run(item.sortOrder, item.id);
      }
    }
  });
  updateMany(items);
  return c.json({ success: true });
});

// 更新笔记本
app.put("/:id", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const body = await c.req.json();

  const { permission } = resolveNotebookPermission(id, userId);
  if (!hasPermission(permission, "write")) {
    return c.json({ error: "forbidden" }, 403);
  }

  // v14：已软删的笔记本视同不存在，禁止重命名 / 改图标 / 改父级
  const cur = db
    .prepare("SELECT isDeleted FROM notebooks WHERE id = ?")
    .get(id) as { isDeleted: number } | undefined;
  if (!cur || cur.isDeleted === 1) {
    return c.json({ error: "notebook not found" }, 404);
  }

  db.prepare(
    `
    UPDATE notebooks SET name = COALESCE(?, name), icon = COALESCE(?, icon),
    color = COALESCE(?, color), parentId = COALESCE(?, parentId),
    sortOrder = COALESCE(?, sortOrder), isExpanded = COALESCE(?, isExpanded),
    updatedAt = datetime('now')
    WHERE id = ?
  `,
  ).run(
    body.name,
    body.icon,
    body.color,
    body.parentId,
    body.sortOrder,
    body.isExpanded,
    id,
  );
  const notebook = db.prepare("SELECT * FROM notebooks WHERE id = ?").get(id);
  return c.json(notebook);
});

// 删除笔记本
//
// v14 起改为「软删除 + 笔记进回收站」语义：
//   - 不再 DELETE FROM notebooks（避免 ON DELETE CASCADE 把笔记直接物理删除，
//     导致回收站里看不到这些笔记）；
//   - 当前笔记本及其全部子孙笔记本一并 isDeleted=1，从侧边栏消失；
//   - 这些笔记本下的所有 notes 标记 isTrashed=1，进入回收站，等用户从回收站
//     永久删除时再走 reclaimSpace。
//
// 注：
//   - attachments 物理文件、Y.Doc 内存房间不在此处清理——笔记还在回收站，
//     用户可能恢复，过早删文件会让恢复出来的笔记图片裂掉。统一推迟到
//     /notes/trash/empty 与 /notes/:id（永久删除）路径处理。
//   - 因为没有真删任何行，也不需要 reclaimSpace；磁盘体量在用户清空回收站
//     时才发生显著变化，行为符合直觉。
app.delete("/:id", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");

  const { permission } = resolveNotebookPermission(id, userId);
  if (!hasPermission(permission, "manage")) {
    return c.json({ error: "forbidden" }, 403);
  }

  // 已经是软删态：幂等返回成功，避免重复点击导致 trashedAt 抖动。
  const cur = db
    .prepare("SELECT isDeleted FROM notebooks WHERE id = ?")
    .get(id) as { isDeleted: number } | undefined;
  if (!cur) return c.json({ error: "notebook not found" }, 404);
  if (cur.isDeleted === 1) {
    return c.json({ success: true, removedNoteCount: 0, alreadyDeleted: true });
  }

  // 递归收集当前笔记本 + 所有子孙笔记本 id（限定 isDeleted=0，避免把之前已软删
  // 的某个分支再次 "重新软删" 把 trashedAt 覆盖掉）。
  let nbIds: string[] = [];
  try {
    nbIds = (db
      .prepare(
        `WITH RECURSIVE sub(id) AS (
           SELECT id FROM notebooks WHERE id = ? AND isDeleted = 0
           UNION ALL
           SELECT n.id FROM notebooks n JOIN sub ON n.parentId = sub.id
           WHERE n.isDeleted = 0
         )
         SELECT id FROM sub`,
      )
      .all(id) as { id: string }[]).map((r) => r.id);
  } catch (e) {
    console.warn(
      "[notebooks.delete] collect descendant notebookIds failed:",
      (e as Error).message,
    );
  }
  if (nbIds.length === 0) nbIds = [id]; // 兜底

  // 收集所有受影响的笔记 id（仅未在回收站的；已经 isTrashed=1 的不动 trashedAt）
  let trashedNoteIds: string[] = [];
  try {
    const placeholders = nbIds.map(() => "?").join(",");
    trashedNoteIds = (db
      .prepare(
        `SELECT id FROM notes
          WHERE notebookId IN (${placeholders}) AND isTrashed = 0`,
      )
      .all(...nbIds) as { id: string }[]).map((r) => r.id);
  } catch (e) {
    console.warn(
      "[notebooks.delete] collect noteIds failed:",
      (e as Error).message,
    );
  }

  // 一个事务内：标记笔记本 isDeleted=1 + 把直属未回收的笔记移入回收站
  const placeholders = nbIds.map(() => "?").join(",");
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE notebooks
          SET isDeleted = 1,
              deletedAt = datetime('now'),
              updatedAt = datetime('now')
        WHERE id IN (${placeholders}) AND isDeleted = 0`,
    ).run(...nbIds);

    if (trashedNoteIds.length > 0) {
      const noteIn = trashedNoteIds.map(() => "?").join(",");
      db.prepare(
        `UPDATE notes
            SET isTrashed = 1,
                trashedAt = datetime('now'),
                updatedAt = datetime('now')
          WHERE id IN (${noteIn})`,
      ).run(...trashedNoteIds);
    }
  });

  try {
    tx();
  } catch (e) {
    console.error("[notebooks.delete] soft-delete tx failed:", (e as Error).message);
    return c.json({ error: "删除失败" }, 500);
  }

  // SYNC-DELETE-01-B-R: 删除笔记本时，其下笔记被标为 isTrashed=1，
  // 需要广播 note:deleted(trashed=true) 让其它客户端实时从列表移除
  for (const noteId of trashedNoteIds) {
    try { broadcastNoteDeleted(noteId, { actorUserId: userId, trashed: true }); } catch {}
  }

  return c.json({
    success: true,
    softDeletedNotebookCount: nbIds.length,
    trashedNoteCount: trashedNoteIds.length,
  });
});

export default app;
// 保留给其他模块使用
export { buildVisibilityWhere };
