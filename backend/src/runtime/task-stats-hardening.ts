import crypto from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { getDb } from "../db/schema.js";
import {
  canManageResource,
  getUserWorkspaceRole,
  requireWorkspaceFeature,
} from "../middleware/acl.js";
import noteTransfersRouter from "../routes/note-transfers.js";
import { installNoteSplitRoutes } from "./note-split.js";

const ROUTE_PATCH_FLAG = Symbol.for("nowen.taskStatsHardening.routePatch");
const ROUTER_INSTALLED_FLAG = Symbol.for("nowen.taskStatsHardening.routerInstalled");
const NOTE_TRANSFER_INSTALLED_FLAG = Symbol.for("nowen.noteTransfer.routerInstalled");
const globals = globalThis as typeof globalThis & Record<symbol, boolean>;

function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function normalizeIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

export function ensureTaskStatsSchema(): void {
  const db = getDb();
  const columns = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "completedAt")) {
    db.prepare("ALTER TABLE tasks ADD COLUMN completedAt TEXT").run();
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS task_activity_events (
      id TEXT PRIMARY KEY,
      taskId TEXT,
      taskTitle TEXT NOT NULL,
      eventType TEXT NOT NULL CHECK (eventType IN ('created', 'completed')),
      userId TEXT NOT NULL,
      workspaceId TEXT,
      projectId TEXT,
      occurredAt TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_task_activity_scope_time
      ON task_activity_events(workspaceId, userId, occurredAt DESC);
    CREATE INDEX IF NOT EXISTS idx_task_activity_task_type
      ON task_activity_events(taskId, eventType, occurredAt DESC);
    CREATE INDEX IF NOT EXISTS idx_task_activity_type_time
      ON task_activity_events(eventType, occurredAt DESC);

    DROP TRIGGER IF EXISTS tasks_activity_after_insert_created;
    CREATE TRIGGER tasks_activity_after_insert_created
    AFTER INSERT ON tasks
    BEGIN
      INSERT INTO task_activity_events (
        id, taskId, taskTitle, eventType, userId, workspaceId, projectId, occurredAt
      ) VALUES (
        lower(hex(randomblob(16))),
        NEW.id,
        NEW.title,
        'created',
        NEW.userId,
        NEW.workspaceId,
        NEW.projectId,
        CASE
          WHEN NEW.createdAt IS NULL OR trim(NEW.createdAt) = ''
            THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHEN NEW.createdAt GLOB '*Z' OR NEW.createdAt GLOB '*+??:??' OR NEW.createdAt GLOB '*-??:??'
            THEN replace(NEW.createdAt, ' ', 'T')
          ELSE replace(NEW.createdAt, ' ', 'T') || 'Z'
        END
      );
    END;

    DROP TRIGGER IF EXISTS tasks_activity_after_insert_completed;
    CREATE TRIGGER tasks_activity_after_insert_completed
    AFTER INSERT ON tasks
    WHEN NEW.isCompleted = 1
    BEGIN
      INSERT INTO task_activity_events (
        id, taskId, taskTitle, eventType, userId, workspaceId, projectId, occurredAt
      ) VALUES (
        lower(hex(randomblob(16))),
        NEW.id,
        NEW.title,
        'completed',
        NEW.userId,
        NEW.workspaceId,
        NEW.projectId,
        COALESCE(NULLIF(NEW.completedAt, ''), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    END;

    DROP TRIGGER IF EXISTS tasks_activity_after_update_completed;
    CREATE TRIGGER tasks_activity_after_update_completed
    AFTER UPDATE OF isCompleted ON tasks
    WHEN OLD.isCompleted = 0 AND NEW.isCompleted = 1
    BEGIN
      INSERT INTO task_activity_events (
        id, taskId, taskTitle, eventType, userId, workspaceId, projectId, occurredAt
      ) VALUES (
        lower(hex(randomblob(16))),
        NEW.id,
        NEW.title,
        'completed',
        NEW.userId,
        NEW.workspaceId,
        NEW.projectId,
        COALESCE(NULLIF(NEW.completedAt, ''), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    END;
  `);
}

type TaskScope =
  | { kind: "personal"; workspaceId: null }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "forbidden"; workspaceId: string };

function resolveTaskScope(rawWorkspaceId: string | undefined, userId: string): TaskScope {
  if (!rawWorkspaceId || rawWorkspaceId === "personal") {
    return { kind: "personal", workspaceId: null };
  }
  return getUserWorkspaceRole(rawWorkspaceId, userId)
    ? { kind: "workspace", workspaceId: rawWorkspaceId }
    : { kind: "forbidden", workspaceId: rawWorkspaceId };
}

export function installTaskStatsRoutes(router: Hono<any>): void {
  const taggedRouter = router as Hono<any> & Record<symbol, boolean>;
  if (taggedRouter[ROUTER_INSTALLED_FLAG]) return;
  taggedRouter[ROUTER_INSTALLED_FLAG] = true;

  router.get(
    "/stats/activity-events",
    requireWorkspaceFeature("tasks"),
    (c: Context) => {
      ensureTaskStatsSchema();
      const userId = c.req.header("X-User-Id")!;
      const scope = resolveTaskScope(c.req.query("workspaceId"), userId);
      if (scope.kind === "forbidden") {
        return c.json({ error: "无权访问该工作区", code: "FORBIDDEN" }, 403);
      }

      const from = c.req.query("from");
      const to = c.req.query("to");
      if ((from && !isDateKey(from)) || (to && !isDateKey(to))) {
        return c.json({ error: "from/to must use YYYY-MM-DD", code: "INVALID_DATE" }, 400);
      }
      if (from && to && from > to) {
        return c.json({ error: "from must not be later than to", code: "INVALID_DATE_RANGE" }, 400);
      }

      const requestedLimit = Number(c.req.query("limit") || 5000);
      const limit = Number.isFinite(requestedLimit)
        ? Math.max(1, Math.min(10_000, Math.trunc(requestedLimit)))
        : 5000;
      const where: string[] = [
        "EXISTS (SELECT 1 FROM tasks AS live_task WHERE live_task.id = e.taskId)",
      ];
      const params: unknown[] = [];
      if (scope.kind === "workspace") {
        where.push("e.workspaceId = ?");
        params.push(scope.workspaceId);
      } else {
        where.push("e.userId = ?", "e.workspaceId IS NULL");
        params.push(userId);
      }
      if (from) {
        where.push("e.occurredAt >= ?");
        params.push(`${from}T00:00:00.000Z`);
      }
      if (to) {
        where.push("e.occurredAt <= ?");
        params.push(`${to}T23:59:59.999Z`);
      }
      params.push(limit);

      const rows = getDb().prepare(`
        SELECT e.id, e.taskId, e.taskTitle, e.eventType, e.userId, e.workspaceId, e.projectId,
               e.occurredAt, e.createdAt
        FROM task_activity_events AS e
        WHERE ${where.join(" AND ")}
        ORDER BY e.occurredAt DESC, e.createdAt DESC
        LIMIT ?
      `).all(...params);
      return c.json(rows);
    },
  );

  router.patch("/:id/completed-at", async (c: Context) => {
    ensureTaskStatsSchema();
    const db = getDb();
    const userId = c.req.header("X-User-Id")!;
    const id = c.req.param("id");
    const task = db.prepare(
      "SELECT id, userId, workspaceId, title, projectId, isCompleted FROM tasks WHERE id = ?",
    ).get(id) as {
      id: string;
      userId: string;
      workspaceId: string | null;
      title: string;
      projectId: string | null;
      isCompleted: number;
    } | undefined;
    if (!task) return c.json({ error: "Task not found", code: "NOT_FOUND" }, 404);
    if (!canManageResource(task.userId, task.workspaceId, userId)) {
      return c.json({ error: "Forbidden", code: "FORBIDDEN" }, 403);
    }
    if (!task.isCompleted) {
      return c.json({ error: "Only completed tasks can restore completedAt", code: "TASK_NOT_COMPLETED" }, 409);
    }

    const body = await c.req.json().catch(() => ({})) as { completedAt?: unknown };
    const completedAt = normalizeIsoTimestamp(body.completedAt);
    if (!completedAt) {
      return c.json({ error: "completedAt must be a valid ISO timestamp", code: "INVALID_COMPLETED_AT" }, 400);
    }

    const transaction = db.transaction(() => {
      db.prepare("UPDATE tasks SET completedAt = ? WHERE id = ?").run(completedAt, id);
      const latest = db.prepare(`
        SELECT id FROM task_activity_events
        WHERE taskId = ? AND eventType = 'completed'
        ORDER BY occurredAt DESC, createdAt DESC
        LIMIT 1
      `).get(id) as { id: string } | undefined;
      if (latest) {
        db.prepare(`
          UPDATE task_activity_events
          SET occurredAt = ?, taskTitle = ?, userId = ?, workspaceId = ?, projectId = ?
          WHERE id = ?
        `).run(completedAt, task.title, task.userId, task.workspaceId, task.projectId, latest.id);
      } else {
        db.prepare(`
          INSERT INTO task_activity_events (
            id, taskId, taskTitle, eventType, userId, workspaceId, projectId, occurredAt
          ) VALUES (?, ?, ?, 'completed', ?, ?, ?, ?)
        `).run(
          crypto.randomUUID(),
          id,
          task.title,
          task.userId,
          task.workspaceId,
          task.projectId,
          completedAt,
        );
      }
    });
    transaction();

    const updated = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    return c.json(updated);
  });
}

if (!globals[ROUTE_PATCH_FLAG]) {
  globals[ROUTE_PATCH_FLAG] = true;
  const prototype = Hono.prototype as any;
  const nativeRoute = prototype.route as (this: Hono<any>, path: string, subApp: Hono<any>) => Hono<any>;
  prototype.route = function patchedRoute(this: Hono<any>, path: string, subApp: Hono<any>) {
    if (path === "/api/tasks") installTaskStatsRoutes(subApp);
    if (path === "/api/notes") installNoteSplitRoutes(subApp);
    if (path === "/api/notebooks") {
      const taggedApp = this as Hono<any> & Record<symbol, boolean>;
      if (!taggedApp[NOTE_TRANSFER_INSTALLED_FLAG]) {
        taggedApp[NOTE_TRANSFER_INSTALLED_FLAG] = true;
        nativeRoute.call(this, "/api/note-transfers", noteTransfersRouter);
      }
    }
    return nativeRoute.call(this, path, subApp);
  };
}

// Ensure direct route imports and production startup both see the same schema.
ensureTaskStatsSchema();
