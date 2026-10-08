import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createDecipheriv } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import JSZip from "jszip";
import { Hono } from "hono";
import { closeDb, getDb } from "../src/db/schema.js";
import { ENCRYPTED_NOTE_FORMAT, parseEncryptedNote } from "../src/lib/encryptedNotes.js";

const vector = JSON.parse(fs.readFileSync(new URL("../../frontend/src/lib/encryptedNotes/__tests__/fixtures/envelope-v1.json", import.meta.url), "utf8"));
const content = JSON.stringify(vector.envelope);
const directory = path.dirname(process.env.DB_PATH!);
process.env.BACKUP_DIR = path.join(directory, "source-backups");

function decryptSample(cipher: { iv: string; ciphertext: string }, key: Buffer, aad: string): Buffer {
  const bytes = Buffer.from(cipher.ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(cipher.iv, "base64"));
  decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]);
}
test.after(() => closeDb());

test("production full ZIP backup restores ciphertext, encrypted history and guards in a fresh installation", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  await import("../src/runtime/backup-restore-large-archive.js");
  const { BackupManager } = await import("../src/services/backup.js");
  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES ('backup-owner', 'backup-owner', 'hash')").run();
  const { initAuditTables } = await import("../src/services/audit.js"); initAuditTables();
  const { default: notes } = await import("../src/routes/notes.js");
  const app = new Hono().route("/notes", notes);
  const created = await app.request("/notes", { method: "POST", headers: { "X-User-Id": "backup-owner", "Content-Type": "application/json" }, body: JSON.stringify({ title: "Public metadata", content, contentFormat: ENCRYPTED_NOTE_FORMAT }) });
  assert.equal(created.status, 201);
  const note = await created.json() as any;
  db.prepare("INSERT INTO note_versions (id, noteId, userId, title, content, contentText, contentFormat, version) VALUES ('backup-history', ?, 'backup-owner', 'Public metadata', ?, '', ?, 1)").run(note.id, content, ENCRYPTED_NOTE_FORMAT);

  const manager = new BackupManager();
  const backup = await manager.createBackup({ type: "full", description: "Public encrypted recovery fixture" });
  const filename = path.join(manager.getBackupDir(), backup.filename);
  const zip = await JSZip.loadAsync(fs.readFileSync(filename));
  assert.ok(zip.file("db.sqlite")); assert.ok(zip.file("meta.json"));
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const bytes = await entry.async("nodebuffer");
    for (const marker of [vector.plaintext, vector.passphrase, "must-never-persist"]) assert.equal(bytes.includes(marker), false, entry.name);
  }

  const destination = path.join(directory, "fresh-installation");
  const backups = path.join(destination, "backups");
  fs.mkdirSync(backups, { recursive: true });
  fs.copyFileSync(filename, path.join(backups, backup.filename));
  const reportPath = path.join(destination, "recovery-report.json");
  const worker = fileURLToPath(new URL("./encrypted-notes-recovery-worker.ts", import.meta.url));
  await promisify(execFile)(process.execPath, ["--import", "tsx", worker, backup.filename, note.id, reportPath], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 30_000,
    env: { ...process.env, NODE_ENV: "test", DB_PATH: path.join(destination, "restored.db"), ELECTRON_USER_DATA: destination, BACKUP_DIR: backups },
  });
  const restored = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(restored.note.content, content); assert.equal(restored.note.contentText, "");
  assert.equal(restored.note.contentFormat, ENCRYPTED_NOTE_FORMAT); assert.equal(restored.note.version, note.version);
  assert.equal(restored.history.length, 1);
  for (const row of restored.history) { assert.equal(row.content, content); assert.equal(row.contentText, ""); assert.equal(row.contentFormat, ENCRYPTED_NOTE_FORMAT); }
  parseEncryptedNote(restored.note.content);
  const envelope = JSON.parse(restored.note.content);
  const key = decryptSample(envelope.wrappedKey, Buffer.from(vector.derivedKeyHex, "hex"), vector.aadKeyUtf8);
  try { assert.equal(decryptSample(envelope.payload, key, vector.aadContentUtf8).toString("utf8"), vector.plaintext); }
  finally { key.fill(0); }
  for (const name of fs.readdirSync(destination)) {
    const candidate = path.join(destination, name);
    if (!fs.statSync(candidate).isFile()) continue;
    const bytes = fs.readFileSync(candidate);
    for (const marker of [vector.plaintext, vector.passphrase, "must-never-persist"]) assert.equal(bytes.includes(marker), false, name);
  }
});
