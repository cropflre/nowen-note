import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

function read(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, "../src", relativePath), "utf8");
}

const librarySource = read("lib/mindmap-schema.ts");
const repositorySource = read("repositories/mindmapSchemaRepository.ts");

test("mindmap schema library delegates persistence to repository", () => {
  assert.doesNotMatch(librarySource, /better-sqlite3/);
  assert.doesNotMatch(librarySource, /\.\.\/db\/schema/);
  assert.doesNotMatch(librarySource, /\bgetDb\s*\(/);
  assert.doesNotMatch(librarySource, /\.prepare\s*\(/);
  assert.doesNotMatch(librarySource, /\.exec\s*\(/);
  assert.match(librarySource, /mindmapSchemaRepository\.ensure\(db\)/);
});

test("mindmap schema repository preserves legacy fallback semantics", () => {
  assert.match(repositorySource, /CREATE TABLE IF NOT EXISTS mindmaps/);
  assert.match(repositorySource, /PRAGMA table_info\(mindmaps\)/);
  assert.match(repositorySource, /ADD COLUMN starred INTEGER NOT NULL DEFAULT 0/);
  assert.match(repositorySource, /ADD COLUMN folderId TEXT/);
  assert.match(repositorySource, /CREATE TABLE IF NOT EXISTS mindmap_folders/);
  assert.match(repositorySource, /idx_mindmaps_workspace/);
  assert.match(repositorySource, /idx_mindmap_folders_workspace/);
});
