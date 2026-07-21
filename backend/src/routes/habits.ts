import { Hono } from "hono";
import type { Context } from "hono";
import crypto from "crypto";
import { getDb } from "../db/schema";
import {
    getClientMutationAt,
    hasNewerFieldClock,
    getIdempotentMutation,
    getNewerFields,
    getTombstone,
    saveIdempotentMutation,
    writeFieldClocks,
    writeTombstone,
} from "../lib/offlineResourceSync";
import {
    canManageResource,
    getUserWorkspaceRole,
    isFeatureEnabled,
    requireWorkspaceFeature,
    resolveWorkspaceFeatures,
} from "../middleware/acl";

const habits = new Hono();

type HabitStatus = "success" | "partial" | "failure";

type HabitRecord = {
    id: string;
    userId: string;
    workspaceId: string | null;
    title: string;
    icon: string;
    color: string;
    sortOrder: number;
    archivedAt: string | null;
    createdAt?: string;
    updatedAt?: string;
};

type HabitListRecord = HabitRecord & {
    creatorName?: string | null;
    todayStatus?: HabitStatus | null;
    todayNote?: string | null;
    todayCheckinDate?: string | null;
};

type HabitCheckinListRecord = {
    id: string;
    habitId: string;
    userId: string;
    workspaceId: string | null;
    checkinDate: string;
    status: HabitStatus;
    note: string;
    createdAt: string;
    updatedAt: string;
    habitTitle: string;
    habitColor: string;
    habitIcon: string;
    habitArchivedAt: string | null;
    creatorName?: string | null;
};

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

function isValidDateKey(raw: unknown): raw is string {
    if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
    const [year, month, day] = raw.split("-").map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year
        && parsed.getUTCMonth() === month - 1
        && parsed.getUTCDate() === day;
}

/** Missing dates mean today; malformed or impossible dates are rejected. */
function normalizeCheckinDate(raw: unknown): string | null {
    if (raw === undefined || raw === null || raw === "") return getLocalDateKey();
    return isValidDateKey(raw) ? raw : null;
}

function getQueryCheckinDate(c: Context): string | null {
    return normalizeCheckinDate(c.req.query("checkinDate") ?? c.req.query("today"));
}

function invalidDate(c: Context) {
    return c.json(
        {
            error: "checkinDate must be a valid calendar date in YYYY-MM-DD format",
            code: "INVALID_DATE",
        },
        400,
    );
}

function canCreateInWorkspace(workspaceId: string | null, userId: string): boolean {
    if (!workspaceId) return true;
    const role = getUserWorkspaceRole(workspaceId, userId) as string | null;
    return !!role && (ROLE_RANK[role] ?? 0) >= ROLE_RANK.editor;
}

function canCreateAgainstHabitTombstone(
    tombstone: { userId: string; workspaceId: string | null } | undefined,
    workspaceId: string | null,
    userId: string,
): boolean {
    if (!tombstone || tombstone.workspaceId !== workspaceId) return false;
    if (!workspaceId) return tombstone.userId === userId;
    return canCreateInWorkspace(workspaceId, userId);
}

function canReadHabitTombstone(
    tombstone: { userId: string; workspaceId: string | null } | undefined,
    userId: string,
): boolean {
    if (!tombstone) return false;
    if (!tombstone.workspaceId) return tombstone.userId === userId;
    return !!getUserWorkspaceRole(tombstone.workspaceId, userId);
}

function getHabitOr404(id: string): HabitRecord | undefined {
    const db = getDb();
    return db.prepare("SELECT * FROM habits WHERE id = ?").get(id) as HabitRecord | undefined;
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
    if (!today) return invalidDate(c);

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
    const params: unknown[] = [today];
    if (scope.scope === "workspace") {
        sql += "habits.workspaceId = ?";
        params.push(scope.workspaceId);
    } else {
        sql += "habits.userId = ? AND habits.workspaceId IS NULL";
        params.push(userId);
    }
    if (!includeArchived) sql += " AND habits.archivedAt IS NULL";
    sql += " ORDER BY habits.sortOrder ASC, habits.createdAt DESC";

    const rows = db.prepare(sql).all(...params) as HabitListRecord[];
    return c.json(rows.map((row) => ({
        ...row,
        canManage: canManageResource(row.userId, row.workspaceId, userId),
    })));
});

habits.get("/stats", requireWorkspaceFeature("tasks"), (c) => {
    const db = getDb();
    const userId = c.req.header("X-User-Id")!;
    // Statistics represent historical progress. Archived habits remain included by default;
    // callers may explicitly request active-only statistics with includeArchived=0.
    const includeArchived = c.req.query("includeArchived") !== "0";
    const today = getQueryCheckinDate(c);
    if (!today) return invalidDate(c);

    const scope = resolveHabitScope(c, userId);
    if (scope.error) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);

    const whereParts: string[] = [];
    const params: unknown[] = [];
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
  `).get(...params) as {
        totalCheckins?: number | null;
        checkinDays?: number | null;
        successCount?: number | null;
        partialCount?: number | null;
        failureCount?: number | null;
    } | undefined;

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

habits.get("/checkins", requireWorkspaceFeature("tasks"), (c) => {
    const db = getDb();
    const userId = c.req.header("X-User-Id")!;
    const scope = resolveHabitScope(c, userId);
    if (scope.error) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);

    const from = c.req.query("from");
    const to = c.req.query("to");
    const includeArchived = c.req.query("includeArchived") !== "0";
    if ((from && !isValidDateKey(from)) || (to && !isValidDateKey(to))) return invalidDate(c);
    if (from && to && from > to) {
        return c.json({ error: "from must not be later than to", code: "INVALID_DATE_RANGE" }, 400);
    }

    const params: unknown[] = [];
    const whereParts: string[] = [];
    if (scope.scope === "workspace") {
        whereParts.push("h.workspaceId = ?");
        params.push(scope.workspaceId);
    } else {
        whereParts.push("h.userId = ?", "h.workspaceId IS NULL");
        params.push(userId);
    }
    if (!includeArchived) whereParts.push("h.archivedAt IS NULL");
    if (from) {
        whereParts.push("hc.checkinDate >= ?");
        params.push(from);
    }
    if (to) {
        whereParts.push("hc.checkinDate <= ?");
        params.push(to);
    }

    const rows = db.prepare(`
      SELECT
        hc.*,
        h.title AS habitTitle,
        h.color AS habitColor,
        h.icon AS habitIcon,
        h.archivedAt AS habitArchivedAt,
        users.username AS creatorName
      FROM habit_checkins hc
      INNER JOIN habits h ON h.id = hc.habitId
      LEFT JOIN users ON users.id = h.userId
      WHERE ${whereParts.join(" AND ")}
      ORDER BY hc.checkinDate DESC, h.sortOrder ASC, hc.createdAt DESC
    `).all(...params) as HabitCheckinListRecord[];

    return c.json(rows.map((row) => ({
        ...row,
        canManage: canManageResource(row.userId, row.workspaceId, userId),
    })));
});

habits.post("/", requireWorkspaceFeature("tasks"), async (c) => {
    const db = getDb();
    const userId = c.req.header("X-User-Id")!;
    const operationId = c.req.header("Idempotency-Key");
    const replay = getIdempotentMutation(db, userId, operationId);
    if (replay) return c.json(replay, 200);
    const clientUpdatedAt = getClientMutationAt(c.req.header("X-Client-Mutation-At"));
    const body = await c.req.json();
    const scope = resolveHabitScope(c, userId);
    if (scope.error) return c.json({ error: scope.error, code: "FORBIDDEN" }, 403);
    if (!canCreateInWorkspace(scope.workspaceId, userId)) {
        return c.json({ error: "无权创建习惯", code: "FORBIDDEN" }, 403);
    }

    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) return c.json({ error: "Title is required", code: "BAD_REQUEST" }, 400);

    const requestedId = typeof body.id === "string" ? body.id : "";
    if (requestedId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedId)) {
        return c.json({ error: "Invalid habit id", code: "INVALID_HABIT_ID" }, 400);
    }
    const id = requestedId || crypto.randomUUID();
    if (requestedId) {
        const tombstone = getTombstone(db, "habit", id);
        if (tombstone && canCreateAgainstHabitTombstone(tombstone, scope.workspaceId, userId) && clientUpdatedAt <= tombstone.deletedAt) {
            return c.json({ success: true, syncIgnored: true }, 200);
        }
        const existing = db.prepare("SELECT * FROM habits WHERE id = ?").get(id) as HabitListRecord | undefined;
        if (existing) {
            if (existing.userId !== userId || existing.workspaceId !== scope.workspaceId) {
                return c.json({ error: "Habit id already exists", code: "HABIT_ID_CONFLICT" }, 409);
            }
            const response = { ...existing, canManage: true };
            saveIdempotentMutation(db, userId, operationId, response);
            return c.json(response, 201);
        }
    }
    const icon = typeof body.icon === "string" && body.icon.trim() ? body.icon.trim() : "check-circle";
    const color = typeof body.color === "string" && body.color.trim() ? body.color.trim() : "#10b981";
    const sortOrder = Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : 0;

        const response = db.transaction(() => {
                db.prepare(`
                    INSERT INTO habits (id, userId, workspaceId, title, icon, color, sortOrder)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `).run(id, userId, scope.workspaceId, title, icon, color, sortOrder);
                const created = db.prepare(`
                    SELECT habits.*, users.username AS creatorName
                    FROM habits
                    LEFT JOIN users ON users.id = habits.userId
                    WHERE habits.id = ?
                `).get(id) as HabitListRecord;
                const result = { ...created, canManage: true };
                writeFieldClocks(db, "habit", id, ["title", "icon", "color", "sortOrder", "archivedAt"], clientUpdatedAt, operationId);
                saveIdempotentMutation(db, userId, operationId, result);
                return result;
        })();
        return c.json(response, 201);
});

habits.get("/:id/checkins", (c) => {
    const db = getDb();
    const userId = c.req.header("X-User-Id")!;
    const id = c.req.param("id");
    const habit = getHabitOr404(id);
    if (!habit) {
        const tombstone = getTombstone(db, "habit", id);
        const canReadTombstone = canReadHabitTombstone(tombstone, userId);
        if (canReadTombstone) {
            return c.json({ success: true, syncIgnored: true });
        }
        return c.json({ error: "Habit not found", code: "NOT_FOUND" }, 404);
    }
    const disabled = rejectDisabledHabitFeature(c, habit.workspaceId);
    if (disabled) return disabled;

    const canRead = habit.userId === userId || (!!habit.workspaceId && getUserWorkspaceRole(habit.workspaceId, userId));
    if (!canRead) return c.json({ error: "Habit not found", code: "NOT_FOUND" }, 404);

    const from = c.req.query("from");
    const to = c.req.query("to");
    if ((from && !isValidDateKey(from)) || (to && !isValidDateKey(to))) return invalidDate(c);
    if (from && to && from > to) {
        return c.json({ error: "from must not be later than to", code: "INVALID_DATE_RANGE" }, 400);
    }

    let sql = "SELECT * FROM habit_checkins WHERE habitId = ?";
    const params: unknown[] = [id];
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
    const operationId = c.req.header("Idempotency-Key");
    const replay = getIdempotentMutation(db, userId, operationId);
    if (replay) return c.json(replay, 200);
    const clientUpdatedAt = getClientMutationAt(c.req.header("X-Client-Mutation-At"));
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
    if (!checkinDate) return invalidDate(c);
    const note = typeof body.note === "string" ? body.note : "";
    const checkinResourceId = `${id}:${checkinDate}`;
    const accepted = getNewerFields(db, "habitCheckin", checkinResourceId, ["status", "note"], clientUpdatedAt, operationId);
    const existing = db.prepare(
        "SELECT id FROM habit_checkins WHERE habitId = ? AND checkinDate = ?",
    ).get(id, checkinDate) as { id: string } | undefined;

    const row = db.transaction(() => {
        if (existing && accepted.size > 0) {
            const current = db.prepare("SELECT status, note FROM habit_checkins WHERE id = ?").get(existing.id) as { status: HabitStatus; note: string };
            db.prepare(
                "UPDATE habit_checkins SET userId = ?, status = ?, note = ?, updatedAt = datetime('now') WHERE id = ?",
            ).run(userId, accepted.has("status") ? status : current.status, accepted.has("note") ? note : current.note, existing.id);
        } else if (!existing) {
            db.prepare(`
              INSERT INTO habit_checkins (id, habitId, userId, workspaceId, checkinDate, status, note)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(crypto.randomUUID(), id, userId, habit.workspaceId, checkinDate, status, note);
        }
        const current = db.prepare(
            "SELECT * FROM habit_checkins WHERE habitId = ? AND checkinDate = ?",
        ).get(id, checkinDate) as Record<string, unknown>;
        if (!existing || accepted.size > 0) writeFieldClocks(db, "habitCheckin", checkinResourceId, ["status", "note"], clientUpdatedAt, operationId);
        saveIdempotentMutation(db, userId, operationId, current);
        return current;
    })();
    return c.json(row, existing ? 200 : 201);
});

habits.put("/:id", async (c) => {
    const db = getDb();
    const userId = c.req.header("X-User-Id")!;
    const id = c.req.param("id");
    const operationId = c.req.header("Idempotency-Key");
    const replay = getIdempotentMutation(db, userId, operationId);
    if (replay) return c.json(replay, 200);
    const clientUpdatedAt = getClientMutationAt(c.req.header("X-Client-Mutation-At"));
    const habit = getHabitOr404(id);
    if (!habit) return c.json({ error: "Habit not found", code: "NOT_FOUND" }, 404);
    const disabled = rejectDisabledHabitFeature(c, habit.workspaceId);
    if (disabled) return disabled;
    if (!canManageResource(habit.userId, habit.workspaceId, userId)) {
        return c.json({ error: "无权修改该习惯", code: "FORBIDDEN" }, 403);
    }

    const body = await c.req.json();
    const requestedFields = ["title", "icon", "color", "sortOrder"].filter((field) => Object.prototype.hasOwnProperty.call(body, field));
    const accepted = getNewerFields(db, "habit", id, requestedFields, clientUpdatedAt, operationId);
    const title = accepted.has("title") && typeof body.title === "string" && body.title.trim() ? body.title.trim() : habit.title;
    const icon = accepted.has("icon") && typeof body.icon === "string" && body.icon.trim() ? body.icon.trim() : habit.icon;
    const color = accepted.has("color") && typeof body.color === "string" && body.color.trim() ? body.color.trim() : habit.color;
    const sortOrder = accepted.has("sortOrder") && Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : habit.sortOrder;

        const updated = db.transaction(() => {
                db.prepare(`
                    UPDATE habits
                    SET title = ?, icon = ?, color = ?, sortOrder = ?, updatedAt = datetime('now')
                    WHERE id = ?
                `).run(title, icon, color, sortOrder, id);
                const current = db.prepare("SELECT * FROM habits WHERE id = ?").get(id) as Record<string, unknown>;
                writeFieldClocks(db, "habit", id, accepted, clientUpdatedAt, operationId);
                saveIdempotentMutation(db, userId, operationId, current);
                return current;
        })();
    return c.json(updated);
});

habits.patch("/:id/archive", async (c) => {
    const db = getDb();
    const userId = c.req.header("X-User-Id")!;
    const id = c.req.param("id");
    const operationId = c.req.header("Idempotency-Key");
    const replay = getIdempotentMutation(db, userId, operationId);
    if (replay) return c.json(replay, 200);
    const clientUpdatedAt = getClientMutationAt(c.req.header("X-Client-Mutation-At"));
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
    const accepted = getNewerFields(db, "habit", id, ["archivedAt"], clientUpdatedAt, operationId);
    const updated = db.transaction(() => {
        if (accepted.has("archivedAt")) {
            db.prepare("UPDATE habits SET archivedAt = ?, updatedAt = datetime('now') WHERE id = ?").run(archivedAt, id);
            writeFieldClocks(db, "habit", id, accepted, clientUpdatedAt, operationId);
        }
        const current = db.prepare("SELECT * FROM habits WHERE id = ?").get(id) as Record<string, unknown>;
        saveIdempotentMutation(db, userId, operationId, current);
        return current;
    })();
    return c.json(updated);
});

habits.delete("/:id", async (c) => {
    const db = getDb();
    const userId = c.req.header("X-User-Id")!;
    const id = c.req.param("id");
    const operationId = c.req.header("Idempotency-Key");
    const replay = getIdempotentMutation(db, userId, operationId);
    if (replay) return c.json(replay, 200);
    const clientUpdatedAt = getClientMutationAt(c.req.header("X-Client-Mutation-At"));
    const habit = getHabitOr404(id);
    if (!habit) return c.json({ error: "Habit not found", code: "NOT_FOUND" }, 404);
    const disabled = rejectDisabledHabitFeature(c, habit.workspaceId);
    if (disabled) return disabled;
    if (!canManageResource(habit.userId, habit.workspaceId, userId)) {
        return c.json({ error: "无权删除该习惯", code: "FORBIDDEN" }, 403);
    }
    if (hasNewerFieldClock(db, "habit", id, clientUpdatedAt)) {
        const response = { success: true, syncIgnored: true };
        saveIdempotentMutation(db, userId, operationId, response);
        return c.json(response);
    }

    const tombstone = getTombstone(db, "habit", id);
    if (!tombstone || clientUpdatedAt >= tombstone.deletedAt) {
        db.transaction(() => {
            writeTombstone(db, "habit", id, habit.userId, habit.workspaceId, clientUpdatedAt);
            db.prepare("DELETE FROM habits WHERE id = ?").run(id);
            saveIdempotentMutation(db, userId, operationId, { success: true });
        })();
        return c.json({ success: true });
    }
    const response = { success: true };
    saveIdempotentMutation(db, userId, operationId, response);
    return c.json(response);
});

export default habits;
