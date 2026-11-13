import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { nowenStudioMigration } from "../src/db/nowenStudioMigration.js";
import { nowenStudioHistoryMigration } from "../src/db/nowenStudioHistoryMigration.js";
import { createPersonalStudioApp, deletePersonalStudioApp, getPersonalStudioApp, updatePersonalStudioApp } from "../src/plugins/personalStudioApps.js";
import { listPersonalStudioVersions, restorePersonalStudioVersion } from "../src/plugins/personalStudioHistory.js";

const spec = {
  schemaVersion: 1, name: "Original", description: "", layout: "list",
  fields: [{ id: "title", label: "Title", type: "text" }],
  items: [{ id: "record1", values: { title: "survive migration + WAL backup" } }]
};

test("SQLite WAL backup, P0 to P1 upgrade, history restore and user isolation survive file reopen", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-studio-restore-"));
  const originalFile = path.join(dir, "personal.db");
  const p0SnapshotFile = path.join(dir, "p0-backup.db");
  const p1SnapshotFile = path.join(dir, "p1-backup.db");
  const restoredFile = path.join(dir, "restored.db");
  let db: Database.Database | undefined;
  try {
    db = new Database(originalFile);
    db.pragma("journal_mode = WAL"); db.pragma("foreign_keys = ON");
    db.exec("CREATE TABLE users (id TEXT PRIMARY KEY); INSERT INTO users(id) VALUES('alice'),('bob')");
    nowenStudioMigration.up(db);
    const created = createPersonalStudioApp(db, "alice", spec);
    await db.backup(p0SnapshotFile);
    nowenStudioHistoryMigration.up(db);
    assert.equal(getPersonalStudioApp(db, "alice", created.id).spec.items[0].values.title, "survive migration + WAL backup");
    assert.deepEqual(listPersonalStudioVersions(db, "alice", created.id).map(x => x.revision), [1]);
    assert.throws(() => getPersonalStudioApp(db!, "bob", created.id), /STUDIO_APP_NOT_FOUND/);
    const changed = updatePersonalStudioApp(db, "alice", created.id, 1, { ...spec, name: "Upgraded" });
    assert.equal(changed.revision, 2);
    await db.backup(p1SnapshotFile);
    // A bad edit or deletion after the backup cannot damage the restore image.
    deletePersonalStudioApp(db, "alice", created.id, 2);
    assert.throws(() => getPersonalStudioApp(db!, "alice", created.id), /STUDIO_APP_NOT_FOUND/);
    db.close(); db = undefined;

    const p0 = new Database(p0SnapshotFile);
    p0.pragma("foreign_keys = ON");
    try {
      nowenStudioHistoryMigration.up(p0);
      assert.equal(listPersonalStudioVersions(p0, "alice", created.id).length, 1);
      assert.equal(getPersonalStudioApp(p0, "alice", created.id).spec.name, "Original");
    } finally { p0.close(); }

    fs.copyFileSync(p1SnapshotFile, restoredFile);
    const restored = new Database(restoredFile);
    restored.pragma("foreign_keys = ON");
    try {
      assert.deepEqual(restored.pragma("quick_check", { simple: true }), "ok");
      assert.deepEqual(listPersonalStudioVersions(restored, "alice", created.id).map(x => x.revision), [2, 1]);
      const record = getPersonalStudioApp(restored, "alice", created.id);
      assert.equal(record.spec.name, "Upgraded");
      assert.equal(record.spec.items[0].values.title, "survive migration + WAL backup");
      assert.throws(() => listPersonalStudioVersions(restored, "bob", created.id), /STUDIO_APP_NOT_FOUND/);
      const undone = restorePersonalStudioVersion(restored, "alice", created.id, 1, 2);
      assert.equal(undone.spec.name, "Original");
      assert.equal(undone.revision, 3);
      assert.deepEqual(listPersonalStudioVersions(restored,"alice",created.id).map(x => x.revision),[3,2,1]);
    } finally { restored.close(); }
  } finally {
    if (db?.open) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
