import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";

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
