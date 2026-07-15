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
