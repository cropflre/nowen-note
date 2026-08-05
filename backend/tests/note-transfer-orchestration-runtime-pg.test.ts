import assert from "node:assert/strict";
import test from "node:test";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import { createNoteTransferOrchestrationRepository } from "../src/repositories/noteTransferOrchestrationRepository";
import { createNoteTransferEffectsRuntime } from "../src/services/note-transfer-effects-runtime";
import { createNoteTransferMoveDeletionRuntime } from "../src/services/note-transfer-move-deletion-runtime";
import { createNoteTransferOrchestrationRuntime } from "../src/services/note-transfer-orchestration-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const ACTOR = "pg-transfer-orchestration-actor";
const WORKSPACE = "pg-transfer-orchestration-workspace";
const SOURCE_NOTEBOOK = "pg-transfer-orchestration-source-notebook";
const TARGET_NOTEBOOK = "pg-transfer-orchestration-target-notebook";
const OTHER_TARGET_NOTEBOOK = "pg-transfer-orchestration-other-target-notebook";

async function seedBase(pool: import("pg").Pool): Promise<void> {
  await pool.query(`DELETE FROM users WHERE id = $1`, [ACTOR]);
  await pool.query(
    `INSERT INTO users (id, username, "passwordHash", "tokenVersion") VALUES ($1, $1, 'hash', 0)`,
    [ACTOR],
  );
  await pool.query(
    `INSERT INTO workspaces (id, name, "ownerId") VALUES ($1, 'Orchestration target', $2)`,
    [WORKSPACE, ACTOR],
  );
  await pool.query(
    `INSERT INTO notebooks (id, "userId", "workspaceId", name) VALUES
       ($1, $4, NULL, 'Source'),
       ($2, $4, $5, 'Target'),
       ($3, $4, $5, 'Other target')`,
    [SOURCE_NOTEBOOK, TARGET_NOTEBOOK, OTHER_TARGET_NOTEBOOK, ACTOR, WORKSPACE],
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

function createDeterministicRuntime(
  adapter: PostgresAdapter,
  shutdowns: Array<() => Promise<void>>,
) {
  const repositoryBase = createNoteTransferOrchestrationRepository(adapter);
  const repository = {
    ...repositoryBase,
    claimNextAny: async (_input: { maxAttempts: number; leaseSeconds: number }) => null,
  };
  const effectsBase = createNoteTransferEffectsRuntime(adapter, {
    publishRealtime: async () => {},
    retryBaseSeconds: 0,
    concurrency: 2,
  });
  const effects = {
    ...effectsBase,
    start: () => {},
    wake: () => {},
    shutdown: async () => {},
  };
  const moveBase = createNoteTransferMoveDeletionRuntime(adapter, {
    retryBaseSeconds: 0,
    concurrency: 2,
    cleanupAttachments: async (_db, candidates) => ({
      removedFiles: candidates.length,
      skippedSharedPaths: 0,
      warnings: [],
    }),
  });
  const moveDeletion = {
    ...moveBase,
    start: () => {},
    wake: () => {},
    shutdown: async () => {},
  };
  const orchestration = createNoteTransferOrchestrationRuntime(adapter, {
    repository,
    effects,
    moveDeletion,
    retryBaseSeconds: 0,
    maxTransitions: 4,
  });
  shutdowns.push(async () => {
    await orchestration.shutdown();
    await effectsBase.shutdown();
    await moveBase.shutdown();
  });
  return orchestration;
}

function request(input: {
  sourceNoteId: string;
  idempotencyKey: string;
  mode: "copy" | "move";
  targetNotebookId?: string;
  version?: number;
}) {
  return {
    actorUserId: ACTOR,
    idempotencyKey: input.idempotencyKey,
    sourceNoteIds: [input.sourceNoteId],
    targetWorkspaceId: WORKSPACE,
    targetNotebookId: input.targetNotebookId || TARGET_NOTEBOOK,
    mode: input.mode,
    includeAttachments: true,
    includeTags: true,
    expectedVersions: { [input.sourceNoteId]: input.version || 1 },
  };
}

test("PostgreSQL note-transfer orchestration unifies copy/move progress and recovery", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  const shutdowns: Array<() => Promise<void>> = [];
  try {
    await initPgSchema(pool);
    await seedBase(pool);
    const adapter = new PostgresAdapter(pool);
    const orchestration = createDeterministicRuntime(adapter, shutdowns);

    const copySource = "a1010101-1010-4101-8101-010101010101";
    const copyKey = "orchestration-copy-001";
    await seedSource(pool, copySource);
    const submittedCopy = await orchestration.submit(request({
      sourceNoteId: copySource,
      idempotencyKey: copyKey,
      mode: "copy",
    }));
    assert.equal(submittedCopy.accepted, true);
    assert.equal(submittedCopy.reused, false);
    assert.equal(submittedCopy.snapshot.phase, "staging");
    assert.equal(submittedCopy.snapshot.terminal, false);

    const completedCopy = await orchestration.resume({
      actorUserId: ACTOR,
      idempotencyKey: copyKey,
    });
    assert.equal(completedCopy.phase, "completed");
    assert.equal(completedCopy.terminal, true);
    assert.equal(completedCopy.operation.status, "completed");
    assert.equal(completedCopy.progress.effects.complete, true);
    assert.equal((await pool.query(`SELECT 1 FROM notes WHERE id = $1`, [copySource])).rowCount, 1);
    const copyTarget = completedCopy.operation.plan.targetNoteIds[copySource];
    assert.equal((await pool.query(`SELECT 1 FROM notes WHERE id = $1`, [copyTarget])).rowCount, 1);

    const replayedCopy = await orchestration.submit(request({
      sourceNoteId: copySource,
      idempotencyKey: copyKey,
      mode: "copy",
    }));
    assert.equal(replayedCopy.accepted, false);
    assert.equal(replayedCopy.reused, true);
    assert.equal(replayedCopy.snapshot.terminal, true);
    assert.equal(
      Number((await pool.query(`SELECT COUNT(*) AS count FROM notes WHERE id = $1`, [copyTarget])).rows[0].count),
      1,
    );

    await assert.rejects(
      orchestration.submit(request({
        sourceNoteId: copySource,
        idempotencyKey: copyKey,
        mode: "copy",
        targetNotebookId: OTHER_TARGET_NOTEBOOK,
      })),
      (error: any) => error?.code === "NOTE_TRANSFER_IDEMPOTENCY_CONFLICT",
    );

    const moveSource = "a2020202-2020-4202-8202-020202020202";
    const moveKey = "orchestration-move-001";
    await seedSource(pool, moveSource);
    const submittedMove = await orchestration.submit(request({
      sourceNoteId: moveSource,
      idempotencyKey: moveKey,
      mode: "move",
    }));
    assert.equal(submittedMove.snapshot.phase, "staging");
    const completedMove = await orchestration.resume({
      actorUserId: ACTOR,
      idempotencyKey: moveKey,
    });
    assert.equal(completedMove.phase, "completed");
    assert.equal(completedMove.operation.status, "completed");
    assert.equal(completedMove.progress.sourceDeletion.complete, true);
    assert.equal((await pool.query(`SELECT 1 FROM notes WHERE id = $1`, [moveSource])).rowCount, 0);
    const moveTarget = completedMove.operation.plan.targetNoteIds[moveSource];
    assert.equal((await pool.query(`SELECT 1 FROM notes WHERE id = $1`, [moveTarget])).rowCount, 1);

    const restartSource = "a3030303-3030-4303-8303-030303030303";
    const restartKey = "orchestration-restart-001";
    await seedSource(pool, restartSource);
    await orchestration.submit(request({
      sourceNoteId: restartSource,
      idempotencyKey: restartKey,
      mode: "copy",
    }));
    const restartedRuntime = createDeterministicRuntime(adapter, shutdowns);
    const recovered = await restartedRuntime.advanceForOperation({
      actorUserId: ACTOR,
      idempotencyKey: restartKey,
    });
    assert.equal(recovered.terminal, true);
    assert.equal(recovered.phase, "completed");

    const leaseSource = "a4040404-4040-4404-8404-040404040404";
    const leaseKey = "orchestration-lease-001";
    await seedSource(pool, leaseSource);
    const leaseSubmitted = await orchestration.submit(request({
      sourceNoteId: leaseSource,
      idempotencyKey: leaseKey,
      mode: "copy",
    }));
    await pool.query(
      `UPDATE note_transfer_operations
          SET "orchestrationLeaseToken" = 'expired-worker',
              "orchestrationLeaseExpiresAt" = NOW() - INTERVAL '1 minute'
        WHERE id = $1`,
      [leaseSubmitted.snapshot.operation.id],
    );
    const concurrent = await Promise.all([
      orchestration.advanceForOperation({ actorUserId: ACTOR, idempotencyKey: leaseKey }),
      orchestration.advanceForOperation({ actorUserId: ACTOR, idempotencyKey: leaseKey }),
    ]);
    const leaseFinal = await orchestration.getStatus({ actorUserId: ACTOR, idempotencyKey: leaseKey });
    assert.equal(leaseFinal.terminal, true);
    assert.equal(leaseFinal.phase, "completed");
    assert.ok(concurrent.some((result) => result.phase === "completed"));
    const leaseTarget = leaseFinal.operation.plan.targetNoteIds[leaseSource];
    assert.equal(
      Number((await pool.query(`SELECT COUNT(*) AS count FROM notes WHERE id = $1`, [leaseTarget])).rows[0].count),
      1,
    );

    const cancelSource = "a5050505-5050-4505-8505-050505050505";
    const cancelKey = "orchestration-cancel-001";
    await seedSource(pool, cancelSource);
    await orchestration.submit(request({
      sourceNoteId: cancelSource,
      idempotencyKey: cancelKey,
      mode: "copy",
    }));
    const cancelled = await orchestration.cancel({
      actorUserId: ACTOR,
      idempotencyKey: cancelKey,
    });
    assert.equal(cancelled.phase, "cancelled");
    assert.equal(cancelled.terminal, true);
    assert.equal(cancelled.operation.status, "cancelled");
    assert.equal((await pool.query(`SELECT 1 FROM notes WHERE id = $1`, [cancelSource])).rowCount, 1);
  } finally {
    await Promise.allSettled(shutdowns.map((shutdown) => shutdown()));
    await closePgPool(pool);
  }
});
