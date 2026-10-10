import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Hono } from "hono";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-search-exclusions-"));
process.env.DB_PATH = path.join(tempDir, "search-exclusions.db");
let closeDatabase: (() => void) | null = null;

test.after(() => {
  closeDatabase?.();
  fs.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

test("global search skips user-excluded notebooks and descendants before candidate ranking", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const [{ getDb, closeDb }, { createKnowledgeChild }, searchModule, exclusionService] = await Promise.all([
    import("../src/db/schema.js"),
    import("../src/services/knowledgeTree.js"),
    import("../src/routes/search.js"),
    import("../src/services/searchNotebookExclusions.js"),
  ]);
  closeDatabase = closeDb;
  const db = getDb();

  for (const userId of ["search-scope-owner", "search-scope-other"]) {
    db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')")
      .run(userId, userId);
  }

  const archive = createKnowledgeChild({
    actorUserId: "search-scope-owner",
    workspaceId: null,
    parentId: null,
    nodeType: "folder",
    title: "历史归档",
    db,
  });
  const archiveChild = createKnowledgeChild({
    actorUserId: "search-scope-owner",
    workspaceId: null,
    parentId: archive.id,
    nodeType: "folder",
    title: "小米云笔记",
    db,
  });
  const archiveNote = createKnowledgeChild({
    actorUserId: "search-scope-owner",
    workspaceId: null,
    parentId: archiveChild.id,
    nodeType: "note",
    title: "scope-needle 历史内容",
    db,
  });
  const active = createKnowledgeChild({
    actorUserId: "search-scope-owner",
    workspaceId: null,
    parentId: null,
    nodeType: "folder",
    title: "当前工作",
    db,
  });
  const activeNote = createKnowledgeChild({
    actorUserId: "search-scope-owner",
    workspaceId: null,
    parentId: active.id,
    nodeType: "note",
    title: "scope-needle 当前内容",
    db,
  });

  const app = new Hono();
  app.route("/search", searchModule.default);
  const ownerHeaders = { "X-User-Id": "search-scope-owner", "Content-Type": "application/json" };

  const baseline = await app.request("http://localhost/search?q=scope-needle", { headers: ownerHeaders });
  assert.equal(baseline.status, 200);
  assert.deepEqual(
    new Set((await baseline.json() as any[]).map((row) => row.id)),
    new Set([archiveNote.resourceId, activeNote.resourceId]),
  );

  const excludeResponse = await app.request(
    `http://localhost/search/excluded-notebooks/${archive.resourceId}`,
    { method: "PUT", headers: ownerHeaders, body: JSON.stringify({ includeDescendants: true }) },
  );
  assert.equal(excludeResponse.status, 200);

  const rulesResponse = await app.request("http://localhost/search/excluded-notebooks", { headers: ownerHeaders });
  assert.equal(rulesResponse.status, 200);
  const rules = await rulesResponse.json() as any;
  assert.equal(rules.directCount, 1);
  assert.equal(rules.effectiveNotebookCount, 2);
  assert.equal(rules.direct[0].notebookId, archive.resourceId);

  const excluded = await app.request("http://localhost/search?q=scope-needle", { headers: ownerHeaders });
  assert.equal(excluded.status, 200);
  assert.deepEqual((await excluded.json() as any[]).map((row) => row.id), [activeNote.resourceId]);

  const withArchives = await app.request("http://localhost/search?q=scope-needle&includeExcluded=1", {
    headers: ownerHeaders,
  });
  assert.equal(withArchives.status, 200);
  assert.deepEqual(
    new Set((await withArchives.json() as any[]).map((row) => row.id)),
    new Set([archiveNote.resourceId, activeNote.resourceId]),
  );

  // The preference belongs only to the current user; it must not become notebook metadata.
  assert.deepEqual(
    Array.from(exclusionService.getEffectiveExcludedNotebookIds("search-scope-other", db)),
    [],
  );
  const otherSearch = await app.request("http://localhost/search?q=scope-needle&includeExcluded=1", {
    headers: { "X-User-Id": "search-scope-other" },
  });
  assert.equal(otherSearch.status, 200);
  assert.deepEqual(await otherSearch.json(), [], "includeExcluded must never bypass content ACL");

  const restoreResponse = await app.request(
    `http://localhost/search/excluded-notebooks/${archive.resourceId}`,
    { method: "DELETE", headers: ownerHeaders },
  );
  assert.equal(restoreResponse.status, 200);
  const restored = await app.request("http://localhost/search?q=scope-needle", { headers: ownerHeaders });
  assert.deepEqual(
    new Set((await restored.json() as any[]).map((row) => row.id)),
    new Set([archiveNote.resourceId, activeNote.resourceId]),
  );
});

test("includeDescendants=false excludes only the selected notebook resource", async () => {
  const { getDb } = await import("../src/db/schema.js");
  const { createKnowledgeChild } = await import("../src/services/knowledgeTree.js");
  const {
    clearSearchNotebookExcluded,
    getEffectiveExcludedNotebookIds,
    setSearchNotebookExcluded,
  } = await import("../src/services/searchNotebookExclusions.js");
  const db = getDb();

  const root = createKnowledgeChild({
    actorUserId: "search-scope-owner",
    workspaceId: null,
    parentId: null,
    nodeType: "folder",
    title: "只排除当前目录",
    db,
  });
  const child = createKnowledgeChild({
    actorUserId: "search-scope-owner",
    workspaceId: null,
    parentId: root.id,
    nodeType: "folder",
    title: "仍参与搜索的子目录",
    db,
  });

  setSearchNotebookExcluded({
    userId: "search-scope-owner",
    notebookId: root.resourceId,
    includeDescendants: false,
    db,
  });
  const effective = getEffectiveExcludedNotebookIds("search-scope-owner", db);
  assert.equal(effective.has(root.resourceId), true);
  assert.equal(effective.has(child.resourceId), false);
  clearSearchNotebookExcluded({ userId: "search-scope-owner", notebookId: root.resourceId, db });
});
