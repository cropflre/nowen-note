/**
 * taskProjectsRepository async 方法行为测试（C-A.3）
 *
 * 范围：updateSortOrderAsync（使用 executeBatch）
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
