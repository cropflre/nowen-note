/**
 * apiTokensRepository async 方法行为测试
 *
 * 使用临时 DB_PATH，不访问真实用户数据。
 */

import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-api-tokens-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

import { apiTokensRepository } from "../src/repositories/apiTokensRepository";
import { getDb } from "../src/db/schema";

const USER_ID = "user-tokens";
const TOKEN_ID = "tok-1";
const TOKEN_HASH = "hash-abc123";

function seedUser() {
  getDb().prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES (?, ?, ?)").run(USER_ID, USER_ID, "hash");
}

function seedToken(overrides: Partial<{ id: string; name: string; tokenHash: string; scopes: string; expiresAt: string | null }> = {}) {
  const id = overrides.id ?? TOKEN_ID;
  const name = overrides.name ?? "Test Token";
  const tokenHash = overrides.tokenHash ?? TOKEN_HASH;
  const scopes = overrides.scopes ?? '["read"]';
  const expiresAt = overrides.expiresAt ?? null;
  getDb().prepare(
    `INSERT INTO api_tokens (id, userId, name, tokenHash, scopes, expiresAt, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(id, USER_ID, name, tokenHash, scopes, expiresAt);
}

function cleanTokens() {
  getDb().prepare("DELETE FROM api_token_usage").run();
  getDb().prepare("DELETE FROM api_tokens").run();
}

test("listByUserAsync returns user tokens", async () => {
  cleanTokens();
  seedUser();
  seedToken({ id: "t1", name: "Alpha", tokenHash: "hash-t1" });
  seedToken({ id: "t2", name: "Beta", tokenHash: "hash-t2" });

  const rows = await apiTokensRepository.listByUserAsync(USER_ID);
  assert.ok(rows.length >= 2);
  // 不包含 tokenHash
  assert.equal((rows[0] as any).tokenHash, undefined);

  cleanTokens();
});

test("createAsync inserts token", async () => {
  cleanTokens();
  seedUser();
  await apiTokensRepository.createAsync({
    id: "t-create",
    userId: USER_ID,
    name: "Created",
    tokenHash: "hash-create",
    scopes: ["read", "write"],
    expiresAt: null,
  });

  const row = getDb().prepare("SELECT * FROM api_tokens WHERE id = ?").get("t-create") as any;
  assert.ok(row);
  assert.equal(row.name, "Created");

  cleanTokens();
});

test("getByIdAndUserAsync returns token", async () => {
  cleanTokens();
  seedUser();
  seedToken({ id: "t-find" });

  const row = await apiTokensRepository.getByIdAndUserAsync("t-find", USER_ID);
  assert.ok(row);
  assert.equal(row.id, "t-find");

  cleanTokens();
});

test("getByIdAndUserAsync returns undefined when not found", async () => {
  cleanTokens();
  const row = await apiTokensRepository.getByIdAndUserAsync("nonexistent", USER_ID);
  assert.equal(row, undefined);
});

test("findByTokenHashAsync returns token by hash", async () => {
  cleanTokens();
  seedUser();
  seedToken({ id: "t-hash", tokenHash: "hash-lookup" });

  const row = await apiTokensRepository.findByTokenHashAsync("hash-lookup");
  assert.ok(row);
  assert.equal(row.id, "t-hash");

  cleanTokens();
});

test("findByTokenHashAsync returns undefined when not found", async () => {
  cleanTokens();
  const row = await apiTokensRepository.findByTokenHashAsync("no-such-hash");
  assert.equal(row, undefined);
});

test("updateLastUsedAsync updates lastUsedAt", async () => {
  cleanTokens();
  seedUser();
  seedToken({ id: "t-used" });

  await apiTokensRepository.updateLastUsedAsync("t-used", "192.168.1.1");

  const row = getDb().prepare("SELECT lastUsedIp FROM api_tokens WHERE id = ?").get("t-used") as any;
  assert.equal(row.lastUsedIp, "192.168.1.1");

  cleanTokens();
});

test("recordUsageAsync inserts usage", async () => {
  cleanTokens();
  seedUser();
  seedToken({ id: "t-usage" });

  await apiTokensRepository.recordUsageAsync("t-usage", "2026-06-29");
  await apiTokensRepository.recordUsageAsync("t-usage", "2026-06-29"); // 累加

  const row = getDb().prepare("SELECT count FROM api_token_usage WHERE tokenId = ? AND day = ?").get("t-usage", "2026-06-29") as any;
  assert.equal(row.count, 2);

  cleanTokens();
});

test("pruneUsageBeforeAsync deletes old usage", async () => {
  cleanTokens();
  seedUser();
  seedToken({ id: "t-prune" });
  getDb().prepare("INSERT INTO api_token_usage (tokenId, day, count) VALUES (?, ?, ?)").run("t-prune", "2026-06-01", 5);
  getDb().prepare("INSERT INTO api_token_usage (tokenId, day, count) VALUES (?, ?, ?)").run("t-prune", "2026-06-15", 3);
  getDb().prepare("INSERT INTO api_token_usage (tokenId, day, count) VALUES (?, ?, ?)").run("t-prune", "2026-06-29", 1);

  await apiTokensRepository.pruneUsageBeforeAsync("2026-06-15"); // 删除 < 06-15

  const rows = getDb().prepare("SELECT * FROM api_token_usage WHERE tokenId = ?").all("t-prune") as any[];
  assert.equal(rows.length, 2); // 06-15 和 06-29 保留

  cleanTokens();
});

test("revokeByIdAsync sets revokedAt", async () => {
  cleanTokens();
  seedUser();
  seedToken({ id: "t-revoke" });

  await apiTokensRepository.revokeByIdAsync("t-revoke");

  const row = getDb().prepare("SELECT revokedAt FROM api_tokens WHERE id = ?").get("t-revoke") as any;
  assert.ok(row.revokedAt);

  cleanTokens();
});

test("getDailyUsageAsync returns daily stats", async () => {
  cleanTokens();
  seedUser();
  seedToken({ id: "t-daily" });
  getDb().prepare("INSERT INTO api_token_usage (tokenId, day, count) VALUES (?, ?, ?)").run("t-daily", "2026-06-28", 10);
  getDb().prepare("INSERT INTO api_token_usage (tokenId, day, count) VALUES (?, ?, ?)").run("t-daily", "2026-06-29", 5);

  const rows = await apiTokensRepository.getDailyUsageAsync(USER_ID, "2026-06-28", "2026-06-29");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].day, "2026-06-28");

  cleanTokens();
});

test("getPrevPeriodTotalAsync returns total", async () => {
  cleanTokens();
  seedUser();
  seedToken({ id: "t-prev" });
  getDb().prepare("INSERT INTO api_token_usage (tokenId, day, count) VALUES (?, ?, ?)").run("t-prev", "2026-06-01", 10);
  getDb().prepare("INSERT INTO api_token_usage (tokenId, day, count) VALUES (?, ?, ?)").run("t-prev", "2026-06-02", 20);

  const total = await apiTokensRepository.getPrevPeriodTotalAsync(USER_ID, "2026-06-01", "2026-06-02");
  assert.equal(total, 30);

  cleanTokens();
});

test("getUsageByTokenAsync returns per-token stats", async () => {
  cleanTokens();
  seedUser();
  seedToken({ id: "t-bytoken", name: "My Token" });
  getDb().prepare("INSERT INTO api_token_usage (tokenId, day, count) VALUES (?, ?, ?)").run("t-bytoken", "2026-06-29", 42);

  const rows = await apiTokensRepository.getUsageByTokenAsync(USER_ID, "2026-06-29", "2026-06-29");
  assert.ok(rows.length >= 1);
  assert.equal(rows[0].tokenId, "t-bytoken");
  assert.equal(rows[0].name, "My Token");
  assert.equal(rows[0].count, 42);

  cleanTokens();
});
