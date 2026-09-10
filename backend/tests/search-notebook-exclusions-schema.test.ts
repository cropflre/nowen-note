import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const testDir = path.dirname(new URL(import.meta.url).pathname);
const migrationsSource = fs.readFileSync(path.join(testDir, "../src/db/migrations.ts"), "utf8");
const sqliteMigration = fs.readFileSync(
  path.join(testDir, "../src/db/searchNotebookExclusionsMigration.ts"),
  "utf8",
);
const postgresMigration = fs.readFileSync(
  path.join(testDir, "../src/db/postgres/migrations/0057-user-search-notebook-exclusions.sql"),
  "utf8",
);

test("search notebook exclusions are registered as a per-user sqlite migration", () => {
  assert.match(migrationsSource, /searchNotebookExclusionsMigration/);
  assert.match(sqliteMigration, /version:\s*101/);
  assert.match(sqliteMigration, /PRIMARY KEY \(userId, notebookId\)/);
  assert.match(sqliteMigration, /includeDescendants INTEGER NOT NULL DEFAULT 1/);
  assert.match(sqliteMigration, /FOREIGN KEY \(notebookId\) REFERENCES notebooks\(id\) ON DELETE CASCADE/);
});

test("postgres migration keeps the same ownership and descendant semantics", () => {
  assert.match(postgresMigration, /user_search_notebook_exclusions/);
  assert.match(postgresMigration, /PRIMARY KEY \("userId", "notebookId"\)/);
  assert.match(postgresMigration, /"includeDescendants" BOOLEAN NOT NULL DEFAULT TRUE/);
  assert.match(postgresMigration, /REFERENCES notebooks\(id\) ON DELETE CASCADE/);
});
