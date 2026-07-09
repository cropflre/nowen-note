import { Hono } from "hono";
import type { Context } from "hono";
import crypto from "crypto";
import { getDb } from "../db/schema";
import {
    canManageResource,
    getUserWorkspaceRole,
    isFeatureEnabled,
    requireWorkspaceFeature,
    resolveWorkspaceFeatures,
} from "../middleware/acl";

const habits = new Hono();

type HabitStatus = "success" | "partial" | "failure";

const STATUS_SET = new Set<HabitStatus>(["success", "partial", "failure"]);
const ROLE_RANK: Record<string, number> = { viewer: 1, commenter: 2, editor: 3, admin: 4, owner: 5 };

function resolveHabitScope(
    c: Context,
    userId: string,
): { scope: "personal" | "workspace"; workspaceId: string | null; error?: string } {
    const raw = c.req.query("workspaceId");
    if (!raw || raw === "personal") return { scope: "personal", workspaceId: null };
    const role = getUserWorkspaceRole(raw, userId);
    if (!role) return { scope: "workspace", workspaceId: raw, error: "无权访问该工作区" };
    return { scope: "workspace", workspaceId: raw };
}

function getLocalDateKey(date = new Date()): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

function normalizeCheckinDate(raw: unknown): string {
    if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        return getLocalDateKey();
    }
    return raw;
}

function getQueryCheckinDate(c: Context): string {
    return normalizeCheckinDate(c.req.query("checkinDate") ?? c.req.query("today"));
}

function canCreateInWorkspace(workspaceId: string | null, userId: string): boolean {
    if (!workspaceId) return true;
    const role = getUserWorkspaceRole(workspaceId, userId) as string | null;
    return !!role && (ROLE_RANK[role] ?? 0) >= ROLE_RANK.editor;
}

function getHabitOr404(id: string) {
    const db = getDb();
    return db.prepare("SELECT * FROM habits WHERE id = ?").get(id) as
        | {
            id: string;
            userId: string;
            workspaceId: string | null;
            title: string;
            icon: string;
            color: string;
            sortOrder: number;
            archivedAt: string | null;
        }
        | undefined;
}

function rejectDisabledHabitFeature(c: Context, workspaceId: string | null) {
    if (!workspaceId) return null;
    const features = resolveWorkspaceFeatures(workspaceId);
    if (isFeatureEnabled(features, "tasks")) return null;
    return c.json(
        {
            error: "该功能在当前工作区已被管理员关闭",
            code: "FEATURE_DISABLED",
            feature: "tasks",
        },
        403,
    );
}

habits.get("/", requireWorkspaceFeature("tasks"), (c) => {
    const db = getDb();
    const userId = c.req.header("X-User-Id")!;
    const includeArchived = c.req.query("includeArchived") === "1";
    const today = getQueryCheckinDate(c);

    const scope = resolveHabitScope(c, userId);
    if (scope.error) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);

    let sql = `
    SELECT
      habits.*,
      users.username AS creatorName,
      todayCheckin.status AS todayStatus,
      todayCheckin.note AS todayNote,
      todayCheckin.checkinDate AS todayCheckinDate
    FROM habits
    LEFT JOIN users ON users.id = habits.userId
    LEFT JOIN habit_checkins todayCheckin
      ON todayCheckin.habitId = habits.id AND todayCheckin.checkinDate = ?
    WHERE `;
    const params: any[] = [today];
    if (scope.scope === "workspace") {
        sql += "habits.workspaceId = ?";
        params.push(scope.workspaceId);
    } else {
        sql += "habits.userId = ? AND habits.workspaceId IS NULL";
        params.push(userId);
    }
    if (!includeArchived) sql += " AND habits.archivedAt IS NULL";
    sql += " ORDER BY habits.sortOrder ASC, habits.createdAt DESC";

    const rows = db.prepare(sql).all(...params);
    return c.json(rows);
});

habits.get("/stats", requireWorkspaceFeature("tasks"), (c) => {
    const db = getDb();
    const userId = c.req.header("X-User-Id")!;
    const includeArchived = c.req.query("includeArchived") === "1";
    const today = getQueryCheckinDate(c);

    const scope = resolveHabitScope(c, userId);
    if (scope.error) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);

    const whereParts: string[] = [];
    const params: any[] = [];
    if (scope.scope === "workspace") {
        whereParts.push("h.workspaceId = ?");
        params.push(scope.workspaceId);
    } else {
        whereParts.push("h.userId = ?", "h.workspaceId IS NULL");
        params.push(userId);
    }
    if (!includeArchived) whereParts.push("h.archivedAt IS NULL");
    const whereSql = whereParts.join(" AND ");

    const row = db.prepare(`
    SELECT
      COUNT(hc.id) AS totalCheckins,
      COUNT(DISTINCT hc.checkinDate) AS checkinDays,
      SUM(CASE WHEN hc.status = 'success' THEN 1 ELSE 0 END) AS successCount,
      SUM(CASE WHEN hc.status = 'partial' THEN 1 ELSE 0 END) AS partialCount,
      SUM(CASE WHEN hc.status = 'failure' THEN 1 ELSE 0 END) AS failureCount
    FROM habits h
    LEFT JOIN habit_checkins hc ON hc.habitId = h.id
    WHERE ${whereSql}
  `).get(...params) as any;

    const streakRows = db.prepare(`
    SELECT DISTINCT hc.checkinDate AS checkinDate
    FROM habits h
    INNER JOIN habit_checkins hc ON hc.habitId = h.id
    WHERE ${whereSql} AND hc.status IN ('success', 'partial')
    ORDER BY hc.checkinDate DESC
  `).all(...params) as Array<{ checkinDate: string }>;

    let currentStreak = 0;
    let cursor = today;
    const available = new Set(streakRows.map((item) => item.checkinDate));
    while (available.has(cursor)) {
        currentStreak += 1;
        const cur = new Date(`${cursor}T00:00:00`);
        cur.setDate(cur.getDate() - 1);
        cursor = getLocalDateKey(cur);
    }

    return c.json({
        totalCheckins: row?.totalCheckins ?? 0,
        checkinDays: row?.checkinDays ?? 0,
        currentStreak,
        successCount: row?.successCount ?? 0,
        partialCount: row?.partialCount ?? 0,
        failureCount: row?.failureCount ?? 0,
    });
});

habits.post("/", requireWorkspaceFeature("tasks"), async (c) => {
    const db = getDb();
    const userId = c.req.header("X-User-Id")!;
    const body = await c.req.json();
    const scope = resolveHabitScope(c, userId);
    if (scope.error) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);
    if (!canCreateInWorkspace(scope.workspaceId, userId)) {
        return c.json({ error: "无权创建习惯", code: "FORBIDDEN" }, 403);
    }

    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) return c.json({ error: "Title is required", code: "BAD_REQUEST" }, 400);

    const id = crypto.randomUUID();
    const icon = typeof body.icon === "string" && body.icon.trim() ? body.icon.trim() : "check-circle";
    const color = typeof body.color === "string" && body.color.trim() ? body.color.trim() : "#10b981";
    const sortOrder = Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : 0;

    db.prepare(`
    INSERT INTO habits (id, userId, workspaceId, title, icon, color, sortOrder)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, scope.workspaceId, title, icon, color, sortOrder);

    const created = db.prepare("SELECT * FROM habits WHERE id = ?").get(id);
    return c.json(created, 201);
});

habits.get("/:id/checkins", (c) => {
    const db = getDb();
    const userId = c.req.header("X-User-Id")!;
    const id = c.req.param("id");
    const habit = getHabitOr404(id);
    if (!habit) return c.json({ error: "Habit not found", code: "NOT_FOUND" }, 404);
    const disabled = rejectDisabledHabitFeature(c, habit.workspaceId);
    if (disabled) return disabled;

    const canRead = habit.userId === userId || (!!habit.workspaceId && getUserWorkspaceRole(habit.workspaceId, userId));
    if (!canRead) return c.json({ error: "Habit not found", code: "NOT_FOUND" }, 404);

    const from = c.req.query("from");
    const to = c.req.query("to");
    let sql = "SELECT * FROM habit_checkins WHERE habitId = ?";
    const params: any[] = [id];
    if (from) {
        sql += " AND checkinDate >= ?";
        params.push(from);
    }
    if (to) {
        sql += " AND checkinDate <= ?";
        params.push(to);
    }
    sql += " ORDER BY checkinDate DESC, createdAt DESC";
    const rows = db.prepare(sql).all(...params);
    return c.json(rows);
});

habits.post("/:id/checkins", async (c) => {
    const db = getDb();
    const userId = c.req.header("X-User-Id")!;
    const id = c.req.param("id");
    const habit = getHabitOr404(id);
    if (!habit) return c.json({ error: "Habit not found", code: "NOT_FOUND" }, 404);
    const disabled = rejectDisabledHabitFeature(c, habit.workspaceId);
    if (disabled) return disabled;
    if (!canManageResource(habit.userId, habit.workspaceId, userId)) {
        return c.json({ error: "无权修改该习惯", code: "FORBIDDEN" }, 403);
    }

    const body = await c.req.json();
    const status = body.status as HabitStatus;
    if (!STATUS_SET.has(status)) {
        return c.json({ error: "Invalid status", code: "INVALID_STATUS" }, 400);
    }

    const checkinDate = normalizeCheckinDate(body.checkinDate);
    const note = typeof body.note === "string" ? body.note : "";
    const existing = db.prepare(
        "SELECT id FROM habit_checkins WHERE habitId = ? AND checkinDate = ?"
    ).get(id, checkinDate) as { id: string } | undefined;

    if (existing) {
        db.prepare(
            "UPDATE habit_checkins SET status = ?, note = ?, updatedAt = datetime('now') WHERE id = ?"
        ).run(status, note, existing.id);
    } else {
        db.prepare(`
      INSERT INTO habit_checkins (id, habitId, userId, workspaceId, checkinDate, status, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), id, habit.userId, habit.workspaceId, checkinDate, status, note);
    }

    const row = db.prepare(
        "SELECT * FROM habit_checkins WHERE habitId = ? AND checkinDate = ?"
    ).get(id, checkinDate);
    return c.json(row, existing ? 200 : 201);
});

habits.put("/:id", async (c) => {
    const db = getDb();
    const userId = c.req.header("X-User-Id")!;
    const id = c.req.param("id");
    const habit = getHabitOr404(id);
    if (!habit) return c.json({ error: "Habit not found", code: "NOT_FOUND" }, 404);
    const disabled = rejectDisabledHabitFeature(c, habit.workspaceId);
    if (disabled) return disabled;
    if (!canManageResource(habit.userId, habit.workspaceId, userId)) {
        return c.json({ error: "无权修改该习惯", code: "FORBIDDEN" }, 403);
    }

    const body = await c.req.json();
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : habit.title;
    const icon = typeof body.icon === "string" && body.icon.trim() ? body.icon.trim() : habit.icon;
    const color = typeof body.color === "string" && body.color.trim() ? body.color.trim() : habit.color;
    const sortOrder = Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : habit.sortOrder;

    db.prepare(`
    UPDATE habits
    SET title = ?, icon = ?, color = ?, sortOrder = ?, updatedAt = datetime('now')
    WHERE id = ?
  `).run(title, icon, color, sortOrder, id);

    const updated = db.prepare("SELECT * FROM habits WHERE id = ?").get(id);
    return c.json(updated);
});

habits.patch("/:id/archive", async (c) => {
    const db = getDb();
    const userId = c.req.header("X-User-Id")!;
    const id = c.req.param("id");
    const habit = getHabitOr404(id);
    if (!habit) return c.json({ error: "Habit not found", code: "NOT_FOUND" }, 404);
    const disabled = rejectDisabledHabitFeature(c, habit.workspaceId);
    if (disabled) return disabled;
    if (!canManageResource(habit.userId, habit.workspaceId, userId)) {
        return c.json({ error: "无权修改该习惯", code: "FORBIDDEN" }, 403);
    }

    const body = await c.req.json().catch(() => ({}));
    const archived = body.archived !== false;
    const archivedAt = archived ? new Date().toISOString() : null;
    db.prepare("UPDATE habits SET archivedAt = ?, updatedAt = datetime('now') WHERE id = ?").run(archivedAt, id);
    const updated = db.prepare("SELECT * FROM habits WHERE id = ?").get(id);
    return c.json(updated);
});

export default habits;