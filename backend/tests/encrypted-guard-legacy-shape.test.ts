import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { getDb, closeDb } from "../src/db/schema.js";
import { runMigrations } from "../src/db/migrations.js";

const vector = JSON.parse(fs.readFileSync(new URL("../../frontend/src/lib/encryptedNotes/__tests__/fixtures/envelope-v1.json", import.meta.url), "utf8"));

test.after(() => closeDb());

// 旧 runner 只比较 MAX(version)，被跳过的迁移永远不会补跑。从 v1.5.1 及更早版本升级
// 上来的库，v123 可能已登记、但 encrypted_notes_update 仍是 v117 时代的旧形态
// （"ON notes" 与 "WHEN" 之间有换行缩进），且 v135 从未执行。v135 原实现按字面量
// "ON notes WHEN" 匹配该 SQL，会抛 ENCRYPTED_DECRYPTION_GUARD_MIGRATION_MISMATCH，
// 整个进程无法启动。本用例锁定这条升级路径。
const LEGACY_TRIGGER = `CREATE TRIGGER encrypted_notes_update BEFORE UPDATE ON notes
      WHEN (OLD.contentFormat LIKE 'encrypted-%' AND (
        NEW.contentFormat IS NOT OLD.contentFormat OR (CASE WHEN json_valid(NEW.content) = 0 THEN 1 ELSE
      CASE WHEN json_extract(NEW.content, '$.version') IS 1 THEN 1 ELSE 0 END END)
      ))
    BEGIN SELECT RAISE(ABORT,'INVALID_ENCRYPTED_NOTE'); END;`;

test("v135 upgrades a database whose encrypted_notes_update predates v123", () => {
  const db = getDb();
  db.exec("SAVEPOINT legacy_guard_fixture");
  try {
    // v123 已应用（旧 runner 的常态），但触发器仍是旧形态，且 v135 缺失
    db.exec(`DROP TRIGGER IF EXISTS encrypted_notes_update; ${LEGACY_TRIGGER}`);
    db.prepare("DELETE FROM schema_migrations WHERE version = 135").run();

    const legacy = (db.prepare("SELECT sql FROM sqlite_master WHERE name='encrypted_notes_update'").get() as { sql: string }).sql;
    assert.equal(legacy.includes("ON notes WHEN"), false, "fixture must reproduce the legacy whitespace shape");

    assert.doesNotThrow(() => runMigrations(db), "v135 must not reject a pre-v123 trigger shape");

    const migrated = (db.prepare("SELECT sql FROM sqlite_master WHERE name='encrypted_notes_update'").get() as { sql: string }).sql;
    assert.ok(migrated.includes("encrypted_note_decryption_permits"), "decryption permit must be installed");
    assert.match(migrated, /BEGIN\s+SELECT\s+RAISE/i, "the guard must still abort invalid updates");

    // 旧形态允许"保持加密格式修改内容"通过；重建后必须拦截。
    db.prepare("INSERT OR IGNORE INTO users(id,username,passwordHash) VALUES ('migration-owner','migration-owner','hash')").run();
    db.prepare("INSERT OR IGNORE INTO notebooks(id,userId,name) VALUES ('migration-notebook','migration-owner','Fixture')").run();
    db.prepare("INSERT OR REPLACE INTO notes(id,userId,notebookId,title,content,contentText,contentFormat) VALUES ('legacy-guard-note','migration-owner','migration-notebook','Encrypted fixture',?,'','encrypted-note-v1')")
      .run(JSON.stringify(vector.envelope));
    assert.throws(
      () => db.prepare("UPDATE notes SET content = ? WHERE id = 'legacy-guard-note'").run(JSON.stringify({ ...vector.envelope, tampered: true })),
      /INVALID_ENCRYPTED_NOTE/,
    );
  } finally {
    db.exec("ROLLBACK TO legacy_guard_fixture; RELEASE legacy_guard_fixture");
  }
});
