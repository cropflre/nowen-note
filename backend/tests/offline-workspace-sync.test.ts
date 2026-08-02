import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-offline-workspace-sync-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

const ownerId = "offline-owner";
const viewerId = "offline-viewer";
const notebookId = "offline-notebook";
const noteId = "offline-note";
const attachmentId = "11111111-1111-4111-8111-111111111111";
let db: Database.Database;
let closeDb: () => void;
let app: Hono;

function headers(userId: string): HeadersInit {
  return { "X-User-Id": userId };
}

test.before(async () => {
  const schema = await import("../src/db/schema");
  const route = await import("../src/routes/offline-sync");
  db = schema.getDb();
  closeDb = schema.closeDb;
  app = new Hono();
  app.route("/api/offline-sync", route.default);

  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(ownerId, ownerId, "hash");
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(viewerId, viewerId, "hash");
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)")
    .run(notebookId, ownerId, "Offline notebook");
  db.prepare(`
    INSERT INTO notebook_members (
      id, notebookId, userId, role, status, allowDownload, allowReshare, invitedBy
    ) VALUES (?, ?, ?, 'viewer', 'active', 0, 0, ?)
  `).run("offline-member", notebookId, viewerId, ownerId);
  db.prepare(`
    INSERT INTO notes (
      id, userId, notebookId, title, content, contentText, contentFormat, version
    ) VALUES (?, ?, ?, ?, ?, ?, 'markdown', 1)
  `).run(noteId, ownerId, notebookId, "Offline note", "# complete body", "complete body");
  db.prepare(`
    INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path)
    VALUES (?, ?, ?, 'diagram.png', 'image/png', 128, ?)
  `).run(attachmentId, noteId, ownerId, path.join(tmpDir, "diagram.png"));
});

test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("owner plan and snapshot include every full note body and downloadable attachment", async () => {
  const planResponse = await app.request("/api/offline-sync/plan?workspaceId=personal", {
    headers: headers(ownerId),
  });
  assert.equal(planResponse.status, 200);
  const plan = await planResponse.json() as any;
  assert.equal(plan.noteCount, 1);
  assert.equal(plan.attachmentCount, 1);
  assert.equal(plan.attachmentBytes, 128);
  assert.equal(typeof plan.accessFingerprint, "string");
  assert.ok(plan.accessFingerprint.length > 20);

  const snapshotResponse = await app.request(
    `/api/offline-sync/snapshot?workspaceId=personal&limit=1&snapshotSequence=${plan.serverSequence}`,
    { headers: headers(ownerId) },
  );
  assert.equal(snapshotResponse.status, 200);
  const snapshot = await snapshotResponse.json() as any;
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].note.id, noteId);
  assert.equal(snapshot.items[0].note.content, "# complete body");
  assert.equal(snapshot.items[0].note.contentText, "complete body");
  assert.equal(snapshot.items[0].attachments[0].id, attachmentId);
  assert.equal(snapshot.items[0].attachmentDownloadAllowed, true);
});

test("viewer receives full text but no attachment manifest when download permission is disabled", async () => {
  const planResponse = await app.request("/api/offline-sync/plan?workspaceId=personal", {
    headers: headers(viewerId),
  });
  assert.equal(planResponse.status, 200);
  const plan = await planResponse.json() as any;
  assert.equal(plan.noteCount, 1);
  assert.equal(plan.attachmentCount, 0);

  const snapshotResponse = await app.request("/api/offline-sync/snapshot?workspaceId=personal", {
    headers: headers(viewerId),
  });
  assert.equal(snapshotResponse.status, 200);
  const snapshot = await snapshotResponse.json() as any;
  assert.equal(snapshot.items[0].note.content, "# complete body");
  assert.deepEqual(snapshot.items[0].attachments, []);
  assert.equal(snapshot.items[0].attachmentDownloadAllowed, false);
});

test("incremental feed returns committed updates and durable deletion tombstones", async () => {
  const baselineResponse = await app.request("/api/offline-sync/plan?workspaceId=personal", {
    headers: headers(ownerId),
  });
  const baseline = await baselineResponse.json() as any;

  db.prepare(`
    UPDATE notes
    SET content = '# changed offline body', contentText = 'changed offline body',
        version = version + 1, updatedAt = datetime('now')
    WHERE id = ?
  `).run(noteId);

  const changesResponse = await app.request(
    `/api/offline-sync/changes?workspaceId=personal&after=${baseline.serverSequence}`,
    { headers: headers(ownerId) },
  );
  assert.equal(changesResponse.status, 200);
  const changes = await changesResponse.json() as any;
  const upsert = changes.items.find((item: any) => item.note?.id === noteId);
  assert.ok(upsert);
  assert.equal(upsert.operation, "upsert");
  assert.equal(upsert.note.content, "# changed offline body");

  const afterUpdate = changes.nextSequence;
  db.prepare("DELETE FROM notes WHERE id = ?").run(noteId);

  const tombstoneResponse = await app.request(
    `/api/offline-sync/changes?workspaceId=personal&after=${afterUpdate}`,
    { headers: headers(ownerId) },
  );
  assert.equal(tombstoneResponse.status, 200);
  const tombstones = await tombstoneResponse.json() as any;
  assert.ok(tombstones.items.some((item: any) => (
    item.operation === "delete" && item.noteId === noteId
  )));
});

test("workspace scope rejects non-members and acknowledgement persists the client cursor", async () => {
  const workspaceId = "offline-private-workspace";
  db.prepare("INSERT INTO workspaces (id, name, ownerId) VALUES (?, ?, ?)")
    .run(workspaceId, "Private workspace", ownerId);

  const forbidden = await app.request(
    `/api/offline-sync/plan?workspaceId=${workspaceId}`,
    { headers: headers(viewerId) },
  );
  assert.equal(forbidden.status, 403);

  const ack = await app.request("/api/offline-sync/ack", {
    method: "POST",
    headers: { ...headers(ownerId), "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: "desktop-client", scopeKey: "personal", sequence: 5 }),
  });
  assert.equal(ack.status, 200);
  const row = db.prepare(`
    SELECT lastSequence FROM offline_sync_clients
    WHERE clientId = ? AND userId = ? AND scopeKey = ?
  `).get("desktop-client", ownerId, "personal") as { lastSequence: number };
  assert.equal(row.lastSequence, 5);
});
