import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { DatabaseAdapter } from "../src/db/adapters/types";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-block-authority-repository-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("block authority repository queries document, records and bounded operations through DatabaseAdapter", async () => {
  const calls: Array<{ kind: "one" | "many"; sql: string; params: unknown[] }> = [];
  const adapter: DatabaseAdapter = {
    async queryOne<T>(sql: string, params: unknown[] = []) {
      calls.push({ kind: "one", sql, params });
      return { noteId: "repo-note", status: "healthy" } as T;
    },
    async queryMany<T>(sql: string, params: unknown[] = []) {
      calls.push({ kind: "many", sql, params });
      if (sql.includes("note_block_records")) return [{ noteId: "repo-note", blockId: "blk_repo" }] as T[];
      return [{ noteId: "repo-note", operationType: "whole-save" }] as T[];
    },
    async execute() { throw new Error("只读 repository 不应写入"); },
    async executeBatch() { throw new Error("只读 repository 不应批量写入"); },
    async executeStatements() { throw new Error("只读 repository 不应执行事务写入"); },
  };
  const { createBlockAuthorityRepository } = await import("../src/repositories/blockAuthorityRepository");
  const repositoryIndexSource = fs.readFileSync(
    new URL("../src/repositories/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(repositoryIndexSource, /blockAuthorityRepository[\s\S]*createBlockAuthorityRepository/);
  const repository = createBlockAuthorityRepository(adapter);

  assert.equal((await repository.getDocument("repo-note"))?.noteId, "repo-note");
  assert.equal((await repository.listRecords("repo-note"))[0]?.blockId, "blk_repo");
  assert.equal((await repository.listOperations("repo-note", { limit: 999, offset: 3 }))[0]?.operationType, "whole-save");

  assert.deepEqual(calls.map((call) => call.params), [
    ["repo-note"],
    ["repo-note"],
    ["repo-note", 100, 3],
  ]);
  for (const call of calls) {
    assert.match(call.sql, /\?/);
    assert.doesNotMatch(call.sql, /\$\d+/);
  }
});

test("replaceAuthorityState uses one ordered cross-database transaction and preserves JSON strings", async () => {
  const transactions: Array<Array<{ sql: string; params?: unknown[] }>> = [];
  const adapter: DatabaseAdapter = {
    async queryOne() { return undefined; },
    async queryMany() { return []; },
    async execute() { throw new Error("原子替换不应执行独立写入"); },
    async executeBatch() { throw new Error("原子替换不应拆分批量写入"); },
    async executeStatements(statements) {
      transactions.push(statements);
      return { changes: statements.length };
    },
  };
  const { createBlockAuthorityRepository } = await import("../src/repositories/blockAuthorityRepository");
  const repository = createBlockAuthorityRepository(adapter);
  const timestamp = "2026-07-24T10:00:00.000Z";

  await repository.replaceAuthorityState({
    document: {
      noteId: "repo-note",
      contentFormat: "tiptap-json",
      noteVersion: 2,
      blockVersion: 3,
      structureVersion: 4,
      snapshotHash: "snapshot-hash",
      materializedHash: "materialized-hash",
      snapshotContent: "{\"type\":\"doc\"}",
      rootOrderJson: "[\"blk_repo\"]",
      status: "healthy",
      mismatchReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    records: [{
      noteId: "repo-note",
      blockId: "blk_repo",
      parentBlockId: null,
      blockType: "paragraph",
      blockOrder: 0,
      path: "0",
      version: 3,
      payload: "{\"type\":\"paragraph\"}",
      payloadHash: "payload-hash",
      plainText: "正文",
      contentHash: "content-hash",
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
    attachmentRefs: [{
      noteId: "repo-note",
      blockId: "blk_repo",
      attachmentId: "attachment-1",
      createdAt: timestamp,
    }],
    operation: {
      id: "operation-row-1",
      noteId: "repo-note",
      operationId: "client-operation-1",
      operationType: "whole-save",
      noteVersion: 2,
      blockVersion: 3,
      structureVersion: 4,
      operationJson: "{\"kind\":\"replace\"}",
      createdAt: timestamp,
    },
  });

  assert.equal(transactions.length, 1);
  assert.deepEqual(
    transactions[0].map((statement) => statement.sql.match(/^\s*(DELETE|INSERT)/)?.[1]),
    ["INSERT", "DELETE", "DELETE", "INSERT", "INSERT", "INSERT"],
  );
  assert.match(transactions[0][0].sql, /ON CONFLICT\s*\(\s*"noteId"\s*,\s*"operationId"\s*\)[\s\S]*DO NOTHING/i);
  assert.match(transactions[0][1].sql, /note_block_attachment_refs[\s\S]*EXISTS/i);
  assert.match(transactions[0][2].sql, /note_block_records[\s\S]*EXISTS/i);
  assert.match(transactions[0][5].sql, /ON CONFLICT\s*\(\s*"noteId"\s*\)\s*DO UPDATE/i);
  assert.equal(typeof transactions[0][3].params?.[7], "string");
  assert.equal(typeof transactions[0][5].params?.[8], "string");
  assert.equal(typeof transactions[0][0].params?.[7], "string");
});

test("reusing an operationId cannot overwrite a newer authority state", async () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE note_block_documents (
      noteId TEXT PRIMARY KEY, contentFormat TEXT, noteVersion INTEGER, blockVersion INTEGER,
      structureVersion INTEGER, snapshotHash TEXT, materializedHash TEXT, snapshotContent TEXT,
      rootOrderJson TEXT, status TEXT, mismatchReason TEXT, createdAt TEXT, updatedAt TEXT
    );
    CREATE TABLE note_block_records (
      noteId TEXT, blockId TEXT, parentBlockId TEXT, blockType TEXT, blockOrder INTEGER,
      path TEXT, version INTEGER, payload TEXT, payloadHash TEXT, plainText TEXT,
      contentHash TEXT, createdAt TEXT, updatedAt TEXT, PRIMARY KEY (noteId, blockId)
    );
    CREATE TABLE note_block_attachment_refs (
      noteId TEXT, blockId TEXT, attachmentId TEXT, createdAt TEXT,
      PRIMARY KEY (noteId, blockId, attachmentId)
    );
    CREATE TABLE note_block_operations (
      id TEXT PRIMARY KEY, noteId TEXT, operationId TEXT, operationType TEXT,
      noteVersion INTEGER, blockVersion INTEGER, structureVersion INTEGER,
      operationJson TEXT, createdAt TEXT
    );
    CREATE UNIQUE INDEX idx_note_block_operations_idempotency
      ON note_block_operations(noteId, operationId) WHERE operationId IS NOT NULL;
  `);
  const { createBlockAuthorityRepository } = await import("../src/repositories/blockAuthorityRepository");
  const { SqliteAdapter } = await import("../src/db/adapters/sqliteAdapter");
  const repository = createBlockAuthorityRepository(new SqliteAdapter(db));
  const timestamp = "2026-07-24T10:00:00.000Z";
  const state = (operationId: string, snapshotContent: string, version: number) => ({
    document: {
      noteId: "idempotent-note", contentFormat: "tiptap-json", noteVersion: version,
      blockVersion: version, structureVersion: version, snapshotHash: snapshotContent,
      materializedHash: snapshotContent, snapshotContent, rootOrderJson: "[]", status: "healthy",
      mismatchReason: null, createdAt: timestamp, updatedAt: timestamp,
    },
    records: [],
    attachmentRefs: [],
    operation: {
      id: `row-${operationId}`, noteId: "idempotent-note", operationId,
      operationType: "whole-save", noteVersion: version, blockVersion: version,
      structureVersion: version, operationJson: "{}", createdAt: timestamp,
    },
  });
  const operationA = state("operation-a", "snapshot-a", 1);
  await repository.replaceAuthorityState(operationA);
  await repository.replaceAuthorityState(state("operation-b", "snapshot-b", 2));
  await repository.replaceAuthorityState(operationA);

  assert.equal(
    (db.prepare("SELECT snapshotContent FROM note_block_documents WHERE noteId = ?")
      .get("idempotent-note") as any).snapshotContent,
    "snapshot-b",
  );
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM note_block_operations").get() as any).count, 2);
  db.close();
});
