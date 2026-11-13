import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { nowenStudioMigration } from "../src/db/nowenStudioMigration.js";
import { createPersonalStudioApp, deletePersonalStudioApp, getPersonalStudioApp, listPersonalStudioApps, parsePersonalAppSpec, updatePersonalStudioApp } from "../src/plugins/personalStudioApps.js";

const valid = { schemaVersion: 1, name: "My list", description: "", layout: "list", fields: [
  { id: "title", label: "Title", type: "text" }, { id: "done", label: "Done", type: "checkbox" }
], items: [{ id: "one", values: { title: "First", done: false } }] };
function fixture() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE users (id TEXT PRIMARY KEY); INSERT INTO users(id) VALUES('alice'),('bob');");
  nowenStudioMigration.up(db);
  return db;
}
test("personal Studio apps are private to their owner and never executable code", () => {
  const db = fixture();
  try {
    const app = createPersonalStudioApp(db, "alice", valid);
    assert.equal(listPersonalStudioApps(db, "alice").length, 1);
    assert.equal(listPersonalStudioApps(db, "bob").length, 0);
    assert.throws(() => getPersonalStudioApp(db, "bob", app.id), /STUDIO_APP_NOT_FOUND/);
    assert.throws(() => updatePersonalStudioApp(db, "bob", app.id, 1, valid), /STUDIO_APP_NOT_FOUND/);
    assert.throws(() => deletePersonalStudioApp(db, "bob", app.id, 1), /STUDIO_APP_NOT_FOUND/);
    assert.throws(() => createPersonalStudioApp(db, "", valid), /RESOURCE_FORBIDDEN/);
    assert.throws(() => parsePersonalAppSpec({ ...valid, script: "window.parent.location='https://evil.test'" }), /STUDIO_INVALID_SPEC/);
    assert.throws(() => parsePersonalAppSpec({ ...valid, items: [{ id: "x", values: { done: "yes" } }] }), /STUDIO_INVALID_SPEC/);
  } finally { db.close(); }
});
test("optimistic revisions reject stale saves and stale deletes without changing records", () => {
  const db = fixture();
  try {
    const app = createPersonalStudioApp(db, "alice", valid);
    const next = updatePersonalStudioApp(db, "alice", app.id, app.revision, { ...valid, name: "Updated" });
    assert.equal(next.revision, 2);
    assert.throws(() => updatePersonalStudioApp(db, "alice", app.id, 1, valid), /STUDIO_CONFLICT/);
    assert.throws(() => deletePersonalStudioApp(db, "alice", app.id, 1), /STUDIO_CONFLICT/);
    assert.equal(getPersonalStudioApp(db, "alice", app.id).spec.name, "Updated");
    deletePersonalStudioApp(db, "alice", app.id, 2);
    assert.equal(listPersonalStudioApps(db, "alice").length, 0);
  } finally { db.close(); }
});
test("Studio limits fields, items, duplicate ids and unsupported value shapes", () => {
  assert.throws(() => parsePersonalAppSpec({ ...valid, fields: [valid.fields[0],valid.fields[0]] }), /STUDIO_INVALID_SPEC/);
  assert.throws(() => parsePersonalAppSpec({ ...valid, items: [valid.items[0],valid.items[0]] }), /STUDIO_INVALID_SPEC/);
  assert.throws(() => parsePersonalAppSpec({ ...valid, fields: valid.fields.slice(0,1), items: valid.items }), /STUDIO_INVALID_SPEC/);
  assert.throws(() => parsePersonalAppSpec({ ...valid, items: Array.from({ length: 101 }, (_, i) => ({ id: "i" + i, values: {} })) }), /STUDIO_INVALID_SPEC/);
});
test("migration is idempotent and survives reopening", () => {
  const db = fixture();
  try { nowenStudioMigration.up(db); const a = createPersonalStudioApp(db, "alice", valid); nowenStudioMigration.up(db); assert.equal(getPersonalStudioApp(db, "alice", a.id).spec.name, valid.name); } finally { db.close(); }
});
