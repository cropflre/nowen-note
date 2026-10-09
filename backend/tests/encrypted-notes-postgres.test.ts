import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";

test("PostgreSQL conversion permits require exact target/version/identity and the same transaction", { skip: !process.env.TEST_PG_DATABASE_URL }, async () => {
  const client = new Client({ connectionString: process.env.TEST_PG_DATABASE_URL });
  const schema = `encrypted_conversion_${randomUUID().replaceAll("-", "")}`;
  const vector = JSON.parse(fs.readFileSync(new URL("../../frontend/src/lib/encryptedNotes/__tests__/fixtures/envelope-v1.json", import.meta.url), "utf8"));
  const content = JSON.stringify(vector.envelope);
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}";
      CREATE TABLE notes (id TEXT PRIMARY KEY, "userId" TEXT DEFAULT 'owner', "workspaceId" TEXT,
        "isLocked" BOOLEAN DEFAULT false, "isTrashed" BOOLEAN DEFAULT false,
        content TEXT, "contentText" TEXT DEFAULT '', "contentFormat" TEXT, version INTEGER DEFAULT 1);
      CREATE TABLE note_versions (id TEXT PRIMARY KEY, "noteId" TEXT, content TEXT, "contentText" TEXT DEFAULT '', "contentFormat" TEXT, version INTEGER DEFAULT 1);
      CREATE TABLE embedding_queue ("noteId" TEXT PRIMARY KEY);
      CREATE TABLE block_operations ("noteId" TEXT PRIMARY KEY);`);
    for (const file of ["0117-encrypted-note-storage-guards.sql", "0118-encrypted-block-write-guards.sql", "0119-encrypted-note-conversion-guards.sql", "0123-encrypted-content-v2-storage.sql"]) {
      await client.query(fs.readFileSync(new URL(`../src/db/postgres/migrations/${file}`, import.meta.url), "utf8"));
    }
    await client.query("INSERT INTO notes (id,content,\"contentFormat\") VALUES ('plain','source','markdown'),('stale','source','markdown')");
    const update = `UPDATE notes SET content = $1, "contentFormat" = 'encrypted-note-v1', version = 2 WHERE id = 'plain'`;
    await assert.rejects(client.query(update, [content]), /INVALID_ENCRYPTED_NOTE/);
    await client.query("BEGIN");
    await client.query(`INSERT INTO encrypted_note_conversion_permits ("noteId","sourceVersion","sourceFormat",content) VALUES ('plain',1,'markdown',$1)`, [content]);
    for (const query of [
      `UPDATE notes SET content = $1, "contentFormat" = 'encrypted-note-v1', version = 3 WHERE id = 'plain'`,
      `UPDATE notes SET content = $1, "contentFormat" = 'encrypted-note-v1', version = 2, "userId" = 'other' WHERE id = 'plain'`,
      `UPDATE notes SET content = $1, "contentFormat" = 'encrypted-note-v1', version = 2, "contentText" = 'source' WHERE id = 'plain'`,
    ]) {
      await client.query("SAVEPOINT invalid_conversion");
      await assert.rejects(client.query(query, [content]), /INVALID_ENCRYPTED_NOTE/);
      await client.query("ROLLBACK TO SAVEPOINT invalid_conversion");
    }
    await client.query("SAVEPOINT wrong_target");
    const different = structuredClone(vector.envelope); different.objectId = randomUUID();
    await assert.rejects(client.query(update, [JSON.stringify(different)]), /INVALID_ENCRYPTED_NOTE/);
    await client.query("ROLLBACK TO SAVEPOINT wrong_target");
    await client.query(update, [content]);
    await client.query("DELETE FROM encrypted_note_conversion_permits WHERE \"noteId\" = 'plain'; COMMIT");
    assert.equal((await client.query("SELECT content FROM notes WHERE id = 'plain'")).rows[0].content, content);
    await assert.rejects(client.query(`UPDATE notes SET content = 'source', "contentFormat" = 'markdown' WHERE id = 'plain'`), /INVALID_ENCRYPTED_NOTE/);
    for (const table of ["embedding_queue", "block_operations"]) {
      await assert.rejects(client.query(`INSERT INTO ${table} VALUES ('plain')`), /ENCRYPTED_NOTE_DERIVED_CONTENT_FORBIDDEN/);
    }
    await client.query(`INSERT INTO encrypted_note_conversion_permits ("noteId","sourceVersion","sourceFormat",content) VALUES ('stale',1,'markdown',$1)`, [content]);
    await assert.rejects(client.query(`UPDATE notes SET content = $1, "contentFormat" = 'encrypted-note-v1', version = 2 WHERE id = 'stale'`, [content]), /INVALID_ENCRYPTED_NOTE/);
    await client.query("DELETE FROM encrypted_note_conversion_permits");
    assert.equal((await client.query("SELECT count(*) FROM encrypted_note_conversion_permits")).rows[0].count, "0");
    const v2 = JSON.parse(fs.readFileSync(new URL("../../frontend/src/lib/encryptedNotes/__tests__/fixtures/envelope-v2.json", import.meta.url), "utf8"));
    await client.query(`INSERT INTO notes(id,content,"contentFormat") VALUES ('v2',$1,'encrypted-note-v2')`, [JSON.stringify(v2.envelope)]);
    for (const patch of [{ keyEpoch: 2 }, { encryptionEpoch: 3 }, { objectId: randomUUID() }, { documentSchemaVersion: 2 }, { unknown: true }]) {
      await assert.rejects(client.query("UPDATE notes SET content = $1 WHERE id = 'v2'", [JSON.stringify({ ...v2.envelope, ...patch })]), /INVALID_ENCRYPTED_NOTE/);
    }
    await client.query(`INSERT INTO note_versions(id,"noteId",content,"contentFormat",version) VALUES ($1,'v2',$2,'encrypted-history-v2',3)`, [v2.history.historyId, JSON.stringify(v2.history)]);
    await assert.rejects(client.query("UPDATE note_versions SET content = $1 WHERE id = $2", [JSON.stringify({ ...v2.history, historyId: randomUUID() }), v2.history.historyId]), /INVALID_ENCRYPTED_NOTE_HISTORY/);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await client.end();
  }
});

// Explicit test connection only; never discover or use a configured product database.
test("PostgreSQL migration rejects downgrade/history/derived writes and preserves opaque versions", { skip: !process.env.TEST_PG_DATABASE_URL }, async () => {
  const client = new Client({ connectionString: process.env.TEST_PG_DATABASE_URL });
  const schema = `encrypted_test_${randomUUID().replaceAll("-", "")}`;
  const vector = JSON.parse(fs.readFileSync(new URL("../../frontend/src/lib/encryptedNotes/__tests__/fixtures/envelope-v1.json", import.meta.url), "utf8"));
  const migration = fs.readFileSync(new URL("../src/db/postgres/migrations/0117-encrypted-note-storage-guards.sql", import.meta.url), "utf8");
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"`);
    await client.query(`CREATE TABLE notes (id TEXT PRIMARY KEY, content TEXT, "contentText" TEXT DEFAULT '', "contentFormat" TEXT, version INTEGER DEFAULT 1);
      CREATE TABLE note_versions (id TEXT PRIMARY KEY, "noteId" TEXT, content TEXT, "contentText" TEXT DEFAULT '', "contentFormat" TEXT);
      CREATE TABLE shares (id TEXT PRIMARY KEY, "noteId" TEXT);
      CREATE TABLE attachments (id TEXT PRIMARY KEY, "noteId" TEXT);
      CREATE TABLE note_yupdates (id TEXT PRIMARY KEY, "noteId" TEXT);
      CREATE TABLE note_embeddings (id TEXT PRIMARY KEY, "noteId" TEXT);`);
    await client.query(migration);
    await client.query(fs.readFileSync(new URL("../src/db/postgres/migrations/0118-encrypted-block-write-guards.sql", import.meta.url), "utf8"));
    const content = JSON.stringify(vector.envelope);
    await client.query(`INSERT INTO notes (id, content, "contentFormat") VALUES ('encrypted', $1, 'encrypted-note-v1')`, [content]);
    const rows = await client.query("SELECT * FROM notes WHERE id = 'encrypted'"); assert.equal(rows.rows[0].content, content);
    for (const sql of [
      "UPDATE notes SET content = 'must-never-persist' WHERE id = 'encrypted'",
      `UPDATE notes SET "contentFormat" = 'markdown' WHERE id = 'encrypted'`,
      `UPDATE notes SET "contentText" = 'must-never-persist' WHERE id = 'encrypted'`,
    ]) await assert.rejects(client.query(sql));
    await client.query(`INSERT INTO note_versions VALUES ('history', 'encrypted', $1, '', 'encrypted-note-v1')`, [content]);
    await assert.rejects(client.query("UPDATE note_versions SET content = 'must-never-persist' WHERE id = 'history'"), /INVALID_ENCRYPTED_NOTE_HISTORY/);
    for (const table of ["shares", "attachments", "note_yupdates", "note_embeddings"]) {
      await assert.rejects(client.query(`INSERT INTO ${table} VALUES ('derived', 'encrypted')`), /ENCRYPTED_NOTE_DERIVED_CONTENT_FORBIDDEN/);
    }
    await client.query(`INSERT INTO notes (id, content, "contentFormat") VALUES ('plain', 'ordinary', 'markdown')`);
    await assert.rejects(client.query(`UPDATE notes SET content = $1, "contentFormat" = 'encrypted-note-v1' WHERE id = 'plain'`, [content]), /INVALID_ENCRYPTED_NOTE/);
    await client.query(`UPDATE notes SET content = $1, version = version + 1 WHERE id = 'encrypted' AND version = 1`, [content]);
    assert.equal((await client.query("SELECT version FROM notes WHERE id = 'encrypted'")).rows[0].version, 2);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await client.end();
  }
});

test("PostgreSQL region permits bind the exact note, content, format and transaction", { skip: !process.env.TEST_PG_DATABASE_URL }, async () => {
  const client = new Client({ connectionString: process.env.TEST_PG_DATABASE_URL });
  const schema = `encrypted_region_test_${randomUUID().replaceAll("-", "")}`;
  const vector = JSON.parse(fs.readFileSync(new URL("../../frontend/src/lib/encryptedNotes/__tests__/fixtures/envelope-v1.json", import.meta.url), "utf8"));
  const content = `Public before\n\n\`\`\`nowen-encrypted-v1\n${JSON.stringify({ ...vector.envelope, kind: "block" })}\n\`\`\``;
  const changed = content.replace("Public before", "Public edited");
  const migration = fs.readFileSync(new URL("../src/db/postgres/migrations/0118-encrypted-block-write-guards.sql", import.meta.url), "utf8");
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"`);
    await client.query(`CREATE TABLE notes (id TEXT PRIMARY KEY, content TEXT, "contentFormat" TEXT, version INTEGER DEFAULT 1)`);
    await client.query(migration);
    await client.query(`INSERT INTO notes (id, content, "contentFormat") VALUES ('protected', $1, 'markdown'), ('other', $1, 'markdown'), ('plain', 'ordinary', 'markdown')`, [content]);
    for (const [sql, params] of [
      ["UPDATE notes SET content = 'removed' WHERE id = 'protected'", []],
      [`UPDATE notes SET "contentFormat" = 'html' WHERE id = 'protected'`, []],
      ["UPDATE notes SET content = $1 WHERE id = 'protected'", [changed]],
      ["UPDATE notes SET content = $1 WHERE id = 'plain'", [content]],
    ] as [string, string[]][]) await assert.rejects(client.query(sql, params), /ENCRYPTED_BLOCK_WRITE_FORBIDDEN/);
    await client.query("UPDATE notes SET version = version + 1 WHERE id = 'protected'");
    await client.query("UPDATE notes SET content = content WHERE id = 'protected'");
    for (const [sql, params] of [
      ["UPDATE notes SET content = $1 WHERE id = 'other'", [changed]],
      ["UPDATE notes SET content = 'wrong target' WHERE id = 'protected'", []],
      [`UPDATE notes SET content = $1, "contentFormat" = 'html' WHERE id = 'protected'`, [changed]],
    ] as [string, string[]][]) {
      await client.query("BEGIN");
      await client.query(`INSERT INTO encrypted_block_write_permits ("noteId", content, "contentFormat") VALUES ('protected', $1, 'markdown')`, [changed]);
      await assert.rejects(client.query(sql, params), /ENCRYPTED_BLOCK_WRITE_FORBIDDEN/);
      await client.query("ROLLBACK");
    }
    // Even a deliberately leaked committed permit cannot authorize the next transaction.
    await client.query(`INSERT INTO encrypted_block_write_permits ("noteId", content, "contentFormat") VALUES ('protected', $1, 'markdown')`, [changed]);
    await assert.rejects(client.query("UPDATE notes SET content = $1 WHERE id = 'protected'", [changed]), /ENCRYPTED_BLOCK_WRITE_FORBIDDEN/);
    await client.query("DELETE FROM encrypted_block_write_permits");
    await client.query("BEGIN");
    await client.query(`INSERT INTO encrypted_block_write_permits ("noteId", content, "contentFormat") VALUES ('protected', $1, 'markdown')`, [changed]);
    await client.query("UPDATE notes SET content = $1 WHERE id = 'protected'", [changed]);
    await client.query("ROLLBACK");
    assert.equal((await client.query("SELECT content FROM notes WHERE id = 'protected'")).rows[0].content, content);
    await client.query("BEGIN");
    await client.query(`INSERT INTO encrypted_block_write_permits ("noteId", content, "contentFormat") VALUES ('protected', $1, 'markdown')`, [changed]);
    await client.query("UPDATE notes SET content = $1 WHERE id = 'protected'", [changed]);
    await client.query("DELETE FROM encrypted_block_write_permits");
    await client.query("COMMIT");
    assert.equal((await client.query("SELECT content FROM notes WHERE id = 'protected'")).rows[0].content, changed);
    assert.equal((await client.query("SELECT count(*) FROM encrypted_block_write_permits")).rows[0].count, "0");
    assert.equal((await client.query("SELECT content FROM notes WHERE id = 'other'")).rows[0].content, content);
  } finally {
    await client.query("ROLLBACK");
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await client.end();
  }
});
