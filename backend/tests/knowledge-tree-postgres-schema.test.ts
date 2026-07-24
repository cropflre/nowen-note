import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sql = fs.readFileSync(path.join(__dirname, "../src/db/postgres/060_knowledge_tree.sql"), "utf8");
const legacySyncSql = fs.readFileSync(
  path.join(__dirname, "../src/db/postgres/063_knowledge_tree_legacy_sync.sql"),
  "utf8",
);

test("PostgreSQL knowledge tree schema has node, capability, history and cycle guards", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS knowledge_tree_nodes/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS knowledge_tree_acl/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS knowledge_tree_history/i);
  for (const capability of [
    "canView",
    "canComment",
    "canCreate",
    "canEdit",
    "canDelete",
    "canMove",
    "canDownload",
    "canReshare",
    "canManageMembers",
  ]) {
    assert.match(sql, new RegExp(`"${capability}"\\s+BOOLEAN`, "i"));
  }
  assert.match(sql, /KNOWLEDGE_TREE_PARENT_SCOPE_MISMATCH/);
  assert.match(sql, /KNOWLEDGE_TREE_CYCLE/);
  assert.match(sql, /CREATE TRIGGER knowledge_tree_notebooks_sync/i);
  assert.match(sql, /CREATE TRIGGER knowledge_tree_notes_sync/i);
  assert.match(sql, /'note:'\s*\|\|\s*n\.id/i);
  assert.match(sql, /'notebook:'\s*\|\|\s*nb\.id/i);
});

test("PostgreSQL legacy sync preserves document parents on harmless notebook updates", () => {
  assert.match(legacySyncSql, /existing_parent TEXT/i);
  assert.match(legacySyncSql, /OLD\."parentId" IS NOT DISTINCT FROM NEW\."parentId"/i);
  assert.match(legacySyncSql, /next_parent := existing_parent/i);
  assert.match(legacySyncSql, /"parentId" = EXCLUDED\."parentId"/i);
  assert.match(legacySyncSql, /CREATE TRIGGER knowledge_tree_notebooks_sync/i);
});
