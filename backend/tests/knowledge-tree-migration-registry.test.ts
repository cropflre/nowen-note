import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-knowledge-tree-registry-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

let closeDb: typeof import("../src/db/schema").closeDb | undefined;

test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("fresh database applies the complete knowledge tree migration chain", async () => {
  // Historical entry points still import this module. It must validate the
  // canonical registry without injecting duplicate versions.
  await import("../src/runtime/knowledge-tree-migration-bootstrap");
  const migrationsModule = await import("../src/db/migrations");
  const schema = await import("../src/db/schema");
  closeDb = schema.closeDb;

  const registered = migrationsModule.MIGRATIONS
    .filter((migration) => migration.version >= 60 && migration.version <= 65)
    .map((migration) => ({ version: migration.version, name: migration.name }));
  assert.deepEqual(registered, [
    { version: 60, name: "knowledge-tree-capabilities" },
    { version: 61, name: "knowledge-tree-resource-views" },
    { version: 62, name: "knowledge-tree-parent-preservation" },
    { version: 63, name: "knowledge-tree-legacy-sync-split" },
    { version: 64, name: "knowledge-tree-structural-update-guard" },
    { version: 65, name: "knowledge-tree-folder-passwords" },
  ]);

  const db = schema.getDb();
  const migrationRows = db.prepare(
    "SELECT version, name FROM schema_migrations WHERE version BETWEEN 60 AND 65 ORDER BY version",
  ).all() as Array<{ version: number; name: string }>;
  assert.deepEqual(migrationRows, registered);

  for (const name of [
    "knowledge_tree_nodes",
    "knowledge_tree_acl",
    "knowledge_tree_history",
    "notebook_passwords",
  ]) {
    const row = db.prepare(
      "SELECT type FROM sqlite_master WHERE name = ?",
    ).get(name) as { type: string } | undefined;
    assert.equal(row?.type, "table", `${name} must exist after the canonical migration chain`);
  }

  const filesView = db.prepare(
    "SELECT type FROM sqlite_master WHERE name = 'files'",
  ).get() as { type: string } | undefined;
  assert.equal(filesView?.type, "view");

  const triggers = db.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'trigger'
       AND name IN (
         'knowledge_tree_notebooks_parent_au',
         'knowledge_tree_notebooks_state_au',
         'knowledge_tree_parent_scope_guard_update'
       )
     ORDER BY name`,
  ).all() as Array<{ name: string }>;
  assert.deepEqual(triggers.map((row) => row.name), [
    "knowledge_tree_notebooks_parent_au",
    "knowledge_tree_notebooks_state_au",
    "knowledge_tree_parent_scope_guard_update",
  ]);
});
