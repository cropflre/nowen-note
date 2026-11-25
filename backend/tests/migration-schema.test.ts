import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrationHubMigration, migrationHubRecoveryLedgerMigration } from "../src/db/migrationHubMigration";
import { migrationUploadSessionsMigration } from "../src/db/migrationUploadSessionsMigration";
import { migrationDecisionsMigration } from "../src/db/migrationDecisionsMigration";
import { migrationStableSourcesMigration } from "../src/db/migrationStableSourcesMigration";

test("migration schema is additive and repairs an interrupted development schema without changing user notes", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES ('owner'); CREATE TABLE notes(id TEXT PRIMARY KEY,content TEXT); INSERT INTO notes VALUES ('existing','retained user body');");
    migrationHubMigration.up(db);
    db.exec("ALTER TABLE migration_jobs DROP COLUMN stagedBytes");
    db.prepare("INSERT INTO migration_jobs(id,userId,operationId,requestHash,name,sourceJson) VALUES ('job','owner','operation','hash','Migration','{}')").run();
    db.prepare("INSERT INTO migration_items(id,jobId,sourceKey,contentHash,payloadHash,metadataJson,contentPath) VALUES ('item','job','source','hash','payload',?,'contents/item.txt')")
      .run(JSON.stringify({ contentBytes: 20 }));
    db.exec("DROP TABLE migration_objects");
    migrationHubRecoveryLedgerMigration.up(db); migrationHubRecoveryLedgerMigration.up(db);
    assert.equal((db.prepare("SELECT content FROM notes WHERE id='existing'").get() as { content: string }).content, "retained user body");
    assert.ok((db.prepare("SELECT stagedBytes AS n FROM migration_jobs WHERE id='job'").get() as { n: number }).n >= 20);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='migration_objects'").get());
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM migration_items").get() as { n: number }).n, 1);
  } finally { db.close(); }
});

test("P1 schema upgrades preserve pending upload receipts, existing items and user notes", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES ('owner'); CREATE TABLE notes(id TEXT PRIMARY KEY,content TEXT); INSERT INTO notes VALUES ('existing','retained user body'); CREATE TABLE note_import_origins(userId TEXT,workspaceScope TEXT,contentHash TEXT)");
    migrationHubMigration.up(db);
    db.prepare("INSERT INTO migration_jobs(id,userId,operationId,requestHash,name,sourceJson) VALUES ('job','owner','operation','hash','Migration','{}')").run();
    db.prepare("INSERT INTO migration_items(id,jobId,sourceKey,contentHash,payloadHash,metadataJson,contentPath) VALUES ('item','job','source','hash','payload','{}','contents/item.txt')").run();
    migrationUploadSessionsMigration.up(db);
    db.prepare("INSERT INTO migration_upload_sessions(id,jobId,operationId,requestHash,filename,size,sha256,offset,expiresAt) VALUES ('upload','job','file-operation','request','file.zip',8,?,4,'2099-01-01T00:00:00Z')").run("a".repeat(64));
    db.prepare("INSERT INTO migration_upload_chunks(uploadId,offset,size,sha256) VALUES ('upload',0,4,?)").run("b".repeat(64));
    for (const column of ["finalizeTokenId", "publishedIdentity", "error"]) db.exec(`ALTER TABLE migration_upload_sessions DROP COLUMN ${column}`);
    for (let pass = 0; pass < 2; pass++) {
      migrationUploadSessionsMigration.up(db); migrationDecisionsMigration.up(db); migrationStableSourcesMigration.up(db);
    }
    assert.equal((db.prepare("SELECT content FROM notes WHERE id='existing'").get() as { content: string }).content, "retained user body");
    assert.equal((db.prepare("SELECT decision FROM migration_items WHERE id='item'").get() as { decision: string }).decision, "auto");
    assert.throws(() => db.prepare("UPDATE migration_items SET decision='overwrite' WHERE id='item'").run(), /CHECK constraint/);
    assert.equal((db.prepare("SELECT offset FROM migration_upload_sessions WHERE id='upload'").get() as { offset: number }).offset, 4);
    assert.equal((db.prepare("SELECT size FROM migration_upload_chunks WHERE uploadId='upload'").get() as { size: number }).size, 4);
    assert.ok(db.prepare("SELECT finalizeTokenId,publishedIdentity,error FROM migration_upload_sessions WHERE id='upload'").get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_migration_item_target'").get());
  } finally { db.close(); }
});
