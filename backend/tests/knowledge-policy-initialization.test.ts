import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-policy-rollback-"));
process.env.DB_PATH = path.join(directory, "fixture.db");
process.env.ELECTRON_USER_DATA = directory;

test("rolled-back lazy ACL schema initialization is retried before the next permission check", async () => {
  const { getDb, closeDb } = await import("../src/db/schema");
  const { ensureKnowledgeDenyTable } = await import("../src/services/knowledgeDenyPolicy");
  const { ensureKnowledgeAccessPolicyTable } = await import("../src/services/knowledgeAccessPolicy");
  const db = getDb();
  try {
    for (const [table, ensure] of [
      ["knowledge_tree_denials", ensureKnowledgeDenyTable],
      ["knowledge_tree_access_policies", ensureKnowledgeAccessPolicyTable],
    ] as const) {
      const exists = () => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
      assert.equal(exists(), false, `${table} starts lazy in a fresh database`);
      assert.throws(db.transaction(() => {
        ensure(db);
        assert.equal(exists(), true);
        throw new Error("refused lifecycle action");
      }).immediate, /refused lifecycle action/);
      assert.equal(exists(), false, "DDL rolled back with the refused action");
      ensure(db);
      assert.equal(exists(), true, "the next ACL check reinstalls its rolled-back table");
    }
  } finally {
    closeDb();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
