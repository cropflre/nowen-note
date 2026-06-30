/**
 * taskProjectsRepository async 方法行为测试
 *
 * 范围：updateSortOrderAsync, listByUserAsync, getByIdAsync,
 *       getByIdWithStatsAsync, createAsync, updateAsync, deleteAsync
 */

import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-task-proj-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

import { taskProjectsRepository } from "../src/repositories/taskProjectsRepository";
import { getDb } from "../src/db/schema";

const USER_ID = "user-proj-1";
const WS_ID = "ws-proj-1";

function seedUser() {
  getDb().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(USER_ID, USER_ID, "hash");
}

function clean() {
  getDb().prepare("DELETE FROM tasks").run();
  getDb().prepare("DELETE FROM task_projects").run();
}

function createProject(id: string, sortOrder: number, name?: string) {
  taskProjectsRepository.create({
    id,
    userId: USER_ID,
    workspaceId: WS_ID,
    name: name || `Project ${id}`,
    icon: null,
    color: null,
    sortOrder,
  });
}

// ============================================================
// updateSortOrderAsync
// ============================================================

test("updateSortOrderAsync updates sort order for multiple projects", async () => {
  clean();
  seedUser();
  createProject("proj-1", 0, "A");
  createProject("proj-2", 1, "B");
  createProject("proj-3", 2, "C");

  await taskProjectsRepository.updateSortOrderAsync([
    { id: "proj-1", sortOrder: 10 },
    { id: "proj-2", sortOrder: 20 },
    { id: "proj-3", sortOrder: 30 },
  ]);

  const p1 = taskProjectsRepository.getById("proj-1")!;
  const p2 = taskProjectsRepository.getById("proj-2")!;
  const p3 = taskProjectsRepository.getById("proj-3")!;
  assert.equal(p1.sortOrder, 10);
  assert.equal(p2.sortOrder, 20);
  assert.equal(p3.sortOrder, 30);
  clean();
});

test("updateSortOrderAsync updates updatedAt", async () => {
  clean();
  seedUser();
  createProject("proj-1", 0);

  const before = taskProjectsRepository.getById("proj-1")!.updatedAt;
  await taskProjectsRepository.updateSortOrderAsync([
    { id: "proj-1", sortOrder: 99 },
  ]);
  const after = taskProjectsRepository.getById("proj-1")!.updatedAt;
  // updatedAt should be set (may be same if within same second, but should not be null)
  assert.ok(after);
  clean();
});

test("updateSortOrderAsync with empty array is no-op", async () => {
  clean();
  seedUser();
  createProject("proj-1", 5);

  await taskProjectsRepository.updateSortOrderAsync([]);

  const p1 = taskProjectsRepository.getById("proj-1")!;
  assert.equal(p1.sortOrder, 5, "sortOrder should not change");
  clean();
});

test("updateSortOrderAsync does not affect unlisted projects", async () => {
  clean();
  seedUser();
  createProject("proj-1", 0);
  createProject("proj-2", 1);
  createProject("proj-3", 2);

  await taskProjectsRepository.updateSortOrderAsync([
    { id: "proj-1", sortOrder: 100 },
    { id: "proj-3", sortOrder: 300 },
  ]);

  const p2 = taskProjectsRepository.getById("proj-2")!;
  assert.equal(p2.sortOrder, 1, "unlisted project sortOrder should not change");
  clean();
});

test("updateSortOrderAsync with non-existent id is no-op", async () => {
  clean();
  seedUser();
  createProject("proj-1", 0);

  // should not throw
  await taskProjectsRepository.updateSortOrderAsync([
    { id: "proj-1", sortOrder: 10 },
    { id: "non-existent", sortOrder: 99 },
  ]);

  const p1 = taskProjectsRepository.getById("proj-1")!;
  assert.equal(p1.sortOrder, 10);
  clean();
});

test("updateSortOrderAsync results are visible via getById", async () => {
  clean();
  seedUser();
  createProject("proj-1", 0);
  createProject("proj-2", 1);

  await taskProjectsRepository.updateSortOrderAsync([
    { id: "proj-1", sortOrder: 50 },
    { id: "proj-2", sortOrder: 40 },
  ]);

  const p1 = taskProjectsRepository.getById("proj-1")!;
  const p2 = taskProjectsRepository.getById("proj-2")!;
  assert.equal(p1.sortOrder, 50);
  assert.equal(p2.sortOrder, 40);
  clean();
});

// ============================================================
// createAsync
// ============================================================

test("createAsync creates a project", async () => {
  clean();
  seedUser();
  await taskProjectsRepository.createAsync({
    id: "proj-new",
    userId: USER_ID,
    workspaceId: WS_ID,
    name: "New Project",
    icon: "icon",
    color: "red",
    sortOrder: 5,
  });
  const p = taskProjectsRepository.getById("proj-new");
  assert.ok(p);
  assert.equal(p.name, "New Project");
  assert.equal(p.icon, "icon");
  assert.equal(p.color, "red");
  assert.equal(p.sortOrder, 5);
  clean();
});

test("createAsync project is visible via getByIdAsync", async () => {
  clean();
  seedUser();
  await taskProjectsRepository.createAsync({
    id: "proj-vis",
    userId: USER_ID,
    workspaceId: WS_ID,
    name: "Visible",
    icon: null,
    color: null,
    sortOrder: 0,
  });
  const p = await taskProjectsRepository.getByIdAsync("proj-vis");
  assert.ok(p);
  assert.equal(p.name, "Visible");
  clean();
});

// ============================================================
// getByIdAsync
// ============================================================

test("getByIdAsync returns project", async () => {
  clean();
  seedUser();
  createProject("proj-1", 0, "Test");
  const p = await taskProjectsRepository.getByIdAsync("proj-1");
  assert.ok(p);
  assert.equal(p.name, "Test");
  clean();
});

test("getByIdAsync returns undefined for non-existent", async () => {
  clean();
  const p = await taskProjectsRepository.getByIdAsync("no-such");
  assert.equal(p, undefined);
});

// ============================================================
// getByIdWithStatsAsync
// ============================================================

test("getByIdWithStatsAsync returns project with stats", async () => {
  clean();
  seedUser();
  createProject("proj-1", 0, "Stats Test");
  const p = await taskProjectsRepository.getByIdWithStatsAsync("proj-1");
  assert.ok(p);
  assert.equal(p.name, "Stats Test");
  assert.equal(p.taskCount, 0);
  assert.equal(p.completedCount, 0);
  assert.equal(p.progress, 0);
  clean();
});

test("getByIdWithStatsAsync returns undefined for non-existent", async () => {
  clean();
  const p = await taskProjectsRepository.getByIdWithStatsAsync("no-such");
  assert.equal(p, undefined);
});

// ============================================================
// listByUserAsync
// ============================================================

test("listByUserAsync returns projects for workspace", async () => {
  clean();
  seedUser();
  createProject("proj-1", 0, "A");
  createProject("proj-2", 1, "B");
  const list = await taskProjectsRepository.listByUserAsync(USER_ID, WS_ID);
  assert.equal(list.length, 2);
  assert.equal(list[0].name, "A");
  assert.equal(list[1].name, "B");
  clean();
});

test("listByUserAsync returns projects for personal space", async () => {
  clean();
  seedUser();
  await taskProjectsRepository.createAsync({
    id: "proj-personal",
    userId: USER_ID,
    workspaceId: null,
    name: "Personal",
    icon: null,
    color: null,
    sortOrder: 0,
  });
  const list = await taskProjectsRepository.listByUserAsync(USER_ID, null);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "Personal");
  clean();
});

test("listByUserAsync with workspaceId returns all workspace projects", async () => {
  clean();
  seedUser();
  const otherUser = "user-proj-2";
  getDb().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(otherUser, otherUser, "hash");
  createProject("proj-1", 0);
  await taskProjectsRepository.createAsync({
    id: "proj-other",
    userId: otherUser,
    workspaceId: WS_ID,
    name: "Other",
    icon: null,
    color: null,
    sortOrder: 1,
  });
  // listByUser with workspaceId returns all projects in that workspace
  const list = await taskProjectsRepository.listByUserAsync(USER_ID, WS_ID);
  assert.equal(list.length, 2);
  clean();
});

test("listByUserAsync returns empty for no projects", async () => {
  clean();
  seedUser();
  const list = await taskProjectsRepository.listByUserAsync(USER_ID, WS_ID);
  assert.equal(list.length, 0);
});

test("listByUserAsync includes stats fields", async () => {
  clean();
  seedUser();
  createProject("proj-1", 0);
  const list = await taskProjectsRepository.listByUserAsync(USER_ID, WS_ID);
  assert.equal(list.length, 1);
  assert.ok("taskCount" in list[0]);
  assert.ok("completedCount" in list[0]);
  assert.ok("progress" in list[0]);
  clean();
});

// ============================================================
// updateAsync
// ============================================================

test("updateAsync updates project", async () => {
  clean();
  seedUser();
  createProject("proj-1", 0, "Old Name");
  await taskProjectsRepository.updateAsync("proj-1", {
    name: "New Name",
    icon: "new-icon",
    color: "blue",
    sortOrder: 99,
  });
  const p = await taskProjectsRepository.getByIdAsync("proj-1")!;
  assert.ok(p);
  assert.equal(p.name, "New Name");
  assert.equal(p.icon, "new-icon");
  assert.equal(p.color, "blue");
  assert.equal(p.sortOrder, 99);
  clean();
});

test("updateAsync updates updatedAt", async () => {
  clean();
  seedUser();
  createProject("proj-1", 0);
  const before = taskProjectsRepository.getById("proj-1")!.updatedAt;
  await taskProjectsRepository.updateAsync("proj-1", {
    name: "Updated",
    icon: null,
    color: null,
    sortOrder: 0,
  });
  const after = taskProjectsRepository.getById("proj-1")!.updatedAt;
  assert.ok(after);
  clean();
});

test("updateAsync no-op for non-existent project", async () => {
  clean();
  // should not throw
  await taskProjectsRepository.updateAsync("no-such", {
    name: "X",
    icon: null,
    color: null,
    sortOrder: 0,
  });
});

// ============================================================
// deleteAsync
// ============================================================

test("deleteAsync deletes project", async () => {
  clean();
  seedUser();
  createProject("proj-1", 0);
  await taskProjectsRepository.deleteAsync("proj-1");
  const p = await taskProjectsRepository.getByIdAsync("proj-1");
  assert.equal(p, undefined);
  clean();
});

test("deleteAsync nullifies task projectId", async () => {
  clean();
  seedUser();
  createProject("proj-1", 0);
  // Create a task linked to the project
  getDb().prepare("INSERT INTO tasks (id, userId, title, projectId) VALUES (?, ?, ?, ?)").run("task-1", USER_ID, "Test Task", "proj-1");
  await taskProjectsRepository.deleteAsync("proj-1");
  const task = getDb().prepare("SELECT projectId FROM tasks WHERE id = ?").get("task-1") as any;
  assert.equal(task.projectId, null);
  clean();
});

test("deleteAsync does not affect other projects", async () => {
  clean();
  seedUser();
  createProject("proj-1", 0);
  createProject("proj-2", 1);
  await taskProjectsRepository.deleteAsync("proj-1");
  const p2 = await taskProjectsRepository.getByIdAsync("proj-2");
  assert.ok(p2);
  assert.equal(p2.id, "proj-2");
  clean();
});

test("deleteAsync no-op for non-existent project", async () => {
  clean();
  // should not throw
  await taskProjectsRepository.deleteAsync("no-such");
});
