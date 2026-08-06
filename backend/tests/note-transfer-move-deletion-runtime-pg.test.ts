import assert from "node:assert/strict";
import test from "node:test";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import { createNoteTransferEffectsRuntime } from "../src/services/note-transfer-effects-runtime";
import { createNoteTransferCommitRuntime } from "../src/services/note-transfer-commit-runtime";
import { createNoteTransferMoveDeletionRuntime } from "../src/services/note-transfer-move-deletion-runtime";
import { createNoteTransferOperationRepository } from "../src/repositories/noteTransferOperationRepository";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const ACTOR = "pg-transfer-move-actor";
const WORKSPACE = "pg-transfer-move-workspace";
const SOURCE_NOTEBOOK = "pg-transfer-move-source-notebook";
const TARGET_NOTEBOOK = "pg-transfer-move-target-notebook";

async function seedBase(pool: import("pg").Pool): Promise<void> {
  await pool.query(`DELETE FROM users WHERE id = $1`, [ACTOR]);
  await pool.query(
    `INSERT INTO users (id, username, "passwordHash", "tokenVersion") VALUES ($1, $1, 'hash', 0)`,
    [ACTOR],
  );
  await pool.query(
    `INSERT INTO workspaces (id, name, "ownerId") VALUES ($1, 'Move target', $2)`,
    [WORKSPACE, ACTOR],
  );
  await pool.query(
    `INSERT INTO notebooks (id, "userId", "workspaceId", name) VALUES
       ($1, $3, NULL, 'Source'), ($2, $3, $4, 'Target')`,
    [SOURCE_NOTEBOOK, TARGET_NOTEBOOK, ACTOR, WORKSPACE],
  );
}

async function seedSource(pool: import("pg").Pool, id: string, version = 1): Promise<void> {
  await pool.query(
    `INSERT INTO notes (
       id, "userId", "notebookId", title, content, "contentText", "contentFormat", version
     ) VALUES ($1, $2, $3, $4, $5, $5, 'markdown', $6)`,
    [id, ACTOR, SOURCE_NOTEBOOK, `Source ${id}`, `# Source ${id}`, version],
  );
}

async function prepareAndCommit(input: {
  operations: ReturnType<typeof createNoteTransferOperationRepository>;
  commit: ReturnType<typeof createNoteTransferCommitRuntime>;
  sourceId: string;
  key: string;
  version?: number;
}) {
  const version = input.version || 1;
  await input.operations.prepareOperation({
    actorUserId: ACTOR,
    idempotencyKey: input.key,
    mode: "move",
    sourceWorkspaceId: null,
    targetWorkspaceId: WORKSPACE,
    targetNotebookId: TARGET_NOTEBOOK,
    includeAttachments: true,
    includeTags: true,
    sourceNoteIds: [input.sourceId],
    sourceVersions: { [input.sourceId]: version },
    attachmentCount: 0,
    attachmentBytes: 0,
    tagCount: 0,
    internalNoteLinkCount: 0,
    externalNoteLinkCount: 0,
  });
  await input.operations.beginStaging({ actorUserId: ACTOR, idempotencyKey: input.key });
  return input.commit.commit({ actorUserId: ACTOR, idempotencyKey: input.key });
}

test("PostgreSQL note-transfer move waits for effects, deletes sources durably and recovers leases", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  try {
    await initPgSchema(pool);
    await seedBase(pool);
    const adapter = new PostgresAdapter(pool);
    const operations = createNoteTransferOperationRepository(adapter);
    const commit = createNoteTransferCommitRuntime(adapter, { operations });
    const effects = createNoteTransferEffectsRuntime(adapter, {
      publishRealtime: async () => {},
      retryBaseSeconds: 0,
      concurrency: 2,
    });
    const cleaned: string[] = [];
    const move = createNoteTransferMoveDeletionRuntime(adapter, {
      retryBaseSeconds: 0,
      concurrency: 2,
      cleanupAttachments: async (_db, candidates) => {
        cleaned.push(...candidates.map((candidate) => candidate.path));
        return { removedFiles: candidates.length, skippedSharedPaths: 0, warnings: [] };
      },
    });

    const sourceA = "aaaaaaaa-1111-4111-8111-111111111111";
    await seedSource(pool, sourceA);
    const committed = await prepareAndCommit({
      operations,
      commit,
      sourceId: sourceA,
      key: "move-source-success-001",
    });
    assert.equal(committed.operation.status, "target_committed");
    assert.equal(committed.result.mode, "move");
    assert.equal((await pool.query(`SELECT 1 FROM notes WHERE id = $1`, [sourceA])).rowCount, 1);
    assert.equal(
      (await pool.query(
        `SELECT status, stage FROM note_transfer_move_source_deletions WHERE "operationId" = $1`,
        [committed.operation.id],
      )).rows[0].status,
      "pending",
    );

    await assert.rejects(
      move.resume({ actorUserId: ACTOR, idempotencyKey: "move-source-success-001" }),
      (error: any) => error?.code === "NOTE_TRANSFER_MOVE_EFFECTS_PENDING",
    );
    const effectResult = await effects.resume({
      actorUserId: ACTOR,
      idempotencyKey: "move-source-success-001",
    });
    assert.equal(effectResult.summary.complete, true);
    const moved = await move.resume({ actorUserId: ACTOR, idempotencyKey: "move-source-success-001" });
    assert.equal(moved.summary.complete, true);
    assert.equal(moved.summary.operationStatus, "completed");
    assert.equal((await pool.query(`SELECT 1 FROM notes WHERE id = $1`, [sourceA])).rowCount, 0);
    const targetId = committed.result.targetNoteIds[sourceA];
    assert.equal((await pool.query(`SELECT 1 FROM notes WHERE id = $1`, [targetId])).rowCount, 1);
    const repeated = await move.resume({ actorUserId: ACTOR, idempotencyKey: "move-source-success-001" });
    assert.equal(repeated.attempted, 0);
    assert.equal(repeated.summary.complete, true);

    const sourceChanged = "bbbbbbbb-2222-4222-8222-222222222222";
    await seedSource(pool, sourceChanged, 3);
    const changedCommit = await prepareAndCommit({
      operations,
      commit,
      sourceId: sourceChanged,
      key: "move-source-changed-001",
      version: 3,
    });
    await effects.resume({ actorUserId: ACTOR, idempotencyKey: "move-source-changed-001" });
    await pool.query(`UPDATE notes SET version = 4 WHERE id = $1`, [sourceChanged]);
    const changed = await move.resume({ actorUserId: ACTOR, idempotencyKey: "move-source-changed-001" });
    assert.equal(changed.failedThisRun, 1);
    assert.equal(changed.summary.complete, false);
    assert.equal(changed.summary.failed, 1);
    assert.equal((await pool.query(`SELECT version FROM notes WHERE id = $1`, [sourceChanged])).rows[0].version, 4);
    const changedFailure = await pool.query(
      `SELECT "lastError" FROM note_transfer_move_source_deletions WHERE "operationId" = $1`,
      [changedCommit.operation.id],
    );
    assert.match(changedFailure.rows[0].lastError, /NOTE_TRANSFER_MOVE_SOURCE_CHANGED|源笔记在目标提交后发生变化/);

    const sourceLease = "cccccccc-3333-4333-8333-333333333333";
    await seedSource(pool, sourceLease);
    const leaseCommit = await prepareAndCommit({
      operations,
      commit,
      sourceId: sourceLease,
      key: "move-source-lease-001",
    });
    await effects.resume({ actorUserId: ACTOR, idempotencyKey: "move-source-lease-001" });
    await pool.query(
      `UPDATE note_transfer_move_source_deletions
          SET status = 'processing', "leaseToken" = 'expired-worker',
              "leaseExpiresAt" = NOW() - INTERVAL '1 minute'
        WHERE "operationId" = $1`,
      [leaseCommit.operation.id],
    );
    const leaseRecovered = await move.resume({ actorUserId: ACTOR, idempotencyKey: "move-source-lease-001" });
    assert.equal(leaseRecovered.summary.complete, true);
    assert.equal((await pool.query(`SELECT 1 FROM notes WHERE id = $1`, [sourceLease])).rowCount, 0);

    const sourceConcurrent = "dddddddd-4444-4444-8444-444444444444";
    await seedSource(pool, sourceConcurrent);
    await prepareAndCommit({
      operations,
      commit,
      sourceId: sourceConcurrent,
      key: "move-source-concurrent-001",
    });
    await effects.resume({ actorUserId: ACTOR, idempotencyKey: "move-source-concurrent-001" });
    const concurrent = await Promise.all([
      move.resume({ actorUserId: ACTOR, idempotencyKey: "move-source-concurrent-001" }),
      move.resume({ actorUserId: ACTOR, idempotencyKey: "move-source-concurrent-001" }),
    ]);
    assert.equal(concurrent.reduce((sum, result) => sum + result.attempted, 0), 1);
    assert.equal((await pool.query(`SELECT 1 FROM notes WHERE id = $1`, [sourceConcurrent])).rowCount, 0);
    assert.deepEqual(cleaned, []);
  } finally {
    await closePgPool(pool);
  }
});
