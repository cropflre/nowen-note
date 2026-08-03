from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    "backend/src/db/migrations.ts",
    'import { tagScopeUniquenessMigration } from "./tagScopeUniquenessMigration.js";\n',
    'import { tagScopeUniquenessMigration } from "./tagScopeUniquenessMigration.js";\n'
    'import { knowledgeTreeMigration } from "./knowledgeTreeMigration.js";\n'
    'import { knowledgeTreeResourceMigration } from "./knowledgeTreeResourceMigration.js";\n'
    'import { knowledgeTreeParentPreservationMigration } from "./knowledgeTreeParentPreservationMigration.js";\n'
    'import { knowledgeTreeLegacySyncMigration } from "./knowledgeTreeLegacySyncMigration.js";\n'
    'import { knowledgeTreeStructuralGuardMigration } from "./knowledgeTreeStructuralGuardMigration.js";\n'
    'import { knowledgeTreePasswordMigration } from "./knowledgeTreePasswordMigration.js";\n',
)

replace_once(
    "backend/src/db/migrations.ts",
    '''  yjsSubdocumentGenerationMigration,
  tagScopeUniquenessMigration,
  offlineSyncMigration,
''',
    '''  yjsSubdocumentGenerationMigration,
  tagScopeUniquenessMigration,
  knowledgeTreeMigration,
  knowledgeTreeResourceMigration,
  knowledgeTreeParentPreservationMigration,
  knowledgeTreeLegacySyncMigration,
  knowledgeTreeStructuralGuardMigration,
  knowledgeTreePasswordMigration,
  offlineSyncMigration,
''',
)

Path("backend/src/runtime/knowledge-tree-migration-bootstrap.ts").write_text('''import { MIGRATIONS } from "../db/migrations.js";

const REQUIRED_KNOWLEDGE_TREE_MIGRATIONS = [60, 61, 62, 63, 64, 65] as const;

/**
 * Compatibility bootstrap kept for historical entry points.
 *
 * Versions 60-65 are now part of the canonical migration registry. This module
 * must never mutate the migration list at runtime: doing so after migrations.ts
 * has already imported the same feature migrations creates duplicate versions
 * and makes database startup fail. The bootstrap now only verifies that a build
 * did not accidentally omit the published knowledge-tree chain.
 */
for (const version of REQUIRED_KNOWLEDGE_TREE_MIGRATIONS) {
  if (!MIGRATIONS.some((migration) => migration.version === version)) {
    throw new Error(`[knowledge-tree-bootstrap] missing canonical migration v${version}`);
  }
}
''', encoding="utf-8")

replace_once(
    "backend/tests/knowledge-tree.test.ts",
    '''  const { getDb, closeDb, getDbSchemaVersion } = await import("../src/db/schema.js");
  closeDatabase = closeDb;
''',
    '''  const { getDb, closeDb, getDbSchemaVersion } = await import("../src/db/schema.js");
  const { CURRENT_SCHEMA_VERSION } = await import("../src/db/migrations.js");
  closeDatabase = closeDb;
''',
)
replace_once(
    "backend/tests/knowledge-tree.test.ts",
    '  assert.equal(getDbSchemaVersion(), 65);\n',
    '  assert.equal(getDbSchemaVersion(), CURRENT_SCHEMA_VERSION);\n',
)

Path("backend/tests/knowledge-tree-migration-registry.test.ts").write_text('''import assert from "node:assert/strict";
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
''', encoding="utf-8")
