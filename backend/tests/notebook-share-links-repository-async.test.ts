/**
 * notebookShareLinksRepository async 方法行为测试
 */

import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-share-links-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

import { notebookShareLinksRepository } from "../src/repositories/notebookShareLinksRepository";
import { getDb } from "../src/db/schema";

const USER_ID = "user-sl";
const NB_ID = "nb-sl";

function seedBase() {
  getDb().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(USER_ID, USER_ID, "hash");
  getDb().prepare("INSERT OR IGNORE INTO notebooks (id, userId, name) VALUES (?, ?, ?)").run(NB_ID, USER_ID, "Test NB");
}

function clean() {
  getDb().prepare("DELETE FROM notebook_share_links").run();
}

function seedLink(overrides: Partial<{ id: string; token: string; role: string; enabled: number; expiresAt: string | null }> = {}) {
  const id = overrides.id ?? `link-${Date.now()}`;
  const token = overrides.token ?? `tok-${Date.now()}`;
  const role = overrides.role ?? "viewer";
  const enabled = overrides.enabled ?? 1;
  const expiresAt = overrides.expiresAt ?? null;
  getDb().prepare(
    `INSERT INTO notebook_share_links (id, notebookId, token, role, enabled, expiresAt, createdBy)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, NB_ID, token, role, enabled, expiresAt, USER_ID);
  return { id, token, role, enabled, expiresAt };
}

test("createAsync inserts link", async () => {
  clean();
  seedBase();
  await notebookShareLinksRepository.createAsync({
    id: "link-create", notebookId: NB_ID, token: "tok-create", role: "editor", expiresAt: null, createdBy: USER_ID,
  });
  const row = getDb().prepare("SELECT * FROM notebook_share_links WHERE id = ?").get("link-create") as any;
  assert.ok(row);
  assert.equal(row.role, "editor");
  assert.equal(row.enabled, 1);
  clean();
});

test("getByIdAsync returns link", async () => {
  clean();
  seedBase();
  seedLink({ id: "link-find" });
  const row = await notebookShareLinksRepository.getByIdAsync("link-find");
  assert.ok(row);
  assert.equal(row.id, "link-find");
  clean();
});

test("getByIdAsync returns undefined when not found", async () => {
  clean();
  const row = await notebookShareLinksRepository.getByIdAsync("nonexistent");
  assert.equal(row, undefined);
});

test("getLatestEnabledByNotebookAsync returns latest enabled", async () => {
  clean();
  seedBase();
  seedLink({ id: "link-old", token: "tok-old", enabled: 1 });
  getDb().prepare("UPDATE notebook_share_links SET createdAt = datetime('now', '-10 seconds') WHERE id = ?").run("link-old");
  seedLink({ id: "link-new", token: "tok-new", enabled: 1 });
  const row = await notebookShareLinksRepository.getLatestEnabledByNotebookAsync(NB_ID);
  assert.ok(row);
  assert.equal(row.id, "link-new");
  clean();
});

test("getLatestEnabledByNotebookAsync skips disabled", async () => {
  clean();
  seedBase();
  seedLink({ id: "link-dis", token: "tok-dis", enabled: 0 });
  const row = await notebookShareLinksRepository.getLatestEnabledByNotebookAsync(NB_ID);
  assert.equal(row, undefined);
  clean();
});

test("disableAllByNotebookAsync disables all links", async () => {
  clean();
  seedBase();
  seedLink({ id: "link-d1", token: "tok-d1" });
  seedLink({ id: "link-d2", token: "tok-d2" });
  await notebookShareLinksRepository.disableAllByNotebookAsync(NB_ID);
  const rows = getDb().prepare("SELECT enabled FROM notebook_share_links WHERE notebookId = ?").all(NB_ID) as any[];
  assert.ok(rows.every((r: any) => r.enabled === 0));
  clean();
});

test("updateAsync updates allowed fields", async () => {
  clean();
  seedBase();
  seedLink({ id: "link-upd", token: "tok-upd" });
  await notebookShareLinksRepository.updateAsync("link-upd", { role: "editor", enabled: 0 });
  const row = getDb().prepare("SELECT role, enabled FROM notebook_share_links WHERE id = ?").get("link-upd") as any;
  assert.equal(row.role, "editor");
  assert.equal(row.enabled, 0);
  clean();
});

test("getByTokenWithDetailsAsync returns details for enabled link", async () => {
  clean();
  seedBase();
  seedLink({ id: "link-det", token: "tok-det", enabled: 1 });
  const row = await notebookShareLinksRepository.getByTokenWithDetailsAsync("tok-det");
  assert.ok(row);
  assert.equal(row.id, "link-det");
  assert.equal(row.name, "Test NB");
  clean();
});

test("getByTokenWithDetailsAsync returns undefined for disabled link", async () => {
  clean();
  seedBase();
  seedLink({ id: "link-dis2", token: "tok-dis2", enabled: 0 });
  const row = await notebookShareLinksRepository.getByTokenWithDetailsAsync("tok-dis2");
  assert.equal(row, undefined);
  clean();
});

test("getEnabledByTokenAsync returns enabled link", async () => {
  clean();
  seedBase();
  seedLink({ id: "link-en", token: "tok-en", enabled: 1 });
  const row = await notebookShareLinksRepository.getEnabledByTokenAsync("tok-en");
  assert.ok(row);
  assert.equal(row.notebookId, NB_ID);
  clean();
});
