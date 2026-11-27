/**
 * Excel 工作簿：旧库升级与全量备份恢复。功能来源：cropflre/nowen-note PR #802。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const directory = path.dirname(process.env.DB_PATH!);
process.env.BACKUP_DIR = path.join(directory, "source-backups");

test("旧库升级只新增 excel_documents，不改动已有笔记和轻量表格", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  const { getDb } = await import("../src/db/schema.js");
  const { runMigrations } = await import("../src/db/migrations.js");
  const { createKnowledgeChild } = await import("../src/services/knowledgeTree.js");
  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES ('legacy-owner', 'legacy-owner', 'hash')").run();
  const folder = createKnowledgeChild({ actorUserId: "legacy-owner", workspaceId: null, parentId: null, nodeType: "folder", title: "旧库", db });
  const sheet = createKnowledgeChild({ actorUserId: "legacy-owner", workspaceId: null, parentId: folder.id, nodeType: "sheet", title: "轻量表", db });
  db.prepare("UPDATE sheets SET data = ? WHERE noteId = ?")
    .run(JSON.stringify({ version: 1, rows: [{ id: "r1", height: 32 }], columns: [{ id: "c1", width: 120, title: "A", type: "text", align: "left" }], cells: { "r1:c1": "保留" } }), sheet.resourceId);

  // 模拟尚未安装工作簿的旧库状态，保留与工作簿无关的迁移台账。
  db.exec("DROP TABLE excel_documents");
  db.prepare("DELETE FROM schema_migrations WHERE version IN (148, 149)").run();
  const before = {
    notes: db.prepare("SELECT id, note_type, content, contentText, updatedAt FROM notes ORDER BY id").all(),
    sheets: db.prepare("SELECT * FROM sheets ORDER BY noteId").all(),
  };

  assert.equal(runMigrations(db), 2);
  assert.deepEqual(
    db.prepare("SELECT version FROM schema_migrations WHERE version IN (148, 149) ORDER BY version").all(),
    [{ version: 148 }, { version: 149 }],
  );
  const columns = (db.prepare("PRAGMA table_info(excel_documents)").all() as Array<{ name: string }>).map((column) => column.name);
  assert.deepEqual(columns, ["noteId", "userId", "workspaceId", "data", "revision", "createdAt", "updatedAt"]);
  assert.deepEqual({
    notes: db.prepare("SELECT id, note_type, content, contentText, updatedAt FROM notes ORDER BY id").all(),
    sheets: db.prepare("SELECT * FROM sheets ORDER BY noteId").all(),
  }, before);
  assert.equal(runMigrations(db), 0);

  // 升级后的轻量表格照常可建，Excel 表格与之互不影响。
  const excel = createKnowledgeChild({ actorUserId: "legacy-owner", workspaceId: null, parentId: folder.id, nodeType: "excel", title: "新表", db });
  assert.equal((db.prepare("SELECT revision FROM excel_documents WHERE noteId = ?").get(excel.resourceId) as any).revision, 1);
  assert.equal((db.prepare("SELECT count(*) AS count FROM sheets WHERE noteId = ?").get(excel.resourceId) as any).count, 0);
});

test("DCC-008: 全量备份在全新实例恢复后工作簿快照逐字节一致", async () => {
  await import("../src/runtime/knowledge-tree-migration-bootstrap.js");
  await import("../src/runtime/backup-restore-large-archive.js");
  const { getDb } = await import("../src/db/schema.js");
  const { BackupManager } = await import("../src/services/backup.js");
  const { createKnowledgeChild } = await import("../src/services/knowledgeTree.js");
  const { initAuditTables } = await import("../src/services/audit.js");
  initAuditTables();
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO users (id, username, passwordHash) VALUES ('backup-owner', 'backup-owner', 'hash')").run();
  const folder = createKnowledgeChild({ actorUserId: "backup-owner", workspaceId: null, parentId: null, nodeType: "folder", title: "备份", db });
  const node = createKnowledgeChild({ actorUserId: "backup-owner", workspaceId: null, parentId: folder.id, nodeType: "excel", title: "备份表", db });
  const data = JSON.stringify({
    id: "workbook-01", sheetOrder: ["s1", "s2"], styles: {},
    sheets: {
      s1: { id: "s1", name: "一", cellData: { 0: { 0: { v: 2, t: 2 }, 1: { f: "=A1*3", v: 6, t: 2 } } }, mergeData: [{ startRow: 1, endRow: 2, startColumn: 0, endColumn: 1 }] },
      s2: { id: "s2", name: "二", cellData: { 0: { 0: { f: "='一'!B1+1", v: 7, t: 2 } } }, mergeData: [] },
    },
  });
  db.prepare("UPDATE excel_documents SET data = ?, revision = 5 WHERE noteId = ?").run(data, node.resourceId);

  const manager = new BackupManager();
  const backup = await manager.createBackup({ type: "full", description: "excel workbook fixture" });
  const destination = path.join(directory, "fresh-installation");
  const backups = path.join(destination, "backups");
  fs.mkdirSync(backups, { recursive: true });
  fs.copyFileSync(path.join(manager.getBackupDir(), backup.filename), path.join(backups, backup.filename));
  const reportPath = path.join(destination, "excel-report.json");
  const worker = fileURLToPath(new URL("./excel-workbook-recovery-worker.ts", import.meta.url));
  await promisify(execFile)(process.execPath, ["--import", "tsx", worker, backup.filename, node.resourceId, reportPath], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 60_000,
    env: { ...process.env, NODE_ENV: "test", DB_PATH: path.join(destination, "restored.db"), ELECTRON_USER_DATA: destination, BACKUP_DIR: backups },
  });
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(report.document.data, data);
  assert.equal(report.document.revision, 5);
  assert.equal(report.note.noteType, "excel");
});
