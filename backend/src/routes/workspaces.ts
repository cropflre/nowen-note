/**
 * 工作区路由（Phase 1 - 多用户协作）
 *
 * 端点：
 *   GET    /api/workspaces                - 当前用户可访问的所有工作区
 *   POST   /api/workspaces                - 创建工作区
 *   GET    /api/workspaces/:id            - 查看工作区详情
 *   PUT    /api/workspaces/:id            - 更新工作区（仅 owner/admin）
 *   DELETE /api/workspaces/:id            - 删除工作区（仅 owner）
 *
 *   GET    /api/workspaces/:id/members    - 成员列表
 *   PUT    /api/workspaces/:id/members/:userId  - 修改成员角色（仅 owner/admin）
 *   DELETE /api/workspaces/:id/members/:userId  - 移除成员（仅 owner/admin）
 *   POST   /api/workspaces/:id/leave      - 主动退出工作区
 *
 *   POST   /api/workspaces/:id/invites    - 生成邀请码（仅 owner/admin）
 *   GET    /api/workspaces/:id/invites    - 查看邀请码列表
 *   DELETE /api/workspaces/:id/invites/:inviteId - 撤销邀请码
 *   POST   /api/workspaces/join           - 使用邀请码加入
 */
import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/schema";
import {
  getUserWorkspaceRole,
  requireWorkspaceRole,
  WorkspaceRole,
} from "../middleware/acl";

const app = new Hono();

function generateInviteCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 10; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// ===================== 工作区 CRUD =====================

// 获取当前用户的所有工作区（包括自己拥有的 + 受邀加入的）
app.get("/", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";

  const rows = db
    .prepare(
      `
      SELECT w.*, m.role,
             (SELECT COUNT(*) FROM workspace_members WHERE workspaceId = w.id) AS memberCount,
             (SELECT COUNT(*) FROM notebooks WHERE workspaceId = w.id) AS notebookCount
      FROM workspaces w
      JOIN workspace_members m ON m.workspaceId = w.id
      WHERE m.userId = ?
      ORDER BY w.createdAt ASC
    `,
    )
    .all(userId);

  return c.json(rows);
});

// 创建工作区
app.post("/", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const body = await c.req.json();
  const { name, description, icon } = body as {
    name: string;
    description?: string;
    icon?: string;
  };

  if (!name || !name.trim()) return c.json({ error: "工作区名称不能为空" }, 400);

  const id = uuid();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO workspaces (id, name, description, icon, ownerId) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, name.trim(), description || "", icon || "🏢", userId);
    db.prepare(
      `INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, 'owner')`,
    ).run(id, userId);
  });
  tx();

  const workspace = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id);
  return c.json({ ...(workspace as any), role: "owner", memberCount: 1, notebookCount: 0 }, 201);
});

// 查看工作区详情
app.get("/:id", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");

  const role = getUserWorkspaceRole(id, userId);
  if (!role) return c.json({ error: "无权访问该工作区" }, 403);

  const ws = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id);
  if (!ws) return c.json({ error: "工作区不存在" }, 404);

  const memberCount = (
    db.prepare("SELECT COUNT(*) as c FROM workspace_members WHERE workspaceId = ?").get(id) as {
      c: number;
    }
  ).c;
  const notebookCount = (
    db.prepare("SELECT COUNT(*) as c FROM notebooks WHERE workspaceId = ?").get(id) as {
      c: number;
    }
  ).c;

  return c.json({ ...(ws as any), role, memberCount, notebookCount });
});

// 更新工作区（仅 owner/admin）
app.put("/:id", requireWorkspaceRole("admin"), async (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const body = await c.req.json();

  const fields: string[] = [];
  const params: any[] = [];
  if (body.name !== undefined) {
    fields.push("name = ?");
    params.push(body.name);
  }
  if (body.description !== undefined) {
    fields.push("description = ?");
    params.push(body.description);
  }
  if (body.icon !== undefined) {
    fields.push("icon = ?");
    params.push(body.icon);
  }
  if (fields.length === 0) return c.json({ error: "无可更新字段" }, 400);

  fields.push("updatedAt = datetime('now')");
  params.push(id);

  db.prepare(`UPDATE workspaces SET ${fields.join(", ")} WHERE id = ?`).run(...params);
  const ws = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id);
  return c.json(ws);
});

// 删除工作区（仅 owner）
app.delete("/:id", requireWorkspaceRole("owner"), (c) => {
  const db = getDb();
  const id = c.req.param("id");
  // CASCADE 会连带删除 workspace_members / workspace_invites
  // 但 notebooks 和 notes 的 workspaceId 会悬空 → 需要清理：回退到所有者的个人空间
  const ws = db.prepare("SELECT ownerId FROM workspaces WHERE id = ?").get(id) as
    | { ownerId: string }
    | undefined;
  if (!ws) return c.json({ error: "工作区不存在" }, 404);

  const tx = db.transaction(() => {
    // 把所有工作区笔记本和笔记归属权转给 owner 的个人空间
    db.prepare(
      "UPDATE notebooks SET workspaceId = NULL, userId = ? WHERE workspaceId = ?",
    ).run(ws.ownerId, id);
    db.prepare(
      "UPDATE notes SET workspaceId = NULL, userId = ? WHERE workspaceId = ?",
    ).run(ws.ownerId, id);
    db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
  });
  tx();

  return c.json({ success: true });
});

// ===================== 成员管理 =====================

app.get("/:id/members", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");

  const role = getUserWorkspaceRole(id, userId);
  if (!role) return c.json({ error: "无权访问该工作区" }, 403);

  const members = db
    .prepare(
      `
      SELECT m.workspaceId, m.userId, m.role, m.joinedAt,
             u.username, u.email, u.avatarUrl
      FROM workspace_members m
      JOIN users u ON u.id = m.userId
      WHERE m.workspaceId = ?
      ORDER BY
        CASE m.role
          WHEN 'owner' THEN 1
          WHEN 'admin' THEN 2
          WHEN 'editor' THEN 3
          WHEN 'commenter' THEN 4
          WHEN 'viewer' THEN 5
        END ASC,
        m.joinedAt ASC
    `,
    )
    .all(id);

  return c.json(members);
});

// 修改成员角色（仅 owner/admin）
app.put("/:id/members/:userId", requireWorkspaceRole("admin"), async (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const targetUserId = c.req.param("userId");
  const body = await c.req.json();
  const { role } = body as { role: WorkspaceRole };

  const validRoles: WorkspaceRole[] = ["admin", "editor", "commenter", "viewer"];
  if (!validRoles.includes(role)) {
    return c.json({ error: "无效的角色" }, 400);
  }

  // 不能修改 owner 的角色
  const target = db
    .prepare("SELECT role FROM workspace_members WHERE workspaceId = ? AND userId = ?")
    .get(id, targetUserId) as { role: WorkspaceRole } | undefined;
  if (!target) return c.json({ error: "成员不存在" }, 404);
  if (target.role === "owner") {
    return c.json({ error: "不能修改 owner 的角色" }, 400);
  }

  db.prepare(
    "UPDATE workspace_members SET role = ? WHERE workspaceId = ? AND userId = ?",
  ).run(role, id, targetUserId);

  return c.json({ success: true });
});

// 移除成员（仅 owner/admin）
app.delete("/:id/members/:userId", requireWorkspaceRole("admin"), (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const targetUserId = c.req.param("userId");

  const target = db
    .prepare("SELECT role FROM workspace_members WHERE workspaceId = ? AND userId = ?")
    .get(id, targetUserId) as { role: WorkspaceRole } | undefined;
  if (!target) return c.json({ error: "成员不存在" }, 404);
  if (target.role === "owner") {
    return c.json({ error: "不能移除 owner" }, 400);
  }

  db.prepare("DELETE FROM workspace_members WHERE workspaceId = ? AND userId = ?").run(
    id,
    targetUserId,
  );
  // 同步清理 note_acl
  db.prepare(
    "DELETE FROM note_acl WHERE userId = ? AND noteId IN (SELECT id FROM notes WHERE workspaceId = ?)",
  ).run(targetUserId, id);

  return c.json({ success: true });
});

// 主动退出
app.post("/:id/leave", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");

  const row = db
    .prepare("SELECT role FROM workspace_members WHERE workspaceId = ? AND userId = ?")
    .get(id, userId) as { role: WorkspaceRole } | undefined;
  if (!row) return c.json({ error: "您不是该工作区成员" }, 404);
  if (row.role === "owner") {
    return c.json({ error: "owner 不能退出工作区，请先转让或删除工作区" }, 400);
  }

  db.prepare("DELETE FROM workspace_members WHERE workspaceId = ? AND userId = ?").run(
    id,
    userId,
  );
  return c.json({ success: true });
});

// ===================== 邀请码 =====================

app.post("/:id/invites", requireWorkspaceRole("admin"), async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const body = await c.req.json();
  const { role, maxUses, expiresAt } = body as {
    role?: WorkspaceRole;
    maxUses?: number;
    expiresAt?: string;
  };

  const validRoles: WorkspaceRole[] = ["admin", "editor", "commenter", "viewer"];
  const inviteRole = role && validRoles.includes(role) ? role : "editor";

  const inviteId = uuid();
  const code = generateInviteCode();

  db.prepare(
    `INSERT INTO workspace_invites (id, workspaceId, code, role, maxUses, expiresAt, createdBy)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(inviteId, id, code, inviteRole, maxUses ?? 10, expiresAt || null, userId);

  const invite = db.prepare("SELECT * FROM workspace_invites WHERE id = ?").get(inviteId);
  return c.json(invite, 201);
});

app.get("/:id/invites", requireWorkspaceRole("admin"), (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const invites = db
    .prepare("SELECT * FROM workspace_invites WHERE workspaceId = ? ORDER BY createdAt DESC")
    .all(id);
  return c.json(invites);
});

app.delete("/:id/invites/:inviteId", requireWorkspaceRole("admin"), (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const inviteId = c.req.param("inviteId");
  db.prepare("DELETE FROM workspace_invites WHERE id = ? AND workspaceId = ?").run(inviteId, id);
  return c.json({ success: true });
});

// 使用邀请码加入（独立端点，不需要 workspaceId 参数）
app.post("/join", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const body = await c.req.json();
  const { code } = body as { code: string };

  if (!code || !code.trim()) return c.json({ error: "邀请码不能为空" }, 400);

  const invite = db
    .prepare("SELECT * FROM workspace_invites WHERE code = ?")
    .get(code.trim()) as
    | {
        id: string;
        workspaceId: string;
        role: WorkspaceRole;
        maxUses: number;
        useCount: number;
        expiresAt: string | null;
      }
    | undefined;

  if (!invite) return c.json({ error: "邀请码无效" }, 404);

  if (invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now()) {
    return c.json({ error: "邀请码已过期" }, 400);
  }
  if (invite.maxUses && invite.useCount >= invite.maxUses) {
    return c.json({ error: "邀请码使用次数已用尽" }, 400);
  }

  // 检查是否已是成员
  const existing = db
    .prepare("SELECT role FROM workspace_members WHERE workspaceId = ? AND userId = ?")
    .get(invite.workspaceId, userId);
  if (existing) {
    return c.json({
      success: true,
      workspaceId: invite.workspaceId,
      alreadyMember: true,
    });
  }

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)`,
    ).run(invite.workspaceId, userId, invite.role);
    db.prepare("UPDATE workspace_invites SET useCount = useCount + 1 WHERE id = ?").run(invite.id);
  });
  tx();

  const ws = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(invite.workspaceId);
  return c.json({ success: true, workspace: ws, role: invite.role });
});

export default app;
