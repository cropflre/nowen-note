import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { closeDb, getDb } from "../src/db/schema";
import taskDayPlans, {
  isTaskDayPlanDate,
  normalizeTaskDayPlanIds,
} from "../src/routes/task-day-plans";

const USER_ID = "my-day-test-user";
const app = new Hono();
app.route("/user-preferences/task-day-plans", taskDayPlans);

function request(path: string, init?: RequestInit) {
  return app.request(path, {
    ...init,
    headers: {
      "X-User-Id": USER_ID,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers || {}),
    },
  });
}

test.before(() => {
  getDb().prepare(
    "INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)",
  ).run(USER_ID, USER_ID, "hash");
});

test.after(() => {
  closeDb();
});

test("task day plan date validation accepts real calendar dates", () => {
  assert.equal(isTaskDayPlanDate("2026-08-02"), true);
  assert.equal(isTaskDayPlanDate("2028-02-29"), true);
  assert.equal(isTaskDayPlanDate("2026-02-29"), false);
  assert.equal(isTaskDayPlanDate("2026-02-30"), false);
  assert.equal(isTaskDayPlanDate("2026-8-2"), false);
  assert.equal(isTaskDayPlanDate(null), false);
});

test("task day plan ids are trimmed, deduplicated and bounded", () => {
  assert.deepEqual(
    normalizeTaskDayPlanIds([" task-a ", "task-a", "", 42, "task-b", "task-c"], 2),
    ["task-a", "task-b"],
  );
});

test("task day plan ids reject oversized values", () => {
  assert.deepEqual(
    normalizeTaskDayPlanIds(["x".repeat(129), "valid-task"]),
    ["valid-task"],
  );
});

test("My Day route works without a trailing slash and persists an empty plan", async () => {
  const invalid = await request(
    "/user-preferences/task-day-plans?date=invalid&workspaceId=personal",
  );
  assert.equal(invalid.status, 400);

  const saved = await request("/user-preferences/task-day-plans", {
    method: "PUT",
    body: JSON.stringify({
      date: "2026-08-02",
      workspaceId: "personal",
      taskIds: [],
      focusTaskIds: [],
    }),
  });
  assert.equal(saved.status, 200);
  const savedPayload = await saved.json() as Record<string, unknown>;
  assert.equal(savedPayload.date, "2026-08-02");
  assert.equal(savedPayload.workspaceId, "personal");
  assert.deepEqual(savedPayload.taskIds, []);
  assert.deepEqual(savedPayload.focusTaskIds, []);
  assert.equal(typeof savedPayload.updatedAt, "string");

  const loaded = await request(
    "/user-preferences/task-day-plans?date=2026-08-02&workspaceId=personal",
  );
  assert.equal(loaded.status, 200);
  const loadedPayload = await loaded.json() as Record<string, unknown>;
  assert.equal(loadedPayload.date, "2026-08-02");
  assert.equal(loadedPayload.workspaceId, "personal");
  assert.deepEqual(loadedPayload.taskIds, []);
  assert.deepEqual(loadedPayload.focusTaskIds, []);
  assert.equal(loadedPayload.updatedAt, savedPayload.updatedAt);
});
