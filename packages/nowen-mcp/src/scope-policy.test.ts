import assert from "node:assert/strict";
import test from "node:test";
import {
  NotebookScopePolicy,
  ScopeDeniedError,
  loadScopeConfiguration,
} from "./scope-policy.js";

test("unset notebook scope keeps legacy unrestricted behavior", () => {
  const config = loadScopeConfiguration({});
  const policy = new NotebookScopePolicy(config);
  assert.equal(policy.enabled, false);
  assert.equal(policy.isNotebookAllowed("any-notebook"), true);
});

test("an explicitly empty whitelist enables fail-closed scope", () => {
  const config = loadScopeConfiguration({ ALLOWED_NOTEBOOK_IDS: "" });
  const policy = new NotebookScopePolicy(config);
  assert.equal(policy.enabled, true);
  assert.throws(() => policy.assertNotebookAllowed("nb-1"), ScopeDeniedError);
});

test("descendant hydration follows the configured notebook tree", () => {
  const policy = new NotebookScopePolicy(loadScopeConfiguration({
    ALLOWED_NOTEBOOK_IDS: "root",
    MCP_INCLUDE_DESCENDANTS: "true",
  }));
  policy.hydrateDescendants([
    { id: "grandchild", parentId: "child" },
    { id: "child", parentId: "root" },
    { id: "other", parentId: null },
  ]);
  assert.deepEqual(new Set(policy.allowedIds), new Set(["root", "child", "grandchild"]));
});

test("read-only mode rejects mutations", () => {
  const policy = new NotebookScopePolicy(loadScopeConfiguration({
    ALLOWED_NOTEBOOK_IDS: "root",
    MCP_ACCESS_MODE: "read-only",
  }));
  assert.throws(() => policy.assertWritable("更新笔记"), ScopeDeniedError);
});

test("read-only mode is enforced even without notebook whitelist", () => {
  const policy = new NotebookScopePolicy(loadScopeConfiguration({
    MCP_ACCESS_MODE: "read-only",
  }));
  assert.equal(policy.enabled, false);
  assert.equal(policy.isNotebookAllowed("any-notebook"), true);
  assert.throws(() => policy.assertWritable("创建笔记"), ScopeDeniedError);
});

test("knowledge tree filtering drops out-of-scope nested notebooks and their notes", () => {
  const policy = new NotebookScopePolicy(loadScopeConfiguration({
    ALLOWED_NOTEBOOK_IDS: "allowed",
  }));
  const nodes = [
    { id: "notebook:allowed", resourceType: "notebook", resourceId: "allowed", parentId: null },
    { id: "note:a", resourceType: "note", resourceId: "a", parentId: "notebook:allowed" },
    { id: "notebook:denied", resourceType: "notebook", resourceId: "denied", parentId: "notebook:allowed" },
    { id: "note:b", resourceType: "note", resourceId: "b", parentId: "notebook:denied" },
    { id: "note:orphan", resourceType: "note", resourceId: "orphan", parentId: null },
  ];
  assert.deepEqual(policy.filterKnowledgeTree(nodes).map((item) => item.id), [
    "notebook:allowed",
    "note:a",
  ]);
});

test("deleted child notebook is visible only to explicit recycle-bin view with ancestor grant", () => {
  const policy = new NotebookScopePolicy(loadScopeConfiguration({
    ALLOWED_NOTEBOOK_IDS: "root",
    MCP_INCLUDE_DESCENDANTS: "true",
  }));
  const nodes = [
    { id: "notebook:root", parentId: null, resourceType: "notebook", resourceId: "root" },
    { id: "notebook:deleted", parentId: "notebook:root", resourceType: "notebook", resourceId: "deleted" },
    { id: "note:inside", parentId: "notebook:deleted", resourceType: "note", resourceId: "inside" },
    { id: "notebook:other", parentId: null, resourceType: "notebook", resourceId: "other" },
  ];
  assert.deepEqual(policy.filterKnowledgeTree(nodes).map((node) => node.id), ["notebook:root"]);
  assert.deepEqual(policy.filterKnowledgeTree(nodes, true).map((node) => node.id), [
    "notebook:root", "notebook:deleted", "note:inside",
  ]);
  const noDescendants = new NotebookScopePolicy(loadScopeConfiguration({
    ALLOWED_NOTEBOOK_IDS: "root",
    MCP_INCLUDE_DESCENDANTS: "false",
  }));
  assert.deepEqual(noDescendants.filterKnowledgeTree(nodes, true).map((node) => node.id),
    ["notebook:root"]);
});

test("note and file filtering cannot expand the whitelist", () => {
  const policy = new NotebookScopePolicy(loadScopeConfiguration({
    ALLOWED_NOTEBOOK_IDS: "allowed",
  }));
  assert.deepEqual(policy.filterNotes([
    { id: "a", notebookId: "allowed" },
    { id: "b", notebookId: "blocked" },
  ]), [{ id: "a", notebookId: "allowed" }]);
  assert.deepEqual(policy.filterFiles([
    { id: "a", primaryNote: { notebookId: "allowed" } },
    { id: "b", primaryNote: { notebookId: "blocked" } },
    { id: "c", primaryNote: null },
  ]), [{ id: "a", primaryNote: { notebookId: "allowed" } }]);
});
