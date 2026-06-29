import { Hono } from "hono";
import type { Context } from "hono";
import { getDb } from "../db/schema";
import { callAIChat } from "../services/ai-client";
import crypto from "crypto";
import {
  getUserWorkspaceRole,
  canManageResource,
  requireWorkspaceFeature,
} from "../middleware/acl";
import { taskDependenciesRepository } from "../repositories";


/** Collect a task id and all its descendant ids (recursive via parentId). */
function collectDescendantIds(db: any, rootIds: string[]): string[] {
  const result = new Set<string>();
  const queue = [...rootIds];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (result.has(current)) continue;
    result.add(current);
    const children = db.prepare("SELECT id FROM tasks WHERE parentId = ?").all(current) as { id: string }[];
    for (const c of children) {
      if (!result.has(c.id)) queue.push(c.id);
    }
  }
  return [...result];
}

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
    sql = `SELECT tasks.*, users.username AS creatorName,
                  (SELECT COUNT(*) FROM task_reminders tr
                   WHERE tr.taskId = tasks.id AND tr.userId = ? AND tr.enabled = 1) AS activeReminderCount
           FROM tasks LEFT JOIN users ON users.id = tasks.userId
           WHERE workspaceId = ?`;
    params.push(userId);
    params.push(scope.workspaceId);
  } else {
    sql = `SELECT tasks.*, users.username AS creatorName,
                  (SELECT COUNT(*) FROM task_reminders tr
                   WHERE tr.taskId = tasks.id AND tr.userId = ? AND tr.enabled = 1) AS activeReminderCount
           FROM tasks LEFT JOIN users ON users.id = tasks.userId
           WHERE tasks.userId = ? AND workspaceId IS NULL`;
    params.push(userId);
    params.push(userId);
  }

  if (noteId) {
    sql += ` AND noteId = ?`;
    params.push(noteId);
  }

  const projectId = c.req.query("projectId");
  if (projectId) {
    sql += ` AND projectId = ?`;
    params.push(projectId);
  } else if (projectId === "") {
    // empty string means "no project"
    sql += ` AND projectId IS NULL`;
  }

  if (filter === "today") {
    sql += ` AND COALESCE(dueAt, dueDate) IS NOT NULL AND date(COALESCE(dueAt, dueDate)) = date('now', 'localtime')`;
  } else if (filter === "week") {
    sql += ` AND COALESCE(dueAt, dueDate) IS NOT NULL AND date(COALESCE(dueAt, dueDate)) BETWEEN date('now', 'localtime') AND date('now', 'localtime', '+7 days')`;
  } else if (filter === "overdue") {
    sql += ` AND isCompleted = 0 AND COALESCE(dueAt, dueDate) IS NOT NULL AND COALESCE(dueAt, dueDate || 'T23:59:59') < datetime('now', 'localtime')`;
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
      SUM(CASE WHEN isCompleted = 0 AND COALESCE(dueAt, dueDate) IS NOT NULL
               AND date(COALESCE(dueAt, dueDate)) = date('now', 'localtime') THEN 1 ELSE 0 END)         AS today,
      SUM(CASE WHEN isCompleted = 0 AND COALESCE(dueAt, dueDate) IS NOT NULL
               AND COALESCE(dueAt, dueDate || 'T23:59:59') < datetime('now', 'localtime') THEN 1 ELSE 0 END)         AS overdue,
      SUM(CASE WHEN isCompleted = 0 AND COALESCE(dueAt, dueDate) IS NOT NULL
               AND date(COALESCE(dueAt, dueDate)) BETWEEN date('now', 'localtime')
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
tasks.put("/reorder/batch", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;

  return c.req.json().then((body: any) => {
    const items = Array.isArray(body?.items) ? body.items : [];
    if (items.length === 0 || items.length > 200) {
      return c.json({ error: "items must contain 1-200 tasks", code: "BAD_REQUEST" }, 400);
    }

    const normalized = items.map((item: any, index: number) => ({
      id: String(item?.id || ""),
      sortOrder: Number.isFinite(Number(item?.sortOrder)) ? Number(item.sortOrder) : index,
    }));
    if (normalized.some((item: { id: string; sortOrder: number }) => !item.id)) {
      return c.json({ error: "Invalid task id", code: "BAD_REQUEST" }, 400);
    }

    const ids = normalized.map((item: { id: string; sortOrder: number }) => item.id);
    if (new Set(ids).size !== ids.length) {
      return c.json({ error: "Duplicate task id", code: "DUPLICATE_TASK" }, 400);
    }

    const placeholders = ids.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT id, userId, workspaceId, parentId FROM tasks WHERE id IN (${placeholders})`,
    ).all(...ids) as Array<{ id: string; userId: string; workspaceId: string | null; parentId: string | null }>;

    if (rows.length !== ids.length) {
      return c.json({ error: "Task not found", code: "TASK_NOT_FOUND" }, 404);
    }
    if (rows.some((row) => !canManageResource(row.userId, row.workspaceId, userId))) {
      return c.json({ error: "Forbidden", code: "FORBIDDEN" }, 403);
    }

    const parentKey = rows[0].parentId ?? "";
    const workspaceKey = rows[0].workspaceId ?? "";
    if (rows.some((row) => (row.parentId ?? "") !== parentKey || (row.workspaceId ?? "") !== workspaceKey)) {
      return c.json({ error: "Tasks must share the same parent", code: "MIXED_PARENT_TASKS" }, 400);
    }

    const update = db.transaction(() => {
      const stmt = db.prepare("UPDATE tasks SET sortOrder = ?, updatedAt = datetime('now') WHERE id = ?");
      for (const item of normalized) stmt.run(item.sortOrder, item.id);
    });
    update();

    return c.json({ success: true, affected: normalized.length });
  });
});

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
  const { title, priority = 2, dueDate = null, dueAt = null, startDate = null, noteId = null, parentId = null } = body;
  const description = typeof body.description === "string" ? body.description : "";
  const repeatRule = body.repeatRule || "none";
  const repeatInterval = body.repeatInterval ?? 1;
  const repeatEndDate = body.repeatEndDate ?? null;
  const repeatGroupId = body.repeatGroupId ?? null;
  const repeatGeneratedFromId = body.repeatGeneratedFromId ?? null;

  const VALID_REPEAT = ["none", "daily", "weekly", "monthly", "yearly", "custom"];
  if (!VALID_REPEAT.includes(repeatRule)) {
    return c.json({ error: "Invalid repeatRule", code: "INVALID_REPEAT_RULE" }, 400);
  }
  if (repeatRule !== "none" && repeatRule !== "custom" && repeatInterval < 1) {
    return c.json({ error: "repeatInterval must be >= 1", code: "INVALID_REPEAT_INTERVAL" }, 400);
  }
  // TASK-RECURRENCE-CUSTOM-01: 解析自定义循环规则
  // TASK-RECURRENCE-CUSTOM-01-RV1: 增强校验
  let repeatRuleJson: string | null = null;
  if (repeatRule === "custom") {
    const rj = body.repeatRuleJson;
    if (!rj || typeof rj !== "object" || !rj.frequency || !rj.interval) {
      return c.json({ error: "repeatRuleJson required for custom repeat", code: "INVALID_REPEAT_RULE" }, 400);
    }
    const vErr = validateRepeatRuleJson(rj);
    if (vErr) return c.json({ error: vErr, code: "INVALID_REPEAT_RULE" }, 400);
    // 去重 weekdays
    if (rj.weekdays) rj.weekdays = [...new Set(rj.weekdays)].sort((a, b) => (a as number) - (b as number));
    repeatRuleJson = JSON.stringify(rj);
  }
  if (repeatRule !== "none" && !dueDate && !dueAt) {
    return c.json({ error: "Repeating task requires dueDate or dueAt", code: "REPEAT_REQUIRES_DATE" }, 400);
  }

  if (startDate && dueDate && startDate > dueDate) {
    return c.json({ error: "startDate cannot be after dueDate", code: "INVALID_DATE_RANGE" }, 400);
  }

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

  const projectId = body.projectId || null;
  const status = body.status || "todo";
  const VALID_STATUSES = ["todo", "doing", "blocked", "done"];
  if (!VALID_STATUSES.includes(status)) {
    return c.json({ error: "Invalid status, must be one of: todo, doing, blocked, done", code: "INVALID_STATUS" }, 400);
  }

  // Validate projectId belongs to same scope
  if (projectId) {
    const project = db.prepare("SELECT userId, workspaceId FROM task_projects WHERE id = ?").get(projectId) as any;
    if (!project) return c.json({ error: "Project not found", code: "PROJECT_NOT_FOUND" }, 400);
    if (effectiveWorkspaceId && project.workspaceId !== effectiveWorkspaceId) {
      return c.json({ error: "Project scope mismatch", code: "PROJECT_SCOPE_MISMATCH" }, 400);
    }
    if (!effectiveWorkspaceId && (project.userId !== userId || project.workspaceId !== null)) {
      return c.json({ error: "Project scope mismatch", code: "PROJECT_SCOPE_MISMATCH" }, 400);
    }
  }

  const effectiveIsCompleted = status === "done" ? 1 : 0;

  db.prepare(`
    INSERT INTO tasks (id, userId, workspaceId, title, description, isCompleted, priority, dueDate, dueAt, startDate, noteId, parentId, projectId, status, repeatRule, repeatInterval, repeatEndDate, repeatGroupId, repeatGeneratedFromId, repeatRuleJson)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, effectiveWorkspaceId, title.trim(), description, effectiveIsCompleted, priority, dueDate, dueAt, startDate, noteId, parentId, projectId, status, repeatRule, repeatInterval, repeatEndDate, repeatGroupId, repeatGeneratedFromId, repeatRuleJson);

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
    const priority = body.priority ?? existing.priority;
    const dueDate = body.dueDate !== undefined ? body.dueDate : existing.dueDate;
    const dueAt = body.dueAt !== undefined ? body.dueAt : existing.dueAt;
    const startDate = body.startDate !== undefined ? body.startDate : existing.startDate;
    const description = Object.prototype.hasOwnProperty.call(body, "description")
      ? (typeof body.description === "string" ? body.description : "")
      : (existing.description || "");
    const noteId = body.noteId !== undefined ? body.noteId : existing.noteId;
    const parentId = body.parentId !== undefined ? body.parentId : existing.parentId;
    const sortOrder = body.sortOrder ?? existing.sortOrder;
    const projectId = body.projectId !== undefined ? body.projectId : existing.projectId;

    // Repeat fields
    const repeatRule = body.repeatRule !== undefined ? body.repeatRule : (existing.repeatRule || "none");
    const repeatInterval = body.repeatInterval !== undefined ? body.repeatInterval : (existing.repeatInterval ?? 1);
    const repeatEndDate = body.repeatEndDate !== undefined ? body.repeatEndDate : (existing.repeatEndDate ?? null);

    const VALID_REPEAT = ["none", "daily", "weekly", "monthly", "yearly", "custom"];
    if (!VALID_REPEAT.includes(repeatRule)) {
      return c.json({ error: "Invalid repeatRule", code: "INVALID_REPEAT_RULE" }, 400);
    }
    if (repeatRule !== "none" && repeatRule !== "custom" && (repeatInterval ?? 0) < 1) {
      return c.json({ error: "repeatInterval must be >= 1", code: "INVALID_REPEAT_INTERVAL" }, 400);
    }
    // TASK-RECURRENCE-CUSTOM-01: 解析自定义循环规则
    // TASK-RECURRENCE-CUSTOM-01-RV1: 增强校验
    let repeatRuleJson: string | null = existing.repeatRuleJson || null;
    if (body.repeatRuleJson !== undefined) {
      if (body.repeatRuleJson === null) {
        repeatRuleJson = null;
      } else if (typeof body.repeatRuleJson === "object" && body.repeatRuleJson.frequency && body.repeatRuleJson.interval) {
        const vErr = validateRepeatRuleJson(body.repeatRuleJson);
        if (vErr) return c.json({ error: vErr, code: "INVALID_REPEAT_RULE" }, 400);
        const rj = { ...body.repeatRuleJson };
        if (rj.weekdays) rj.weekdays = [...new Set(rj.weekdays)].sort((a, b) => (a as number) - (b as number));
        repeatRuleJson = JSON.stringify(rj);
      } else {
        return c.json({ error: "Invalid repeatRuleJson", code: "INVALID_REPEAT_RULE" }, 400);
      }
    }
    if (repeatRule === "custom" && !repeatRuleJson) {
      return c.json({ error: "repeatRuleJson required for custom repeat", code: "INVALID_REPEAT_RULE" }, 400);
    }
    if (repeatRule !== "none" && !dueDate && !dueAt) {
      return c.json({ error: "Repeating task requires dueDate or dueAt", code: "REPEAT_REQUIRES_DATE" }, 400);
    }

    if (startDate && dueDate && startDate > dueDate) {
      return c.json({ error: "startDate cannot be after dueDate", code: "INVALID_DATE_RANGE" }, 400);
    }

    // Fix 5: status / isCompleted bidirectional sync
    const VALID_STATUSES = ["todo", "doing", "blocked", "done"];
    let status = body.status ?? existing.status;
    let isCompleted = body.isCompleted ?? existing.isCompleted;

    if (body.status !== undefined) {
      // status takes precedence
      if (!VALID_STATUSES.includes(status)) {
        return c.json({ error: "Invalid status", code: "INVALID_STATUS" }, 400);
      }
      isCompleted = status === "done" ? 1 : 0;
    } else if (body.isCompleted !== undefined) {
      // isCompleted takes precedence
      status = isCompleted ? "done" : (existing.status === "done" ? "todo" : existing.status);
    }

    // Fix 2: validate projectId scope
    if (body.projectId !== undefined && projectId !== null && projectId !== existing.projectId) {
      const project = db.prepare("SELECT userId, workspaceId FROM task_projects WHERE id = ?").get(projectId) as any;
      if (!project) return c.json({ error: "Project not found", code: "PROJECT_NOT_FOUND" }, 400);
      if (existing.workspaceId && project.workspaceId !== existing.workspaceId) {
        return c.json({ error: "Project scope mismatch", code: "PROJECT_SCOPE_MISMATCH" }, 400);
      }
      if (!existing.workspaceId && (project.userId !== existing.userId || project.workspaceId !== null)) {
        return c.json({ error: "Project scope mismatch", code: "PROJECT_SCOPE_MISMATCH" }, 400);
      }
    }

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
      UPDATE tasks SET title = ?, isCompleted = ?, priority = ?, dueDate = ?, dueAt = ?, startDate = ?,
        description = ?, noteId = ?, parentId = ?, sortOrder = ?, projectId = ?, status = ?, repeatRule = ?, repeatInterval = ?, repeatEndDate = ?, repeatRuleJson = ?, updatedAt = datetime('now')
      WHERE id = ?
    `).run(title, isCompleted, priority, dueDate, dueAt, startDate, description, noteId, parentId, sortOrder, projectId, status, repeatRule, repeatInterval, repeatEndDate, repeatRuleJson, id);

    let generatedTask = null;
    // Generate next repeated task when marking as done via PUT
    if (isCompleted === 1 && existing.isCompleted === 0) {
      generatedTask = generateNextRepeatedTask(db, existing);
    }

    const updated = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    return c.json({ task: updated, generatedTask });
  });
});

// 切换完成状态（快捷操作）
// Y3: 切换完成状态视作"编辑"——走 canManageResource。
/** TASK-RECURRENCE-CUSTOM-01: 从自定义规则计算下一次日期 */
function nextDateFromCustomRule(baseDate: Date, rule: any): Date | null {
  const freq = rule.frequency;
  const interval = Math.max(1, Number(rule.interval) || 1);

  if (freq === "day") {
    const next = new Date(baseDate);
    next.setDate(next.getDate() + interval);
    return next;
  }

  if (freq === "week") {
    const weekdays: number[] = rule.weekdays || []; // 0=Sun, 1=Mon, ..., 6=Sat
    if (weekdays.length === 0) {
      // 无指定星期 → 简单加 N 周
      const next = new Date(baseDate);
      next.setDate(next.getDate() + 7 * interval);
      return next;
    }
    // 找下一个匹配的星期几
    const sorted = [...weekdays].sort((a, b) => a - b);
    const curDay = baseDate.getDay();
    // 先找本周内下一个
    for (const d of sorted) {
      if (d > curDay) {
        const next = new Date(baseDate);
        next.setDate(next.getDate() + (d - curDay));
        return next;
      }
    }
    // 没找到 → 下一周的第 一个
    const next = new Date(baseDate);
    next.setDate(next.getDate() + (7 * interval) - curDay + sorted[0]);
    return next;
  }

  // TASK-RECURRENCE-CUSTOM-01-RV1: 修复月末/闰年溢出
  // 先 setDate(1) 防止 setMonth 溢出到下下月
  if (freq === "month") {
    const monthDay = Number(rule.monthDay) || baseDate.getDate();
    const next = new Date(baseDate);
    next.setDate(1); // 防止溢出：31 日 setMonth 会跳过短月
    next.setMonth(next.getMonth() + interval);
    const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(monthDay, lastDay));
    return next;
  }

  if (freq === "year") {
    const yearMonth = Number(rule.yearMonth) || (baseDate.getMonth() + 1);
    const yearDay = Number(rule.yearDay) || baseDate.getDate();
    const next = new Date(baseDate);
    next.setDate(1); // 防止溢出：2 月 29 日 setFullYear 到非闰年会跳月
    next.setFullYear(next.getFullYear() + interval);
    next.setMonth(yearMonth - 1);
    const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(yearDay, lastDay));
    return next;
  }

  return null;
}

// TASK-RECURRENCE-CUSTOM-01-RV1: 校验自定义循环规则字段
const VALID_FREQS = ["day", "week", "month", "year"];
function validateRepeatRuleJson(rj: any): string | null {
  if (!rj || typeof rj !== "object") return "repeatRuleJson must be an object";
  if (!VALID_FREQS.includes(rj.frequency)) return "frequency must be day/week/month/year";
  if (!rj.interval || Number(rj.interval) < 1) return "interval must be >= 1";
  if (rj.weekdays !== undefined) {
    if (!Array.isArray(rj.weekdays)) return "weekdays must be an array";
    for (const w of rj.weekdays) {
      if (!Number.isInteger(w) || w < 0 || w > 6) return "weekdays values must be 0-6";
    }
  }
  if (rj.monthDay !== undefined) {
    const md = Number(rj.monthDay);
    if (!Number.isInteger(md) || md < 1 || md > 31) return "monthDay must be 1-31";
  }
  if (rj.yearMonth !== undefined) {
    const ym = Number(rj.yearMonth);
    if (!Number.isInteger(ym) || ym < 1 || ym > 12) return "yearMonth must be 1-12";
  }
  if (rj.yearDay !== undefined) {
    const yd = Number(rj.yearDay);
    if (!Number.isInteger(yd) || yd < 1 || yd > 31) return "yearDay must be 1-31";
  }
  return null;
}

/** Generate next repeated task. Returns the new task or null. */
function generateNextRepeatedTask(db: any, task: any): any {
  if (!task.repeatRule || task.repeatRule === "none" || task.repeatNextGeneratedId) return null;
  const baseDateStr = task.dueAt ? task.dueAt.split("T")[0] : task.dueDate;
  if (!baseDateStr) return null;

  const parts = baseDateStr.split("-").map(Number);
  const base = new Date(parts[0], parts[1] - 1, parts[2]);
  let next: Date | null = null;

  if (task.repeatRule === "custom") {
    let rule: any = null;
    try { rule = JSON.parse(task.repeatRuleJson || "{}"); } catch {}
    if (!rule || !rule.frequency) return null;
    next = nextDateFromCustomRule(base, rule);
  } else {
    const interval = task.repeatInterval || 1;
    switch (task.repeatRule) {
      case "daily": next = new Date(base); next.setDate(next.getDate() + interval); break;
      case "weekly": next = new Date(base); next.setDate(next.getDate() + 7 * interval); break;
      case "monthly":
        next = new Date(base); next.setMonth(next.getMonth() + interval);
        if (next.getDate() !== base.getDate()) next.setDate(0);
        break;
      case "yearly":
        next = new Date(base); next.setFullYear(next.getFullYear() + interval);
        if (next.getDate() !== base.getDate()) next.setDate(0);
        break;
      default: return null;
    }
  }

  if (!next) return null;

  if (task.repeatEndDate) {
    const endParts = task.repeatEndDate.split("-").map(Number);
    const endDate = new Date(endParts[0], endParts[1] - 1, endParts[2]);
    if (next > endDate) return null;
  }

  const yyyy = next.getFullYear();
  const mm = String(next.getMonth() + 1).padStart(2, "0");
  const dd = String(next.getDate()).padStart(2, "0");
  const nextDateStr = `${yyyy}-${mm}-${dd}`;
  let nextDueAt: string | null = null;
  let nextDueDate = nextDateStr;
  if (task.dueAt) {
    const timePart = task.dueAt.split("T")[1] || "00:00:00";
    nextDueAt = `${nextDateStr}T${timePart}`;
  }

  const newId = crypto.randomUUID();
  const groupId = task.repeatGroupId || task.id;
  db.prepare(`
    INSERT INTO tasks (id, userId, workspaceId, title, description, isCompleted, priority, dueDate, dueAt, startDate, noteId, parentId, projectId, status, repeatRule, repeatInterval, repeatEndDate, repeatGroupId, repeatGeneratedFromId, repeatRuleJson)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(newId, task.userId, task.workspaceId, task.title, task.description || "", task.priority, nextDueDate, nextDueAt, null, task.noteId, task.parentId, task.projectId, 'todo', task.repeatRule, task.repeatInterval, task.repeatEndDate, groupId, task.id, task.repeatRuleJson);

  db.prepare("UPDATE tasks SET repeatNextGeneratedId = ? WHERE id = ?").run(newId, task.id);

  const reminders = db.prepare("SELECT * FROM task_reminders WHERE taskId = ?").all(task.id) as any[];
  for (const r of reminders) {
    const rId = crypto.randomUUID();
    db.prepare("INSERT INTO task_reminders (id, taskId, userId, offsetMinutes, enabled, lastNotifiedAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, NULL, datetime('now'), datetime('now'))").run(rId, newId, r.userId, r.offsetMinutes, r.enabled);
  }

  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(newId);
}

tasks.patch("/:id/toggle", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const id = c.req.param("id");

  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
  if (!task) return c.json({ error: "Task not found" }, 404);

  if (!canManageResource(task.userId, task.workspaceId, userId)) {
    return c.json({ error: "无权修改该任务", code: "FORBIDDEN" }, 403);
  }

  const newStatus = task.isCompleted ? 0 : 1;
  const newTaskStatus = newStatus === 1 ? "done" : "todo";
  db.prepare("UPDATE tasks SET isCompleted = ?, status = ?, updatedAt = datetime('now') WHERE id = ?").run(newStatus, newTaskStatus, id);

  const generatedTask = newStatus === 1 ? generateNextRepeatedTask(db, task) : null;

    const updated = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  return c.json({ task: updated, generatedTask });
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

  // Collect all descendants (children, grandchildren, etc.)
  const idsToDelete = collectDescendantIds(db, [id]);
  const ph = idsToDelete.map(() => "?").join(",");

  // Clean up all dependencies referencing deleted tasks (including descendants)
  taskDependenciesRepository.deleteByTaskIds(idsToDelete);

  // Delete root task (children cascade via ON DELETE CASCADE)
  db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  return c.json({ success: true });
});

/** 安全清理任务依赖：表不存在或清理失败不阻断删除 */
function safeDeleteTaskDependencies(db: any, ids: string[]) {
  if (!ids || ids.length === 0) return;
  try {
    const tableExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='task_dependencies'"
    ).get();
    if (!tableExists) {
      console.warn("[tasks.batch] task_dependencies table not found, skipping");
      return;
    }
    taskDependenciesRepository.deleteByTaskIds(ids);
  } catch (err) {
    console.warn("[tasks.batch] failed to cleanup task_dependencies:", err);
  }
}

// batch: complete / delete multiple tasks
tasks.post("/batch", async (c) => {
  const logPrefix = "[tasks.batch]";
  try {
    const db = getDb();
    const userId = c.req.header("X-User-Id")!;
    const body = await c.req.json();
    const { ids, action } = body as { ids: string[]; action: "complete" | "delete" };

    console.log(`${logPrefix} action=${action}, ids.length=${ids?.length ?? 0}`);

    if (!Array.isArray(ids) || ids.length === 0) {
      return c.json({ error: "ids cannot be empty", code: "BAD_REQUEST" }, 400);
    }
    if (!["complete", "delete"].includes(action)) {
      return c.json({ error: "action must be complete or delete", code: "BAD_REQUEST" }, 400);
    }

    const safeIds = ids.slice(0, 100);
    const placeholders = safeIds.map(() => "?").join(",");
    const tasksFound = db.prepare(
      "SELECT id, userId, workspaceId FROM tasks WHERE id IN (" + placeholders + ")"
    ).all(...safeIds) as { id: string; userId: string; workspaceId: string | null }[];

    console.log(`${logPrefix} safeIds.length=${safeIds.length}, tasksFound=${tasksFound.length}`);

    const allowedIds = tasksFound
      .filter((t) => canManageResource(t.userId, t.workspaceId, userId))
      .map((t) => t.id);

    console.log(`${logPrefix} allowedIds.length=${allowedIds.length}`);

    if (allowedIds.length === 0) {
      return c.json({ error: "Forbidden", code: "FORBIDDEN" }, 403);
    }

    const ph = allowedIds.map(() => "?").join(",");
    if (action === "complete") {
      const tasksBefore = db.prepare("SELECT * FROM tasks WHERE id IN (" + ph + ")").all(...allowedIds) as any[];
      const toComplete = tasksBefore.filter((t) => t.isCompleted === 0);
      if (toComplete.length === 0) return c.json({ success: true, affected: 0, generatedCount: 0 });

      const completeIds = toComplete.map((t) => t.id);
      const cph = completeIds.map(() => "?").join(",");
      db.prepare("UPDATE tasks SET isCompleted = 1, status = 'done', updatedAt = datetime(\"now\") WHERE id IN (" + cph + ")")
        .run(...completeIds);

      let generatedCount = 0;
      for (const task of toComplete) {
        try {
          if (generateNextRepeatedTask(db, task)) generatedCount++;
        } catch (err) {
          console.error(`${logPrefix} failed to generate next repeated task for ${task.id}:`, err);
        }
      }

      console.log(`${logPrefix} complete success: affected=${toComplete.length}, generated=${generatedCount}`);
      return c.json({ success: true, affected: toComplete.length, generatedCount });
    } else {
      const idsToDelete = collectDescendantIds(db, allowedIds);
      console.log(`${logPrefix} delete: allowedIds=${allowedIds.length}, idsToDelete=${idsToDelete.length}`);

      safeDeleteTaskDependencies(db, idsToDelete);

      const dph = allowedIds.map(() => "?").join(",");
      db.prepare("DELETE FROM tasks WHERE id IN (" + dph + ")").run(...allowedIds);

      console.log(`${logPrefix} delete success: affected=${allowedIds.length}`);
      return c.json({ success: true, affected: allowedIds.length });
    }
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    console.error(`${logPrefix} FAILED:`, errMsg, err);
    return c.json({
      error: "批量操作失败",
      code: "TASK_BATCH_FAILED",
      detail: errMsg,
    }, 500);
  }
});

// AI Breakdown Task
tasks.post("/:id/ai-breakdown", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id")!;
  const id = c.req.param("id");

  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
  if (!task) return c.json({ error: "Task not found" }, 404);
  if (!canManageResource(task.userId, task.workspaceId, userId)) {
    return c.json({ error: "Forbidden", code: "FORBIDDEN" }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const lang = body.lang || "zh-CN";

  // Get AI settings
  const rows = db.prepare("SELECT key, value FROM system_settings WHERE key LIKE 'ai_%'").all() as any[];
  const settings: any = { ai_provider: "", ai_api_url: "", ai_api_key: "", ai_model: "", ai_embedding_url: "", ai_embedding_key: "", ai_embedding_model: "" };
  for (const row of rows) settings[row.key] = row.value;

  if (!settings.ai_api_url) {
    return c.json({ error: "AI not configured", code: "AI_NOT_CONFIGURED" }, 400);
  }

  // Get existing subtasks
  const existingChildren = db.prepare("SELECT title, priority, dueDate FROM tasks WHERE parentId = ?").all(id) as any[];
  const existingList = existingChildren.map((ch) => ch.title).join(", ");

  const isZh = lang.toLowerCase().startsWith("zh");
  const systemPrompt = isZh
    ? "你是一个任务管理助手。用户会给你一个任务，你需要把它拆解成 3-8 个可执行的子任务。请严格返回 JSON 格式，不要包含其他文字。JSON 格式：{\"subtasks\":[{\"title\":\"子任务标题\",\"priority\":1或2或3,\"dueDate\":\"YYYY-MM-DD或null\",\"reason\":\"为什么这样拆\"}]}。规则：1.子任务标题要简短。2.如果有截止日期，子任务不晚于父任务。3.priority: 1=低,2=中,3=高。4.不要重复已有子任务。"
    : "You are a task management assistant. Break the given task into 3-8 actionable subtasks. Return ONLY valid JSON, no other text. JSON format: {\"subtasks\":[{\"title\":\"subtask title\",\"priority\":1,2,or3,\"dueDate\":\"YYYY-MM-DD or null\",\"reason\":\"why this breakdown\"}]}. Rules: 1.Keep titles short. 2.Subtask dueDate must not be later than parent. 3.priority: 1=low,2=medium,3=high. 4.Don't duplicate existing subtasks."

  const userParts = [
    isZh ? "任务标题：" + task.title : "Task title: " + task.title,
  ];
  if (task.dueDate) userParts.push(isZh ? "截止日期：" + task.dueDate : "Due date: " + task.dueDate);
  if (task.dueAt) userParts.push(isZh ? "截止时间：" + task.dueAt : "Due time: " + task.dueAt);
  if (existingList) userParts.push(isZh ? "已有子任务：" + existingList : "Existing subtasks: " + existingList);

  try {
    const result = await callAIChat(settings, [
      { role: "system", content: systemPrompt },
      { role: "user", content: userParts.join("\n") },
    ], { temperature: 0.7, max_tokens: 2000, timeout_ms: 30000 });

    // Extract JSON from response
    let parsed: any;
    try {
      parsed = JSON.parse(result);
    } catch {
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        return c.json({ error: "AI returned invalid JSON", code: "AI_INVALID_JSON" }, 500);
      }
    }

    if (!parsed.subtasks || !Array.isArray(parsed.subtasks)) {
      return c.json({ error: "AI response missing subtasks array", code: "AI_INVALID_FORMAT" }, 500);
    }

    // Validate and clamp
    const VALID_PRIORITIES = [1, 2, 3];
    const parentDue = task.dueAt ? task.dueAt.split("T")[0] : task.dueDate;
    const subtasks = parsed.subtasks
      .filter((s: any) => s.title && typeof s.title === "string")
      .slice(0, 8)
      .map((s: any) => ({
        title: s.title.trim().slice(0, 200),
        priority: VALID_PRIORITIES.includes(s.priority) ? s.priority : 2,
        dueDate: s.dueDate && typeof s.dueDate === "string" && s.dueDate.match(/^\d{4}-\d{2}-\d{2}$/)
          ? (parentDue && s.dueDate > parentDue ? parentDue : s.dueDate)
          : null,
        reason: typeof s.reason === "string" ? s.reason.trim().slice(0, 200) : "",
      }));

    return c.json({ subtasks });
  } catch (err: any) {
    return c.json({ error: err.message || "AI request failed", code: "AI_REQUEST_FAILED" }, 500);
  }
});

export default tasks;
