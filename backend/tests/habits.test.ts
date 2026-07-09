import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-habits-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;

const USER_ID = "user-habits";
const OTHER_USER_ID = "user-habits-other";

function db() {
    return getDb();
}

function seedUser() {
    db()
        .prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
        .run(USER_ID, USER_ID, "hash");
    db()
        .prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
        .run(OTHER_USER_ID, OTHER_USER_ID, "hash");
}

function resetHabits() {
    db().prepare("DELETE FROM habit_checkins").run();
    db().prepare("DELETE FROM habits").run();
    db().prepare("DELETE FROM workspace_members").run();
    db().prepare("DELETE FROM workspaces").run();
}

async function requestJson(method: string, url: string, body?: unknown) {
    const res = await app.request(url, {
        method,
        headers: {
            "X-User-Id": USER_ID,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
}

async function requestJsonAsUser(userId: string, method: string, url: string, body?: unknown) {
    const res = await app.request(url, {
        method,
        headers: {
            "X-User-Id": userId,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
}

function seedWorkspace(options?: { id?: string; enabledFeatures?: Record<string, boolean>; ownerId?: string }) {
    const id = options?.id ?? "ws-habits";
    const ownerId = options?.ownerId ?? USER_ID;
    const enabledFeatures = options?.enabledFeatures ?? {};
    db().prepare(
        "INSERT INTO workspaces (id, name, ownerId, enabledFeatures) VALUES (?, ?, ?, ?)"
    ).run(id, "Habits WS", ownerId, JSON.stringify(enabledFeatures));
    db().prepare(
        "INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, 'owner')"
    ).run(id, ownerId);
    return id;
}

function addWorkspaceMember(workspaceId: string, userId: string, role: "admin" | "editor" | "commenter" | "viewer") {
    db().prepare(
        "INSERT INTO workspace_members (workspaceId, userId, role) VALUES (?, ?, ?)"
    ).run(workspaceId, userId, role);
}

function formatDateKey(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

test.before(async () => {
    const [habitsModule, schemaModule] = await Promise.all([
        import("../src/routes/habits"),
        import("../src/db/schema"),
    ]);
    app = new Hono();
    app.route("/habits", habitsModule.default);
    getDb = schemaModule.getDb;
    closeDb = schemaModule.closeDb;
    seedUser();
});

test.beforeEach(() => {
    resetHabits();
});

test.after(async () => {
    closeDb();
    for (let i = 0; i < 5; i++) {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
            return;
        } catch (err: any) {
            if (err?.code !== "EBUSY") throw err;
            if (i === 4) return;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }
});

test("create habit and list active habits", async () => {
    const created = await requestJson("POST", "/habits", { title: "Read 10 pages" });

    assert.equal(created.status, 201);
    assert.equal(created.json.title, "Read 10 pages");

    const listed = await requestJson("GET", "/habits");
    assert.equal(listed.status, 200);
    assert.equal(listed.json.length, 1);
    assert.equal(listed.json[0].title, "Read 10 pages");
});

test("daily checkin upserts same day record and stores note", async () => {
    const created = await requestJson("POST", "/habits", { title: "Meditate" });
    const today = formatDateKey(new Date());

    const first = await requestJson("POST", `/habits/${created.json.id}/checkins`, {
        checkinDate: today,
        status: "success",
        note: "Morning session",
    });
    assert.equal(first.status, 201);
    assert.equal(first.json.note, "Morning session");

    const second = await requestJson("POST", `/habits/${created.json.id}/checkins`, {
        checkinDate: today,
        status: "partial",
        note: "Only 5 minutes",
    });
    assert.equal(second.status, 200);
    assert.equal(second.json.status, "partial");
    assert.equal(second.json.note, "Only 5 minutes");

    const count = db()
        .prepare("SELECT COUNT(*) AS count FROM habit_checkins WHERE habitId = ?")
        .get(created.json.id) as { count: number };
    assert.equal(count.count, 1);

    const listed = await requestJson("GET", "/habits");
    assert.equal(listed.status, 200);
    assert.equal(listed.json[0].todayStatus, "partial");
    assert.equal(listed.json[0].todayNote, "Only 5 minutes");
    assert.equal(listed.json[0].todayCheckinDate, today);
});

test("client checkin date drives list today status and stats streak", async () => {
    const created = await requestJson("POST", "/habits", { title: "Drink water" });
    const clientDate = "2099-12-31";
    const previousDate = "2099-12-30";

    await requestJson("POST", `/habits/${created.json.id}/checkins`, {
        checkinDate: previousDate,
        status: "success",
    });
    const checked = await requestJson("POST", `/habits/${created.json.id}/checkins`, {
        checkinDate: clientDate,
        status: "partial",
        note: "Client-local day",
    });
    assert.equal(checked.status, 201);

    const listed = await requestJson("GET", `/habits?checkinDate=${clientDate}`);
    assert.equal(listed.status, 200);
    assert.equal(listed.json[0].todayStatus, "partial");
    assert.equal(listed.json[0].todayNote, "Client-local day");
    assert.equal(listed.json[0].todayCheckinDate, clientDate);

    const stats = await requestJson("GET", `/habits/stats?checkinDate=${clientDate}`);
    assert.equal(stats.status, 200);
    assert.equal(stats.json.totalCheckins, 2);
    assert.equal(stats.json.currentStreak, 2);
    assert.equal(stats.json.successCount, 1);
    assert.equal(stats.json.partialCount, 1);
});

test("checkin history filters by date range", async () => {
    const created = await requestJson("POST", "/habits", { title: "Journal" });

    await requestJson("POST", `/habits/${created.json.id}/checkins`, {
        checkinDate: "2026-07-07",
        status: "success",
    });
    await requestJson("POST", `/habits/${created.json.id}/checkins`, {
        checkinDate: "2026-07-08",
        status: "partial",
    });
    await requestJson("POST", `/habits/${created.json.id}/checkins`, {
        checkinDate: "2026-07-09",
        status: "failure",
    });

    const filtered = await requestJson("GET", `/habits/${created.json.id}/checkins?from=2026-07-08&to=2026-07-08`);
    assert.equal(filtered.status, 200);
    assert.deepEqual(filtered.json.map((item: any) => item.checkinDate), ["2026-07-08"]);
});

test("archive hides habit from active list but keeps history", async () => {
    const created = await requestJson("POST", "/habits", { title: "Walk" });
    await requestJson("POST", `/habits/${created.json.id}/checkins`, {
        checkinDate: "2026-07-09",
        status: "failure",
        note: "Rain",
    });

    const archived = await requestJson("PATCH", `/habits/${created.json.id}/archive`, { archived: true });
    assert.equal(archived.status, 200);
    assert.ok(archived.json.archivedAt);

    const activeList = await requestJson("GET", "/habits");
    assert.equal(activeList.status, 200);
    assert.equal(activeList.json.length, 0);

    const fullList = await requestJson("GET", "/habits?includeArchived=1");
    assert.equal(fullList.status, 200);
    assert.equal(fullList.json.length, 1);

    const history = await requestJson("GET", `/habits/${created.json.id}/checkins`);
    assert.equal(history.status, 200);
    assert.equal(history.json.length, 1);
    assert.equal(history.json[0].status, "failure");
});

test("stats summary counts totals and current streak from success partial only", async () => {
    const first = await requestJson("POST", "/habits", { title: "Read" });
    const second = await requestJson("POST", "/habits", { title: "Run" });

    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const twoDaysAgo = new Date(today);
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

    await requestJson("POST", `/habits/${first.json.id}/checkins`, {
        checkinDate: formatDateKey(twoDaysAgo),
        status: "success",
    });
    await requestJson("POST", `/habits/${first.json.id}/checkins`, {
        checkinDate: formatDateKey(yesterday),
        status: "partial",
    });
    await requestJson("POST", `/habits/${second.json.id}/checkins`, {
        checkinDate: formatDateKey(today),
        status: "failure",
    });
    await requestJson("POST", `/habits/${first.json.id}/checkins`, {
        checkinDate: formatDateKey(today),
        status: "success",
    });

    const stats = await requestJson("GET", "/habits/stats");
    assert.equal(stats.status, 200);
    assert.equal(stats.json.totalCheckins, 4);
    assert.equal(stats.json.checkinDays, 3);
    assert.equal(stats.json.successCount, 2);
    assert.equal(stats.json.partialCount, 1);
    assert.equal(stats.json.failureCount, 1);
    assert.equal(stats.json.currentStreak, 3);
});

test("workspace feature flag tasks=false blocks collection habit endpoints", async () => {
    const workspaceId = seedWorkspace({ id: "ws-disabled", enabledFeatures: { tasks: false } });

    const listed = await requestJson("GET", `/habits?workspaceId=${workspaceId}`);
    assert.equal(listed.status, 403);
    assert.equal(listed.json.code, "FEATURE_DISABLED");

    const stats = await requestJson("GET", `/habits/stats?workspaceId=${workspaceId}`);
    assert.equal(stats.status, 403);
    assert.equal(stats.json.code, "FEATURE_DISABLED");

    const created = await requestJson("POST", `/habits?workspaceId=${workspaceId}`, { title: "Nope" });
    assert.equal(created.status, 403);
    assert.equal(created.json.code, "FEATURE_DISABLED");
});

test("workspace feature flag tasks=false blocks existing habit item endpoints", async () => {
    const workspaceId = seedWorkspace({ id: "ws-disabled-item" });
    const created = await requestJson("POST", `/habits?workspaceId=${workspaceId}`, { title: "Existing habit" });
    assert.equal(created.status, 201);

    db().prepare("UPDATE workspaces SET enabledFeatures = ? WHERE id = ?")
        .run(JSON.stringify({ tasks: false }), workspaceId);

    const history = await requestJson("GET", `/habits/${created.json.id}/checkins`);
    assert.equal(history.status, 403);
    assert.equal(history.json.code, "FEATURE_DISABLED");

    const checkin = await requestJson("POST", `/habits/${created.json.id}/checkins`, {
        checkinDate: "2026-07-09",
        status: "success",
    });
    assert.equal(checkin.status, 403);
    assert.equal(checkin.json.code, "FEATURE_DISABLED");

    const updated = await requestJson("PUT", `/habits/${created.json.id}`, {
        title: "Edited while disabled",
    });
    assert.equal(updated.status, 403);
    assert.equal(updated.json.code, "FEATURE_DISABLED");

    const archived = await requestJson("PATCH", `/habits/${created.json.id}/archive`, {
        archived: true,
    });
    assert.equal(archived.status, 403);
    assert.equal(archived.json.code, "FEATURE_DISABLED");
});

test("non owner admin cannot modify workspace habit", async () => {
    const workspaceId = seedWorkspace({ id: "ws-perm" });
    addWorkspaceMember(workspaceId, OTHER_USER_ID, "editor");

    const created = await requestJson("POST", `/habits?workspaceId=${workspaceId}`, { title: "Shared habit" });
    assert.equal(created.status, 201);

    const checkin = await requestJsonAsUser(OTHER_USER_ID, "POST", `/habits/${created.json.id}/checkins`, {
        checkinDate: "2026-07-09",
        status: "success",
    });
    assert.equal(checkin.status, 403);

    const updated = await requestJsonAsUser(OTHER_USER_ID, "PUT", `/habits/${created.json.id}`, {
        title: "Edited by editor",
    });
    assert.equal(updated.status, 403);

    const archived = await requestJsonAsUser(OTHER_USER_ID, "PATCH", `/habits/${created.json.id}/archive`, {
        archived: true,
    });
    assert.equal(archived.status, 403);
});