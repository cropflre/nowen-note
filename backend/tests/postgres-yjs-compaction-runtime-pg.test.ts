import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";

import type { DatabaseAdapter } from "../src/db/adapters/types";
import { PostgresAdapter } from "../src/db/postgresAdapter";
import { createPostgresYjsCompactionRuntime } from "../src/services/postgres-yjs-compaction-runtime";
import { createPostgresYjsReadRuntime } from "../src/services/postgres-yjs-read-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const USER = "pg-yjs-compact-user";
const NOTEBOOK = "pg-yjs-compact-notebook";
const COMPACT_NOTE = "f1111111-1111-4111-8111-111111111111";
const CORRUPT_NOTE = "f2222222-2222-4222-8222-222222222222";
const FAILURE_NOTE = "f3333333-3333-4333-8333-333333333333";
const NO_SNAPSHOT_NOTE = "f4444444-4444-4444-8444-444444444444";

interface YFixture {
  snapshot: Uint8Array;
  updates: Uint8Array[];
  content: string;
}

function buildFixture(updateCount: number): YFixture {
  const doc = new Y.Doc();
  const text = doc.getText("content");
  text.insert(0, "base");
  const snapshot = Y.encodeStateAsUpdate(doc);
  const updates: Uint8Array[] = [];
  for (let index = 0; index < updateCount; index += 1) {
    const vector = Y.encodeStateVector(doc);
    text.insert(text.length, `-${index + 1}`);
    updates.push(Y.encodeStateAsUpdate(doc, vector));
  }
  const content = text.toString();
  doc.destroy();
  return { snapshot, updates, content };
}

async function insertNoteFixture(
  pool: import("pg").Pool,
  noteId: string,
  fixture: YFixture,
  options: { corruptLastUpdate?: boolean; withSnapshot?: boolean } = {},
): Promise<number[]> {
  await pool.query(
    `INSERT INTO notes (
       id, "userId", "notebookId", title, content, "contentText", "contentFormat", version
     ) VALUES ($1, $2, $3, $4, $5, $5, 'markdown', $6)`,
    [noteId, USER, NOTEBOOK, noteId, fixture.content, fixture.updates.length + 1],
  );
  if (options.withSnapshot !== false) {
    await pool.query(
      `INSERT INTO note_ysnapshots ("noteId", snapshot_blob, "updatesMergedTo") VALUES ($1, $2, 0)`,
      [noteId, Buffer.from(fixture.snapshot)],
    );
  }

  const ids: number[] = [];
  for (let index = 0; index < fixture.updates.length; index += 1) {
    const blob = options.corruptLastUpdate && index === fixture.updates.length - 1
      ? Buffer.from([1, 2, 3])
      : Buffer.from(fixture.updates[index]!);
    const inserted = await pool.query(
      `INSERT INTO note_yupdates ("noteId", "userId", update_blob, clock)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [noteId, USER, blob, index + 2],
    );
    ids.push(Number(inserted.rows[0].id));
  }
  return ids;
}

function decodeSnapshot(value: Buffer): string {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, new Uint8Array(value));
    return doc.getText("content").toString();
  } finally {
    doc.destroy();
  }
}

test("PostgreSQL Yjs compaction advances an atomic watermark, retains a safety margin and fails closed", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  await initPgSchema(pool);
  await pool.query(`DELETE FROM users WHERE id = $1`, [USER]);
  await pool.query(
    `INSERT INTO users (id, username, "passwordHash", "tokenVersion", "isDisabled")
     VALUES ($1, $1, 'hash', 0, false)`,
    [USER],
  );
  await pool.query(
    `INSERT INTO notebooks (id, "userId", name) VALUES ($1, $2, 'Yjs compaction')`,
    [NOTEBOOK, USER],
  );

  const adapter = new PostgresAdapter(pool);
  const compactFixture = buildFixture(5);
  const compactIds = await insertNoteFixture(pool, COMPACT_NOTE, compactFixture);
  const corruptFixture = buildFixture(2);
  await insertNoteFixture(pool, CORRUPT_NOTE, corruptFixture, { corruptLastUpdate: true });
  const failureFixture = buildFixture(2);
  await insertNoteFixture(pool, FAILURE_NOTE, failureFixture);
  const noSnapshotFixture = buildFixture(2);
  await insertNoteFixture(pool, NO_SNAPSHOT_NOTE, noSnapshotFixture, { withSnapshot: false });

  const runtime = createPostgresYjsCompactionRuntime(adapter, {
    minUpdates: 2,
    gcSafetyMargin: 2,
    maxNotesPerRun: 10,
  });

  try {
    const first = await runtime.runOnce();
    assert.equal(first.scannedNotes, 4);
    assert.equal(first.compactedNotes, 2);
    assert.equal(first.blockedNotes, 2);
    assert.equal(first.failures, 0);
    assert.equal(first.deletedUpdates, 3);

    const compacted = (await pool.query(
      `SELECT snapshot_blob, "updatesMergedTo" FROM note_ysnapshots WHERE "noteId" = $1`,
      [COMPACT_NOTE],
    )).rows[0];
    assert.equal(Number(compacted.updatesMergedTo), compactIds.at(-1));
    assert.equal(decodeSnapshot(compacted.snapshot_blob), compactFixture.content);

    const retained = await pool.query(
      `SELECT id FROM note_yupdates WHERE "noteId" = $1 ORDER BY id ASC`,
      [COMPACT_NOTE],
    );
    assert.deepEqual(retained.rows.map((row) => Number(row.id)), compactIds.slice(-2));

    assert.equal(Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM note_yupdates WHERE "noteId" = $1`,
      [CORRUPT_NOTE],
    )).rows[0].count), 2);
    assert.equal(Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM note_ysnapshots WHERE "noteId" = $1`,
      [NO_SNAPSHOT_NOTE],
    )).rows[0].count), 0);
    assert.equal(Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM note_yupdates WHERE "noteId" = $1`,
      [NO_SNAPSHOT_NOTE],
    )).rows[0].count), 2);

    const readRuntime = createPostgresYjsReadRuntime(adapter, { idleTimeoutMs: 20 });
    try {
      const joined = await readRuntime.join(COMPACT_NOTE, "compaction-reader");
      assert.equal(joined.source, "snapshot");
      assert.equal(joined.replayedUpdates, 0);
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, new Uint8Array(Buffer.from(joined.stateBase64, "base64")));
        assert.equal(doc.getText("content").toString(), compactFixture.content);
      } finally {
        doc.destroy();
      }
    } finally {
      await readRuntime.close();
    }

    await pool.query(
      `UPDATE note_ysnapshots SET "updatesMergedTo" = 0 WHERE "noteId" = $1`,
      [FAILURE_NOTE],
    );
    const failingAdapter: DatabaseAdapter = {
      queryOne: <T>(sql: string, params?: unknown[]) => adapter.queryOne<T>(sql, params),
      queryMany: <T>(sql: string, params?: unknown[]) => adapter.queryMany<T>(sql, params),
      execute: (sql, params) => adapter.execute(sql, params),
      executeBatch: (sql, paramsList) => adapter.executeBatch(sql, paramsList),
      executeStatements: (statements) => {
        const targetsFailure = statements.some((statement) => (
          statement.sql.includes("INSERT INTO note_ysnapshots")
          && statement.params?.[0] === FAILURE_NOTE
        ));
        if (!targetsFailure) return adapter.executeStatements(statements);
        return adapter.executeStatements([
          ...statements,
          { sql: `INSERT INTO postgres_yjs_compaction_missing_table (id) VALUES (?)`, params: [FAILURE_NOTE] },
        ]);
      },
    };
    const failureRuntime = createPostgresYjsCompactionRuntime(failingAdapter, {
      minUpdates: 2,
      gcSafetyMargin: 0,
      maxNotesPerRun: 10,
    });
    try {
      const failed = await failureRuntime.runOnce();
      assert.equal(failed.failures, 1);
      assert.equal(Number((await pool.query(
        `SELECT "updatesMergedTo" FROM note_ysnapshots WHERE "noteId" = $1`,
        [FAILURE_NOTE],
      )).rows[0].updatesMergedTo), 0);
      assert.equal(Number((await pool.query(
        `SELECT COUNT(*)::int AS count FROM note_yupdates WHERE "noteId" = $1`,
        [FAILURE_NOTE],
      )).rows[0].count), 2);
    } finally {
      await failureRuntime.close();
    }

    const stats = runtime.getStats();
    assert.equal(stats.runs, 1);
    assert.equal(stats.compactedNotes, 2);
    assert.equal(stats.blockedNotes, 2);
  } finally {
    await runtime.close();
    await closePgPool(pool);
  }
});
