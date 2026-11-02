import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-upload-recovery-"));
process.env.DB_PATH = path.join(directory, "test.db");
process.env.ELECTRON_USER_DATA = directory;
let app: Hono;
let schema: typeof import("../src/db/schema");
const owner = "upload-recovery-owner";
const noteId = "upload-recovery-note";

test.before(async () => {
  schema = await import("../src/db/schema");
  const { default: router } = await import("../src/routes/attachments");
  app = new Hono();
  app.route("/attachments", router);
  const db = schema.getDb();
  for (const user of [owner, "other-user"]) db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')").run(user, user);
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES ('recovery-book', ?, 'Recovery')").run(owner);
  for (const id of [noteId, "other-note"]) db.prepare("INSERT INTO notes (id, userId, notebookId, title, content) VALUES (?, ?, 'recovery-book', 'Recovery', '{}')").run(id, owner);
});

test.after(() => {
  schema.closeDb();
  fs.rmSync(directory, { recursive: true, force: true });
});

function upload(id: string, bytes = "unique pdf", targetNote = noteId) {
  const form = new FormData();
  form.set("noteId", targetNote);
  form.set("uploadId", id);
  form.set("file", new File([bytes], "中文.pdf", { type: "application/pdf" }));
  return app.request("/attachments", { method: "POST", headers: { "X-User-Id": owner }, body: form });
}

function recover(id: string, user = owner, targetNote = noteId) {
  return app.request(`/attachments/upload-result/${id}?noteId=${targetNote}`, { headers: { "X-User-Id": user } });
}

test("DCC-003: lost upload responses recover the exact persisted PDF identity, including deduplicated uploads", async () => {
  for (let i = 0; i < 2; i++) {
    const id = randomUUID();
    const response = await upload(id);
    assert.equal(response.status, 201);
    const original = await response.json() as { id: string };
    assert.equal(original.id, id);
    const recovered = await recover(id);
    assert.equal(recovered.status, 200);
    assert.equal(recovered.headers.get("cache-control"), "private, no-store");
    const payload = await recovered.json() as { id: string; url: string; filename: string; category: string; accessUrls: Record<string, string> };
    assert.equal(payload.id, id);
    assert.equal(payload.url, `/api/attachments/${id}`);
    assert.equal(payload.filename, "中文.pdf");
    assert.equal(payload.category, "file");
    assert.ok(payload.accessUrls[id].includes("sig="));
    assert.equal((schema.getDb().prepare("SELECT count(*) AS n FROM attachments WHERE id = ?").get(id) as { n: number }).n, 1);
  }
});

test("DCC-006: upload recovery refuses another account, another note and missing or trashed attachments", async () => {
  const id = randomUUID();
  assert.equal((await upload(id, "private pdf")).status, 201);
  assert.equal((await recover(id, "other-user")).status, 403);
  assert.equal((await recover(id, owner, "other-note")).status, 404);
  assert.equal((await recover(randomUUID())).status, 404);
  schema.getDb().prepare("UPDATE attachments SET trashedAt = datetime('now') WHERE id = ?").run(id);
  assert.equal((await recover(id)).status, 404);
});

test("client upload IDs cannot overwrite an existing attachment or its physical bytes", async () => {
  const id = randomUUID();
  assert.equal((await upload(id, "original bytes")).status, 201);
  assert.equal((await upload(id, "replacement bytes")).status, 409);
  assert.equal((await upload("not-a-uuid")).status, 400);
  const row = schema.getDb().prepare("SELECT path FROM attachments WHERE id = ?").get(id) as { path: string };
  assert.equal(fs.readFileSync(path.join(directory, "attachments", row.path), "utf8"), "original bytes");
});

test("recovery does not report success for missing attachment bytes", async () => {
  const id = randomUUID();
  assert.equal((await upload(id, "missing physical file")).status, 201);
  const row = schema.getDb().prepare("SELECT path FROM attachments WHERE id = ?").get(id) as { path: string };
  fs.unlinkSync(path.join(directory, "attachments", row.path));
  assert.equal((await recover(id)).status, 404);
});

test("concurrent client ID collisions retain the winning object's bytes", async () => {
  const id = randomUUID();
  const contents = ["concurrent original", "concurrent second"];
  const responses = await Promise.all(contents.map((content) => upload(id, content)));
  const winner = responses.findIndex((response) => response.status === 201);
  assert.ok(winner >= 0);
  assert.equal(responses.filter((response) => response.status === 201).length, 1);
  const row = schema.getDb().prepare("SELECT path FROM attachments WHERE id = ?").get(id) as { path: string };
  assert.equal(fs.readFileSync(path.join(directory, "attachments", row.path), "utf8"), contents[winner]);
  assert.equal((await recover(id)).status, 200);
});
