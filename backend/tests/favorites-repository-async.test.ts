/**
 * favoritesRepository async 方法行为测试
 *
 * 使用临时 DB_PATH，不访问真实用户数据。
 */

import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-favorites-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

import { favoritesRepository } from "../src/repositories/favoritesRepository";
import { getDb } from "../src/db/schema";

const USER_ID = "user-fav";
const NOTE_ID = "note-fav";
const WS_ID = "ws-fav";

function seedBase() {
  getDb().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(USER_ID, USER_ID, "hash");
  getDb().prepare("INSERT OR IGNORE INTO notebooks (id, userId, name) VALUES (?, ?, ?)").run("nb-fav", USER_ID, "Test NB");
  getDb().prepare("INSERT OR IGNORE INTO notes (id, userId, notebookId, title) VALUES (?, ?, ?, ?)").run(NOTE_ID, USER_ID, "nb-fav", "Test Note");
  getDb().prepare("INSERT OR IGNORE INTO notes (id, userId, notebookId, title) VALUES (?, ?, ?, ?)").run("n1", USER_ID, "nb-fav", "Note 1");
  getDb().prepare("INSERT OR IGNORE INTO notes (id, userId, notebookId, title) VALUES (?, ?, ?, ?)").run("n2", USER_ID, "nb-fav", "Note 2");
}

function cleanFavorites() {
  getDb().prepare("DELETE FROM favorites").run();
}

test("isFavoritedAsync returns true when favorited", async () => {
  cleanFavorites();
  seedBase();
  getDb().prepare("INSERT INTO favorites (userId, noteId, workspaceId, createdAt) VALUES (?, ?, ?, datetime('now'))").run(USER_ID, NOTE_ID, null);

  const result = await favoritesRepository.isFavoritedAsync(USER_ID, NOTE_ID);
  assert.equal(result, true);

  cleanFavorites();
});

test("isFavoritedAsync returns false when not favorited", async () => {
  cleanFavorites();
  const result = await favoritesRepository.isFavoritedAsync(USER_ID, "nonexistent");
  assert.equal(result, false);
});

test("addFavoriteAsync inserts favorite", async () => {
  cleanFavorites();
  seedBase();
  await favoritesRepository.addFavoriteAsync(USER_ID, NOTE_ID, WS_ID);

  const row = getDb().prepare("SELECT * FROM favorites WHERE userId = ? AND noteId = ?").get(USER_ID, NOTE_ID) as any;
  assert.ok(row);
  assert.equal(row.workspaceId, WS_ID);

  cleanFavorites();
});

test("removeFavoriteAsync deletes favorite", async () => {
  cleanFavorites();
  seedBase();
  getDb().prepare("INSERT INTO favorites (userId, noteId, workspaceId, createdAt) VALUES (?, ?, ?, datetime('now'))").run(USER_ID, NOTE_ID, null);

  await favoritesRepository.removeFavoriteAsync(USER_ID, NOTE_ID);

  const row = getDb().prepare("SELECT 1 FROM favorites WHERE userId = ? AND noteId = ?").get(USER_ID, NOTE_ID);
  assert.equal(row, undefined);
});

test("toggleFavoriteAsync toggles state", async () => {
  cleanFavorites();
  seedBase();

  const first = await favoritesRepository.toggleFavoriteAsync(USER_ID, NOTE_ID, null);
  assert.equal(first, true);

  const second = await favoritesRepository.toggleFavoriteAsync(USER_ID, NOTE_ID, null);
  assert.equal(second, false);

  cleanFavorites();
});

test("listFavoriteNoteIdsAsync returns note ids", async () => {
  cleanFavorites();
  seedBase();
  getDb().prepare("INSERT INTO favorites (userId, noteId, workspaceId, createdAt) VALUES (?, ?, ?, datetime('now'))").run(USER_ID, "n1", null);
  getDb().prepare("INSERT INTO favorites (userId, noteId, workspaceId, createdAt) VALUES (?, ?, ?, datetime('now', '-10 seconds'))").run(USER_ID, "n2", null);

  const ids = await favoritesRepository.listFavoriteNoteIdsAsync(USER_ID);
  assert.ok(ids.length >= 2);
  assert.equal(ids[0], "n1"); // 最新在前

  cleanFavorites();
});

test("listFavoriteNoteIdsAsync filters by workspaceId", async () => {
  cleanFavorites();
  seedBase();
  getDb().prepare("INSERT INTO favorites (userId, noteId, workspaceId, createdAt) VALUES (?, ?, ?, datetime('now'))").run(USER_ID, "n1", WS_ID);
  getDb().prepare("INSERT INTO favorites (userId, noteId, workspaceId, createdAt) VALUES (?, ?, ?, datetime('now'))").run(USER_ID, "n2", null);

  const wsIds = await favoritesRepository.listFavoriteNoteIdsAsync(USER_ID, WS_ID);
  assert.equal(wsIds.length, 1);
  assert.equal(wsIds[0], "n1");

  cleanFavorites();
});

test("deleteByNoteIdAsync returns changes", async () => {
  cleanFavorites();
  seedBase();
  getDb().prepare("INSERT INTO favorites (userId, noteId, workspaceId, createdAt) VALUES (?, ?, ?, datetime('now'))").run(USER_ID, NOTE_ID, null);

  const count = await favoritesRepository.deleteByNoteIdAsync(NOTE_ID);
  assert.equal(count, 1);

  cleanFavorites();
});

test("deleteByUserIdAsync returns changes", async () => {
  cleanFavorites();
  seedBase();
  getDb().prepare("INSERT INTO favorites (userId, noteId, workspaceId, createdAt) VALUES (?, ?, ?, datetime('now'))").run(USER_ID, "n1", null);
  getDb().prepare("INSERT INTO favorites (userId, noteId, workspaceId, createdAt) VALUES (?, ?, ?, datetime('now'))").run(USER_ID, "n2", null);

  const count = await favoritesRepository.deleteByUserIdAsync(USER_ID);
  assert.equal(count, 2);

  cleanFavorites();
});
