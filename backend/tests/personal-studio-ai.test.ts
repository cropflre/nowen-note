import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { nowenStudioMigration } from "../src/db/nowenStudioMigration.js";
import { nowenStudioHistoryMigration } from "../src/db/nowenStudioHistoryMigration.js";
import { parsePersonalAIResponse } from "../src/plugins/personalStudioAI.js";
import { createPersonalStudioApp, deletePersonalStudioApp, getPersonalStudioApp, updatePersonalStudioApp } from "../src/plugins/personalStudioApps.js";
import { listPersonalStudioVersions, restorePersonalStudioVersion } from "../src/plugins/personalStudioHistory.js";

const original = {
  schemaVersion: 1, name: "Tracker", description: "", layout: "list",
  fields: [{ id: "title", label: "Title", type: "text" }, { id: "done", label: "Done", type: "checkbox" }],
  items: [{ id: "item1", values: { title: "private item", done: false } }],
} as const;
const model = {
  schemaVersion: 1, name: "Work Tracker", description: "My project", layout: "board",
  fields: [{ id: "title", label: "Issue", type: "text" }, { id: "done", label: "Done", type: "checkbox" }, { id: "priority", label: "Priority", type: "text" }],
};
function fixture() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE users (id TEXT PRIMARY KEY); INSERT INTO users(id) VALUES('alice'),('bob');");
  nowenStudioMigration.up(db); nowenStudioHistoryMigration.up(db); return db;
}
test("AI proposal adds fields and changes layout without deleting private records", () => {
  const proposal = parsePersonalAIResponse("json\n"+JSON.stringify(model), original as any);
  assert.equal(proposal.layout, "board");
  assert.equal(proposal.items[0].values.title, "private item");
  assert.deepEqual(proposal.fields.map(x=>x.id), ["title","done","priority"]);
});
test("AI proposal is fail-closed for executable payloads, unknown props and destructive edits", () => {
  assert.throws(() => parsePersonalAIResponse(JSON.stringify({ ...model, javascript: "alert(1)" }), original as any), /STUDIO_AI_INVALID_OUTPUT/);
  assert.throws(() => parsePersonalAIResponse(JSON.stringify({ ...model, items: [{ id: "exfil", values: {} }] }), original as any), /STUDIO_AI_INVALID_OUTPUT/);
  assert.throws(() => parsePersonalAIResponse(JSON.stringify({ ...model, fields: model.fields.slice(1) }), original as any), /STUDIO_AI_DESTRUCTIVE_CHANGE/);
  assert.throws(() => parsePersonalAIResponse(JSON.stringify({ ...model, fields: [{ id: "title", label: "Title", type: "checkbox" }, ...model.fields.slice(1)] }), original as any), /STUDIO_AI_DESTRUCTIVE_CHANGE/);
  assert.throws(() => parsePersonalAIResponse("{ broken"), /STUDIO_AI_INVALID_OUTPUT/);
});
test("history saves a new snapshot for every commit, and a rollback is itself reversible", () => {
  const db = fixture();
  try {
    const first = createPersonalStudioApp(db, "alice", original);
    assert.deepEqual(listPersonalStudioVersions(db,"alice",first.id).map(x=>x.revision), [1]);
    const revised = updatePersonalStudioApp(db, "alice", first.id, first.revision, parsePersonalAIResponse(JSON.stringify(model), first.spec));
    assert.equal(revised.revision, 2);
    assert.equal(listPersonalStudioVersions(db,"alice",first.id)[0].name,"Work Tracker");
    const restored = restorePersonalStudioVersion(db, "alice", first.id, 1, 2);
    assert.equal(restored.revision, 3);
    assert.equal(restored.spec.name, "Tracker");
    assert.equal(restored.spec.items[0].values.title, "private item");
    assert.deepEqual(listPersonalStudioVersions(db,"alice",first.id).map(x=>x.revision), [3,2,1]);
    assert.throws(() => restorePersonalStudioVersion(db, "alice", first.id, 2, 2), /STUDIO_CONFLICT/);
    assert.throws(() => restorePersonalStudioVersion(db, "bob", first.id, 1, 3), /STUDIO_APP_NOT_FOUND/);
    assert.equal(getPersonalStudioApp(db, "alice", first.id).spec.name, "Tracker");
    deletePersonalStudioApp(db,"alice",first.id,3);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM personal_studio_app_versions").get() as any).n, 0);
  } finally { db.close(); }
});
test("history migration backfills a P0 app and rejects unavailable versions", () => {
  const db = new Database(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON; CREATE TABLE users (id TEXT PRIMARY KEY); INSERT INTO users(id) VALUES('alice');");
    nowenStudioMigration.up(db);
    const created = createPersonalStudioApp(db, "alice", original);
    nowenStudioHistoryMigration.up(db);
    assert.deepEqual(listPersonalStudioVersions(db,"alice",created.id).map(x=>x.revision), [1]);
    assert.throws(() => restorePersonalStudioVersion(db,"alice",created.id,999,1), /STUDIO_VERSION_NOT_FOUND/);
    nowenStudioHistoryMigration.up(db);
    assert.equal(listPersonalStudioVersions(db,"alice",created.id).length, 1);
  } finally { db.close(); }
});
test("history retains the last 25 committed snapshots with monotonic revision", () => {
  const db=fixture();
  try {
    let app = createPersonalStudioApp(db, "alice", original);
    for (let n=0;n<27;n++) app=updatePersonalStudioApp(db,"alice",app.id,app.revision,{ ...app.spec, description: String(n) });
    const rows=listPersonalStudioVersions(db,"alice",app.id);
    assert.equal(rows.length,25);
    assert.equal(rows[0].revision,28);
    assert.equal(rows[24].revision,4);
  } finally { db.close(); }
});
