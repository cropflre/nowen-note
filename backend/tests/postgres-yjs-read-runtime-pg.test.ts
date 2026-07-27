import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import {
  createPostgresYjsReadRuntime,
  PostgresYjsReadRuntimeError,
} from "../src/services/postgres-yjs-read-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const USER = "pg-yjs-read-user";
const NOTEBOOK = "pg-yjs-read-notebook";
const REPLAY_NOTE = "d1111111-1111-4111-8111-111111111111";
const SEED_NOTE = "d2222222-2222-4222-8222-222222222222";

function decodeDocument(stateBase64: string): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(Buffer.from(stateBase64, "base64")));
  return doc;
}

async function prepareFixture(pool: import("pg").Pool): Promise<{
  snapshot: Uint8Array;
  update: Uint8Array;
}> {
  await initPgSchema(pool);
  await pool.query(`DELETE FROM users WHERE id = $1`, [USER]);
  await pool.query(
    `INSERT INTO users (id, username, "passwordHash", "tokenVersion", "isDisabled")
     VALUES ($1, $1, 'hash', 0, false)`,
    [USER],
  );
  await pool.query(
    `INSERT INTO notebooks (id, "userId", name) VALUES ($1, $2, 'Yjs read')`,
    [NOTEBOOK, USER],
  );
  await pool.query(
    `INSERT INTO notes (
       id, "userId", "notebookId", title, content, "contentText", "contentFormat"
     ) VALUES
       ($1, $2, $3, 'Replay', 'database fallback', 'database fallback', 'markdown'),
       ($4, $2, $3, 'Seed', '# Seed only', 'Seed only', 'markdown')`,
    [REPLAY_NOTE, USER, NOTEBOOK, SEED_NOTE],
  );

  const source = new Y.Doc();
  source.getText("content").insert(0, "snapshot");
  const snapshot = Y.encodeStateAsUpdate(source);
  const snapshotVector = Y.encodeStateVector(source);
  source.getText("content").insert(source.getText("content").length, " + update");
  const update = Y.encodeStateAsUpdate(source, snapshotVector);

  await pool.query(
    `INSERT INTO note_ysnapshots ("noteId", snapshot_blob, "updatesMergedTo")
     VALUES ($1, $2, 0)`,
    [REPLAY_NOTE, Buffer.from(snapshot)],
  );
  await pool.query(
    `INSERT INTO note_yupdates ("noteId", "userId", update_blob, clock)
     VALUES ($1, $2, $3, 1)`,
    [REPLAY_NOTE, USER, Buffer.from(update)],
  );

  return { snapshot, update };
}

test("PostgreSQL Yjs read runtime replays snapshot/update once and serves state-vector diffs", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  const runtime = createPostgresYjsReadRuntime(new PostgresAdapter(pool), { idleTimeoutMs: 25 });
  try {
    const { snapshot } = await prepareFixture(pool);
    const [first, second] = await Promise.all([
      runtime.join(REPLAY_NOTE, "connection-a"),
      runtime.join(REPLAY_NOTE, "connection-b"),
    ]);

    assert.equal(first.source, "snapshot");
    assert.equal(first.replayedUpdates, 1);
    assert.equal(second.stateBase64, first.stateBase64);
    assert.deepEqual(first.warnings, []);
    assert.equal(runtime.getStats().rooms, 1);
    assert.equal(runtime.getStats().connections, 2);
    assert.equal(runtime.getStats().replayedUpdates, 1);

    const full = decodeDocument(first.stateBase64);
    assert.equal(full.getText("content").toString(), "snapshot + update");

    const partial = new Y.Doc();
    Y.applyUpdate(partial, snapshot);
    const diff = runtime.syncStep1(
      REPLAY_NOTE,
      "connection-a",
      Buffer.from(Y.encodeStateVector(partial)).toString("base64"),
    );
    Y.applyUpdate(partial, new Uint8Array(Buffer.from(diff, "base64")));
    assert.equal(partial.getText("content").toString(), "snapshot + update");

    assert.equal(
      runtime.validateAwareness(REPLAY_NOTE, "connection-a", Buffer.from([1, 2, 3]).toString("base64")),
      "AQID",
    );
    assert.throws(
      () => runtime.syncStep1(REPLAY_NOTE, "missing-connection", "AQ=="),
      (error: unknown) => error instanceof PostgresYjsReadRuntimeError && error.code === "YJS_NOT_JOINED",
    );
    assert.throws(
      () => runtime.validateAwareness(REPLAY_NOTE, "connection-a", "not-base64!"),
      (error: unknown) => error instanceof PostgresYjsReadRuntimeError && error.code === "YJS_INVALID_AWARENESS",
    );

    runtime.leave(REPLAY_NOTE, "connection-a");
    runtime.leave(REPLAY_NOTE, "connection-b");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(runtime.getStats().rooms, 0);
  } finally {
    await runtime.close();
    await closePgPool(pool);
  }
});

test("PostgreSQL Yjs read runtime seeds Markdown without writing persistence rows", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  const runtime = createPostgresYjsReadRuntime(new PostgresAdapter(pool), { idleTimeoutMs: 25 });
  try {
    await prepareFixture(pool);
    const result = await runtime.join(SEED_NOTE, "seed-connection");
    assert.equal(result.source, "seed");
    assert.equal(result.replayedUpdates, 0);
    assert.equal(decodeDocument(result.stateBase64).getText("content").toString(), "# Seed only");
    assert.equal(runtime.getStats().seededRooms, 1);

    const rows = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM note_ysnapshots WHERE "noteId" = $1) AS snapshots,
         (SELECT COUNT(*)::int FROM note_yupdates WHERE "noteId" = $1) AS updates`,
      [SEED_NOTE],
    );
    assert.equal(Number(rows.rows[0].snapshots), 0);
    assert.equal(Number(rows.rows[0].updates), 0);

    runtime.destroyNote(SEED_NOTE);
    assert.equal(runtime.getStats().rooms, 0);
  } finally {
    await runtime.close();
    await closePgPool(pool);
  }
});
