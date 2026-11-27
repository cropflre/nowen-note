import assert from "node:assert/strict";
import fs from "node:fs";
import "../src/runtime/knowledge-tree-migration-bootstrap.js";
import "../src/runtime/backup-restore-large-archive.js";
import { getDb, closeDb } from "../src/db/schema.js";
import { BackupManager } from "../src/services/backup.js";

// 在全新进程中恢复，避免模块级数据库路径仍指向源实例。
async function main() {
  const [, , filename, noteId, reportPath] = process.argv;
  try {
    assert.equal((getDb().prepare("SELECT count(*) AS count FROM excel_documents").get() as any).count, 0);
    const restored = await new BackupManager().restoreFromBackup(filename, { dryRun: false });
    assert.equal(restored.success, true, restored.error);
    const db = getDb();
    const document = db.prepare("SELECT data, revision FROM excel_documents WHERE noteId = ?").get(noteId);
    const note = db.prepare("SELECT note_type AS noteType, contentText FROM notes WHERE id = ?").get(noteId);
    fs.writeFileSync(reportPath, JSON.stringify({ document, note }));
  } finally { closeDb(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
