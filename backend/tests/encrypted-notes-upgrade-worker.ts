import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Hono } from "hono";

// A separate process keeps the historical and current module-level DB paths isolated.
async function main() {
  const [, , backend, mode, report, filename] = process.argv;
  const load = (file: string) => import(pathToFileURL(path.join(backend, "src", file)).href);
  const { getDb, closeDb, getDbSchemaVersion } = await load("db/schema.ts");
  try {
    if (mode === "reject-newer") {
      assert.throws(() => getDb(), /高于当前程序支持/);
      fs.writeFileSync(report, "{}");
      return;
    }
    await load("runtime/knowledge-tree-migration-bootstrap.ts");
    await load("runtime/backup-restore-large-archive.ts");
    const { BackupManager } = await load("services/backup.ts");
    let db = getDb();
    const owner = "upgrade-owner";
    const vector = JSON.parse(fs.readFileSync(new URL("../../frontend/src/lib/encryptedNotes/__tests__/fixtures/envelope-v1.json", import.meta.url), "utf8"));
    const cipher = JSON.stringify(vector.envelope);
    const image = path.join(process.env.ELECTRON_USER_DATA!, "attachments", "upgrade.png");
    function snapshot() {
      return {
        notes: db.prepare("SELECT id, title, content, contentText, contentFormat, version FROM notes ORDER BY id").all(),
        history: db.prepare("SELECT id, noteId, content, contentText, contentFormat, version FROM note_versions ORDER BY id").all(),
        attachments: db.prepare("SELECT id, noteId, filename, mimeType, size, path FROM attachments ORDER BY id").all(),
        outbox: db.prepare("SELECT id, entityType, entityId, payload FROM sync_outbox ORDER BY id").all(),
        image: fs.readFileSync(image).toString("base64"),
      };
    }
    if (mode === "seed") {
      db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, 'hash')").run(owner, owner);
      db.prepare("INSERT INTO notebooks (id, userId, name) VALUES ('upgrade-notebook', ?, 'Public')").run(owner);
      const { createProfile } = await load("sync/profile.ts");
      const { ensureDevice } = await load("sync/device.ts");
      const { enqueueMutation } = await load("sync/outbox.ts");
      const profile = createProfile(db, { name: "Upgrade fixture", serverUrl: "http://fixture.invalid", remoteUserId: owner });
      const device = ensureDevice(db, { profileId: profile.id, platform: "test" });
      const entries = [
        ["upgrade-md", "markdown", "## Ordinary Markdown\n![photo](/api/attachments/upgrade-photo)"],
        ["upgrade-rich", "tiptap-json", JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Ordinary rich text" }] }] })],
        ["upgrade-encrypted", "encrypted-note-v1", cipher],
      ];
      for (const [id, format, content] of entries) {
        const preview = format === "encrypted-note-v1" ? "" : "Ordinary preview";
        db.prepare("INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat, version) VALUES (?, ?, 'upgrade-notebook', 'Public', ?, ?, ?, 1)").run(id, owner, content, preview, format);
        db.prepare("INSERT INTO note_versions (id, noteId, userId, title, content, contentText, contentFormat, version) VALUES (?, ?, ?, 'Public', ?, ?, ?, 1)").run(id + "-history", id, owner, content, preview, format);
        db.transaction(() => enqueueMutation(db, { profileId: profile.id, deviceId: device.id, entityType: "note", entityId: id,
          operation: "upsert", baseVersion: 1, payload: db.prepare("SELECT * FROM notes WHERE id = ?").get(id) }))();
      }
      const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ1kAAAAASUVORK5CYII=", "base64");
      fs.mkdirSync(path.dirname(image), { recursive: true }); fs.writeFileSync(image, bytes);
      db.prepare("INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path) VALUES ('upgrade-photo', 'upgrade-md', ?, 'upgrade.png', 'image/png', ?, 'upgrade.png')").run(owner, bytes.length);
      const backup = await new BackupManager().createBackup({ type: "full" });
      const state = snapshot();
      assert.ok(state.outbox.length > 0, "the historical fixture must include queued sync changes");
      fs.writeFileSync(report, JSON.stringify({ schemaVersion: getDbSchemaVersion(), snapshot: state, backup: backup.filename }));
      return;
    }
    if (mode === "restore") {
      const restored = await new BackupManager().restoreFromBackup(filename, { dryRun: false });
      assert.equal(restored.success, true, restored.error);
      db = getDb();
    }
    const before = snapshot();
    if (mode === "upgrade") {
      const { initAuditTables } = await load("services/audit.ts"); initAuditTables();
      const { default: notes } = await load("routes/notes.ts");
      const app = new Hono().route("/notes", notes);
      for (const id of ["upgrade-md", "upgrade-rich", "upgrade-encrypted"]) {
        const note = db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
        const response = await app.request("/notes/" + id, {
          method: "PUT", headers: { "X-User-Id": owner, "Content-Type": "application/json" },
          body: JSON.stringify({ content: note.content, contentText: note.contentText, contentFormat: note.contentFormat, version: note.version }),
        });
        assert.equal(response.status, 200, await response.clone().text());
        assert.equal(db.prepare("SELECT version FROM notes WHERE id = ?").get(id).version, 2);
        const updated = db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
        const { applyMutation } = await load("sync/apply.ts");
        assert.equal(applyMutation(db, { mutationId: id + "-sync", deviceId: "upgrade-device", entityType: "note", entityId: id, userId: owner, operation: "upsert", baseVersion: updated.version, payload: updated }).status, "applied");
        assert.equal(db.prepare("SELECT version FROM notes WHERE id = ?").get(id).version, 3);
      }
      assert.throws(() => db.prepare("UPDATE notes SET content = 'must-never-persist' WHERE id = 'upgrade-encrypted'").run(), /INVALID_ENCRYPTED_NOTE/);
      assert.throws(() => db.prepare("UPDATE notes SET contentFormat = 'markdown' WHERE id = 'upgrade-encrypted'").run(), /INVALID_ENCRYPTED_NOTE/);
      assert.throws(() => db.prepare("UPDATE note_versions SET content = 'must-never-persist' WHERE noteId = 'upgrade-encrypted'").run(), /INVALID_ENCRYPTED_NOTE_HISTORY/);
    }
    fs.writeFileSync(report, JSON.stringify({ schemaVersion: getDbSchemaVersion(), snapshot: before, afterWrites: snapshot() }));
  } finally { closeDb(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
