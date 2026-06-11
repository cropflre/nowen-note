import { Hono } from "hono";
import type { Context } from "hono";
import { getDb } from "../db/schema";
import crypto from "crypto";
import {
  getUserWorkspaceRole,
  canManageResource,
  requireWorkspaceFeature,
} from "../middleware/acl";

const tasks = new Hono();

// ---------------------------------------------------------------------------
// Phase 2/Y3: 工作区 scope 解析
// ---------------------------------------------------------------------------
// tasks 路由兼容两种作用域：
//   - 个人空间：`?workspaceId=` 未传 / 'personal' → tasks.workspaceId IS NULL
//   - 工作区：   `?workspaceId=<uuid>`            → tasks.workspaceId = <uuid>
//                                                  （需要成员身份 + tasks 功能开关未关闭）
//
// 与 diary.ts 同款语义：
//   - 列表/创建/统计等"集合"接口由 requireWorkspaceFeature("tasks") 中间件
//     校验功能开关；
//   - 按 id 的读/写/删走资源行自带的 workspaceId 做 ACL（canManageResource）
//     —— 为了让"创建者本人 / admin / owner 在工作区内可编辑/删除他人任务"
//     的语义自然成立。
function resolveTaskScope(
  c: Context,
  userId: string,
): { scope: "personal" | "workspace"; workspaceId: string | null; error?: string } {
  const raw = c.req.query("workspaceId");
  if (!raw || raw === "personal") {
    return { scope: "personal", workspaceId: null };
  }
  const role = getUserWorkspaceRole(raw, userId);
  if (!role) {
    return { scope: "workspace", workspaceId: raw, error: "无权访问该工作区" };
  }
  return { scope: "workspace", workspaceId: raw };
}

// 获取所有任务
tasks.get("/", requireWorkspaceFeature("tasks"), (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const filter = c.req.query("filter"); // all | today | week | overdue | completed
  const noteId = c.req.query("noteId");

  const scope = resolveTaskScope(c, userId);
  if (scope.error) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);

  // creatorName: LEFT JOIN users 取创建者用户名，便于工作区列表展示"谁建的"。
  // 仅扩列不改 WHERE/ORDER BY 结构——tasks.* 即历史契约，新加的 creatorName 是
  // optional 字段；LEFT JOIN 兜底用户被删除场景（虽然 ON DELETE CASCADE 会同步清掉
  // tasks，但 join 不依赖外键存在，更稳）。
  let sql: string;
  const params: any[] = [];
  if (scope.scope === "workspace") {
    sql = `SELECT tasks.*, users.username AS creatorName
           FROM tasks LEFT JOIN users ON users.id = tasks.userId
           WHERE workspaceId = ?`;
    params.push(scope.workspaceId);
  } else {
    sql = `SELECT tasks.*, users.username AS creatorName
           FROM tasks LEFT JOIN users ON users.id = tasks.userId
           WHERE tasks.userId = ? AND workspaceId IS NULL`;
    params.push(userId);
  }

  if (noteId) {
    sql += ` AND noteId = ?`;
    params.push(noteId);
  }

  if (filter === "today") {
    sql += ` AND dueDate IS NOT NULL AND date(dueDate) = date('now', 'localtime')`;
  } else if (filter === "week") {
    sql += ` AND dueDate IS NOT NULL AND date(dueDate) BETWEEN date('now', 'localtime') AND date('now', 'localtime', '+7 days')`;
  } else if (filter === "overdue") {
    sql += ` AND isCompleted = 0 AND dueDate IS NOT NULL AND date(dueDate) < date('now', 'localtime')`;
  } else if (filter === "completed") {
    sql += ` AND isCompleted = 1`;
  }

  sql += ` ORDER BY isCompleted ASC, priority DESC, sortOrder ASC, tasks.createdAt DESC`;

  const rows = db.prepare(sql).all(...params);
  return c.json(rows);
});

// 获取任务统计（必须在 /:id 之前注册）
tasks.get("/stats/summary", requireWorkspaceFeature("tasks"), (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;

  const scope = resolveTaskScope(c, userId);
  if (scope.error) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);

  // 单条 SQL 聚合所有统计，避免 5 次独立查询
  // Y3: 按 scope 聚合——工作区模式统计全员任务，个人模式按 userId + workspaceId IS NULL。
  const whereSql = scope.scope === "workspace"
    ? "workspaceId = ?"
    : "userId = ? AND workspaceId IS NULL";
  const whereArg = scope.scope === "workspace" ? scope.workspaceId : userId;

  const row = db.prepare(`
    SELECT
      COUNT(*)                                                                          AS total,
      SUM(CASE WHEN isCompleted = 1 THEN 1 ELSE 0 END)                                 AS completed,
      SUM(CASE WHEN isCompleted = 0 AND dueDate IS NOT NULL
               AND date(dueDate) = date('now', 'localtime') THEN 1 ELSE 0 END)         AS today,
      SUM(CASE WHEN isCompleted = 0 AND dueDate IS NOT NULL
               AND date(dueDate) < date('now', 'localtime') THEN 1 ELSE 0 END)         AS overdue,
      SUM(CASE WHEN isCompleted = 0 AND dueDate IS NOT NULL
               AND date(dueDate) BETWEEN date('now', 'localtime')
                                     AND date('now', 'localtime', '+7 days')
               THEN 1 ELSE 0 END)                                                      AS week
    FROM tasks
    WHERE ${whereSql}
  `).get(whereArg) as any;

  const total     = row.total     ?? 0;
  const completed = row.completed ?? 0;
  const today     = row.today     ?? 0;
  const overdue   = row.overdue   ?? 0;
  const week      = row.week      ?? 0;

  return c.json({ total, completed, pending: total - completed, today, overdue, week });
});

// ---------------------------------------------------------------------------
// 按 id 访问的工具：校验读/写权限
// ---------------------------------------------------------------------------
// 可读判定：工作区任务 → 成员即可读；个人任务 → 仅 owner 本人。
function canReadTask(
  task: { userId: string; workspaceId: string | null },
  actorId: string,
): boolean {
  if (!actorId) return false;
  if (task.workspaceId) {
    return getUserWorkspaceRole(task.workspaceId, actorId) !== null;
  }
  return task.userId === actorId;
}

// 获取单个任务（含子任务）
// Y3: 读权限按 scope——工作区内的任何成员可见，个人任务仅本人可见。
tasks.get("/:id", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const id = c.req.param("id");
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
    | { userId: string; workspaceId: string | null }
    | undefined;
  if (!task) return c.json({ error: "Task not found" }, 404);

  if (!canReadTask(task, userId)) {
    return c.json({ error: "Task not found" }, 404);
  }

  const children = db.prepare(
    "SELECT * FROM tasks WHERE parentId = ? ORDER BY sortOrder ASC, createdAt ASC"
  ).all(id);

  return c.json({ ...task, children });
});

// 创建任务
// Y3:
//   - query: workspaceId? 与其它路由一致
//   - body.parentId 指定时，自动从父任务继承 workspaceId（保证父子同域）；
//     若前端同时传了 query workspaceId 但与父任务不一致 → 400，避免跨域挂接。
//   - body.noteId 指定时，不强制对齐 noteId 的 workspaceId —— 现实中任务绑
//     定的笔记可能在个人空间而任务本身挂在工作区，反之亦然；由用户自己
//     掌握语义，后端不越权校验。
// 实现备注：这里故意用 async 而不是 `() => c.req.json().then(...)` 的链式返回。
// 旧写法下 TypeScript 会把 handler 的返回类型推断成
//   JSONRespondReturn<403> | Promise<void | JSONRespondReturn<201|400|403|404>>
// 这个 union 与 Hono 的 Handler<..., HandlerResponse<any>>（要求 Response | Promise<Response>，
// Promise 分支内部还必须是 void 才被视作 "无返回"）不兼容，tsc 会在 tasks.post("/", ...)
// 的这一行报 TS2769 "No overload matches this call"。统一 async/await 后，所有分支都
// 走同一条 Promise 路径，返回类型收敛为 Promise<Response>，类型校验即通过。
tasks.post("/", requireWorkspaceFeature("tasks"), async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;

  const scope = resolveTaskScope(c, userId);
  if (scope.error) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);

  const body: any = await c.req.json();
  const id = crypto.randomUUID();
  const { title, priority = 2, dueDate = null, noteId = null, parentId = null } = body;

  if (!title || !title.trim()) {
    return c.json({ error: "Title is required" }, 400);
  }

  // 父任务继承：子任务必须与父任务在同一 scope。
  let effectiveWorkspaceId: string | null = scope.workspaceId;
  if (parentId) {
    const parent = db
      .prepare("SELECT userId, workspaceId FROM tasks WHERE id = ?")
      .get(parentId) as { userId: string; workspaceId: string | null } | undefined;
    if (!parent) return c.json({ error: "父任务不存在" }, 404);
    if (!canReadTask(parent, userId)) {
      return c.json({ error: "无权在该父任务下创建子任务", code: "FORBIDDEN" }, 403);
    }
    if (effectiveWorkspaceId !== parent.workspaceId) {
      return c.json(
        { error: "子任务必须与父任务在同一工作区", code: "SCOPE_MISMATCH" },
        400,
      );
    }
    effectiveWorkspaceId = parent.workspaceId;
  }

  db.prepare(`
    INSERT INTO tasks (id, userId, workspaceId, title, isCompleted, priority, dueDate, noteId, parentId)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
  `).run(id, userId, effectiveWorkspaceId, title.trim(), priority, dueDate, noteId, parentId);

  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  return c.json(task, 201);
});

// 更新任务
// Y3: 走 canManageResource —— 创建者本人 + admin/owner 可改；个人任务仅本人。
//     不允许修改 workspaceId（搬移任务到其它工作区属于高风险操作，留待后续
//     独立"移动"接口实现）。
tasks.put("/:id", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const id = c.req.param("id");

  return c.req.json().then((body: any) => {
    const existing = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
    if (!existing) return c.json({ error: "Task not found" }, 404);

    if (!canManageResource(existing.userId, existing.workspaceId, userId)) {
      return c.json({ error: "无权修改该任务", code: "FORBIDDEN" }, 403);
    }

    const title = body.title ?? existing.title;
    const isCompleted = body.isCompleted ?? existing.isCompleted;
    const priority = body.priority ?? existing.priority;
    const dueDate = body.dueDate !== undefined ? body.dueDate : existing.dueDate;
    const noteId = body.noteId !== undefined ? body.noteId : existing.noteId;
    const parentId = body.parentId !== undefined ? body.parentId : existing.parentId;
    const sortOrder = body.sortOrder ?? existing.sortOrder;

    // 重新挂接父任务时再次校验同域约束

    // 禁止 parentId 指向自己
    if (parentId === id) {
      return c.json({ error: "不能将任务设为自己的子任务", code: "INVALID_PARENT_TASK" }, 400);
    }

    // 禁止移动到自己的子孙节点下面（防止循环引用）
    if (body.parentId !== undefined && body.parentId !== null && body.parentId !== existing.parentId) {
      const isDescendant = (db: any, candidateId: string, taskId: string): boolean => {
        const visited = new Set<string>();
        const queue = [taskId];
        while (queue.length > 0) {
          const current = queue.shift()!;
          if (visited.has(current)) continue;
          visited.add(current);
          const children = db.prepare("SELECT id FROM tasks WHERE parentId = ?").all(current) as { id: string }[];
          for (const child of children) {
            if (child.id === candidateId) return true;
            queue.push(child.id);
          }
        }
        return false;
      };
      if (isDescendant(db, body.parentId, id)) {
        return c.json({ error: "不能将任务移动到其子孙节点下面", code: "INVALID_PARENT_TASK" }, 400);
      }
    }
    if (body.parentId !== undefined && body.parentId !== null && body.parentId !== existing.parentId) {
      const parent = db
        .prepare("SELECT workspaceId FROM tasks WHERE id = ?")
        .get(body.parentId) as { workspaceId: string | null } | undefined;
      if (!parent) return c.json({ error: "父任务不存在" }, 404);
      if (parent.workspaceId !== existing.workspaceId) {
        return c.json(
          { error: "子任务必须与父任务在同一工作区", code: "SCOPE_MISMATCH" },
          400,
        );
      }
    }

    db.prepare(`
      UPDATE tasks SET title = ?, isCompleted = ?, priority = ?, dueDate = ?,
        noteId = ?, parentId = ?, sortOrder = ?, updatedAt = datetime('now')
      WHERE id = ?
    `).run(title, isCompleted, priority, dueDate, noteId, parentId, sortOrder, id);

    const updated = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    return c.json(updated);
  });
});

// 切换完成状态（快捷操作）
// Y3: 切换完成状态视作"编辑"——走 canManageResource。
tasks.patch("/:id/toggle", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const id = c.req.param("id");

  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
    | { userId: string; workspaceId: string | null; isCompleted: number }
    | undefined;
  if (!task) return c.json({ error: "Task not found" }, 404);

  if (!canManageResource(task.userId, task.workspaceId, userId)) {
    return c.json({ error: "无权修改该任务", code: "FORBIDDEN" }, 403);
  }

  const newStatus = task.isCompleted ? 0 : 1;
  db.prepare("UPDATE tasks SET isCompleted = ?, updatedAt = datetime('now') WHERE id = ?").run(newStatus, id);

  const updated = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  return c.json(updated);
});

// 删除任务
// Y3: 删除走 canManageResource；children 靠外键 ON DELETE CASCADE 自动清理。
tasks.delete("/:id", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const id = c.req.param("id");

  const task = db.prepare("SELECT userId, workspaceId FROM tasks WHERE id = ?").get(id) as
    | { userId: string; workspaceId: string | null }
    | undefined;
  if (!task) return c.json({ error: "Task not found" }, 404);

  if (!canManageResource(task.userId, task.workspaceId, userId)) {
    return c.json({ error: "无权删除该任务", code: "FORBIDDEN" }, 403);
  }

  db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  return c.json({ success: true });
});

export default tasks;
