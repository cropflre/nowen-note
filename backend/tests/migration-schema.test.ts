import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrationHubMigration, migrationHubRecoveryLedgerMigration } from "../src/db/migrationHubMigration";

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
