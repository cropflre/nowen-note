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
const structuralGuardSql = fs.readFileSync(
  path.join(__dirname, "../src/db/postgres/064_knowledge_tree_structural_guard.sql"),
  "utf8",
);
const accessPolicySql = fs.readFileSync(
  path.join(__dirname, "../src/db/postgres/065_knowledge_tree_access_policy.sql"),
  "utf8",
);
const denialSql = fs.readFileSync(
  path.join(__dirname, "../src/db/postgres/066_knowledge_tree_denials.sql"),
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

test("PostgreSQL structural guard ignores unchanged parent and scope", () => {
  assert.match(structuralGuardSql, /CREATE TRIGGER knowledge_tree_parent_guard_insert/i);
  assert.match(structuralGuardSql, /CREATE TRIGGER knowledge_tree_parent_guard_update/i);
  assert.match(structuralGuardSql, /OLD\."parentId" IS DISTINCT FROM NEW\."parentId"/i);
  assert.match(structuralGuardSql, /OLD\."scopeKey" IS DISTINCT FROM NEW\."scopeKey"/i);
});

test("PostgreSQL access policy matches SQLite inherit and restricted semantics", () => {
  assert.match(accessPolicySql, /CREATE TABLE IF NOT EXISTS knowledge_tree_access_policies/i);
  assert.match(
    accessPolicySql,
    /CHECK\s*\(\s*"accessMode"\s+IN\s*\(\s*'inherit'\s*,\s*'restricted'\s*\)\s*\)/i,
  );
  assert.match(accessPolicySql, /"isExplicit"\s+INTEGER\s+NOT NULL\s+DEFAULT\s+0/i);
  assert.match(accessPolicySql, /ADD COLUMN IF NOT EXISTS "isExplicit"/i);
  assert.match(accessPolicySql, /REFERENCES knowledge_tree_nodes\(id\) ON DELETE CASCADE/i);
  assert.match(accessPolicySql, /INSERT INTO knowledge_tree_access_policies/i);
  assert.match(accessPolicySql, /FROM knowledge_tree_acl/i);
  assert.match(accessPolicySql, /GROUP BY "nodeId"/i);
  assert.match(accessPolicySql, /ON CONFLICT \("nodeId"\) DO NOTHING/i);
});

test("PostgreSQL explicit denials match SQLite semantics", () => {
  assert.match(denialSql, /CREATE TABLE IF NOT EXISTS knowledge_tree_denials/i);
  assert.match(denialSql, /PRIMARY KEY \("nodeId", "userId"\)/i);
  assert.match(denialSql, /"nodeId"\s+TEXT\s+NOT NULL[\s\S]*REFERENCES knowledge_tree_nodes\(id\) ON DELETE CASCADE/i);
  assert.match(denialSql, /"userId"\s+TEXT\s+NOT NULL[\s\S]*REFERENCES users\(id\) ON DELETE CASCADE/i);
  assert.match(denialSql, /CREATE INDEX IF NOT EXISTS idx_knowledge_tree_denials_user/i);
});
