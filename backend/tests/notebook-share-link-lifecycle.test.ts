import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-invite-lifecycle-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.ELECTRON_USER_DATA = dir;

let closeDb: () => void;

test("invite link enforces unique join limit and revoke removes only link members", async () => {
  const [{ default: notebooksRouter }, schema] = await Promise.all([
    import("../src/routes/notebooks"), import("../src/db/schema"),
  ]);
  closeDb = schema.closeDb;
  const db = schema.getDb();
  for (const id of ["owner", "member-a", "member-b"]) {
    db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')").run(id, id);
  }
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES ('nb', 'owner', 'Notebook')").run();
  const app = new Hono();
  app.route("/notebooks", notebooksRouter);

  const created = await app.request("/notebooks/nb/share-link", {
    method: "POST", headers: { "X-User-Id": "owner", "Content-Type": "application/json" },
    body: JSON.stringify({ role: "viewer", maxUses: 1 }),
  });
  assert.equal(created.status, 201);
  const link = await created.json() as { id: string; token: string; maxUses: number; useCount: number };
  assert.equal(link.maxUses, 1);
  assert.equal(link.useCount, 0);

  const first = await app.request(`/notebooks/share/${link.token}/join`, { method: "POST", headers: { "X-User-Id": "member-a" } });
  assert.equal(first.status, 200);
  const repeat = await app.request(`/notebooks/share/${link.token}/join`, { method: "POST", headers: { "X-User-Id": "member-a" } });
  assert.equal(repeat.status, 200);
  const exhausted = await app.request(`/notebooks/share/${link.token}/join`, { method: "POST", headers: { "X-User-Id": "member-b" } });
  assert.equal(exhausted.status, 410);

  const member = db.prepare("SELECT status, source, sourceId FROM notebook_members WHERE notebookId = 'nb' AND userId = 'member-a'").get() as any;
  assert.equal(member.status, "active"); assert.equal(member.source, "invite_link"); assert.equal(member.sourceId, link.id);

  const revoked = await app.request("/notebooks/nb/share-link", { method: "DELETE", headers: { "X-User-Id": "owner" } });
  assert.equal(revoked.status, 200);
  const removed = db.prepare("SELECT status FROM notebook_members WHERE notebookId = 'nb' AND userId = 'member-a'").get() as any;
  assert.equal(removed.status, "removed");
});

test.after(() => {
  closeDb?.();
  fs.rmSync(dir, { recursive: true, force: true });
});
