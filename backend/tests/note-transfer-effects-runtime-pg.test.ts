import assert from "node:assert/strict";
import test from "node:test";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import { createNoteTransferOperationRepository } from "../src/repositories/noteTransferOperationRepository";
import { createNoteTransferCommitRuntime } from "../src/services/note-transfer-commit-runtime";
import { createNoteTransferEffectsRuntime } from "../src/services/note-transfer-effects-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const ACTOR = "pg-transfer-effects-actor";
const WORKSPACE = "pg-transfer-effects-workspace";
const SOURCE_NOTEBOOK = "pg-transfer-effects-source-notebook";
const TARGET_NOTEBOOK = "pg-transfer-effects-target-notebook";
const SOURCE_NOTE = "91111111-aaaa-4111-8111-111111111111";
const WEBHOOK = "pg-transfer-effects-webhook";

async function seed(pool: import("pg").Pool): Promise<void> {
  await pool.query(`DELETE FROM users WHERE id = $1`, [ACTOR]);
  await pool.query(
    `INSERT INTO users (id, username, "passwordHash", "tokenVersion")
     VALUES ($1, $1, 'hash', 0)`,
    [ACTOR],
  );
  await pool.query(
    `INSERT INTO workspaces (id, name, "ownerId") VALUES ($1, 'Effects target', $2)`,
    [WORKSPACE, ACTOR],
  );
  await pool.query(
    `INSERT INTO notebooks (id, "userId", "workspaceId", name)
     VALUES ($1, $3, NULL, 'Source'), ($2, $3, $4, 'Target')`,
    [SOURCE_NOTEBOOK, TARGET_NOTEBOOK, ACTOR, WORKSPACE],
  );
  await pool.query(
    `INSERT INTO notes (
       id, "userId", "notebookId", title, content, "contentText",
       "contentFormat", version, "sortOrder"
     ) VALUES ($1, $2, $3, 'Effects source', '# Effects', 'Effects', 'markdown', 3, 10)`,
    [SOURCE_NOTE, ACTOR, SOURCE_NOTEBOOK],
  );
  await pool.query(
    `INSERT INTO webhooks (id, "userId", url, secret, events, "isActive")
     VALUES ($1, $2, 'https://example.test/transfer', 'secret',
             '["note.transfer.completed"]', true)`,
    [WEBHOOK, ACTOR],
  );
}

async function commitCopy(input: {
  operations: ReturnType<typeof createNoteTransferOperationRepository>;
  commits: ReturnType<typeof createNoteTransferCommitRuntime>;
  key: string;
}) {
  await input.operations.prepareOperation({
    actorUserId: ACTOR,
    idempotencyKey: input.key,
    mode: "copy",
    sourceWorkspaceId: null,
    targetWorkspaceId: WORKSPACE,
    targetNotebookId: TARGET_NOTEBOOK,
    includeAttachments: false,
    includeTags: false,
    sourceNoteIds: [SOURCE_NOTE],
    sourceVersions: { [SOURCE_NOTE]: 3 },
    attachmentCount: 0,
    attachmentBytes: 0,
    tagCount: 0,
    internalNoteLinkCount: 0,
    externalNoteLinkCount: 0,
  });
  await input.operations.beginStaging({ actorUserId: ACTOR, idempotencyKey: input.key });
  return input.commits.commit({ actorUserId: ACTOR, idempotencyKey: input.key });
}

test("PostgreSQL note-transfer effects outbox is transactional, retryable and idempotent", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  try {
    await initPgSchema(pool);
    await seed(pool);
    const adapter = new PostgresAdapter(pool);
    const operations = createNoteTransferOperationRepository(adapter);
    const commits = createNoteTransferCommitRuntime(adapter, { operations });

    const committed = await commitCopy({
      operations,
      commits,
      key: "transfer-effects-success-001",
    });
    const outbox = await pool.query(
      `SELECT channel, status, "eventKey", payload
         FROM note_transfer_effect_outbox
        WHERE "operationId" = $1 ORDER BY channel`,
      [committed.operation.id],
    );
    assert.equal(outbox.rowCount, 3);
    assert.deepEqual(outbox.rows.map((row) => row.channel), ["audit", "realtime", "webhook"]);
    assert(outbox.rows.every((row) => row.status === "pending"));
    assert(outbox.rows.every((row) => row.payload.eventId === `${committed.operation.id}:note.transfer.completed`));

    const deliveries: Array<{ url: string; delivery: string }> = [];
    const realtimeEvents: string[] = [];
    const effects = createNoteTransferEffectsRuntime(adapter, {
      concurrency: 3,
      retryBaseSeconds: 0,
      fetchImpl: async (input, init) => {
        deliveries.push({
          url: String(input),
          delivery: new Headers(init?.headers).get("X-Nowen-Delivery") || "",
        });
        return new Response("ok", { status: 200 });
      },
      publishRealtime: async (event) => {
        realtimeEvents.push(event.eventId);
      },
    });

    const first = await effects.resume({
      actorUserId: ACTOR,
      idempotencyKey: "transfer-effects-success-001",
    });
    assert.equal(first.summary.complete, true);
    assert.equal(first.attempted, 3);
    assert.equal(first.completedThisRun, 3);
    assert.equal(first.failedThisRun, 0);
    assert.equal(deliveries.length, 1);
    assert.equal(realtimeEvents.length, 1);

    const audit = await pool.query(
      `SELECT id FROM audit_logs WHERE "targetId" = $1 AND action = 'copy_completed'`,
      [committed.operation.id],
    );
    assert.equal(audit.rowCount, 1);
    const webhookDelivery = await pool.query(
      `SELECT id, success, attempts FROM webhook_deliveries WHERE "webhookId" = $1`,
      [WEBHOOK],
    );
    assert.equal(webhookDelivery.rowCount, 1);
    assert.equal(webhookDelivery.rows[0].success, true);
    assert.equal(webhookDelivery.rows[0].attempts, 1);
    assert.equal(webhookDelivery.rows[0].id, deliveries[0].delivery);

    const reused = await effects.resume({
      actorUserId: ACTOR,
      idempotencyKey: "transfer-effects-success-001",
    });
    assert.equal(reused.summary.complete, true);
    assert.equal(reused.attempted, 0);
    assert.equal(deliveries.length, 1);
    assert.equal(realtimeEvents.length, 1);
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM audit_logs WHERE "targetId" = $1`, [committed.operation.id])).rows[0].count, 1);
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM webhook_deliveries WHERE "webhookId" = $1`, [WEBHOOK])).rows[0].count, 1);

    const retryCommitted = await commitCopy({
      operations,
      commits,
      key: "transfer-effects-retry-001",
    });
    let webhookAttempts = 0;
    const retryRealtime: string[] = [];
    const retryEffects = createNoteTransferEffectsRuntime(adapter, {
      concurrency: 3,
      retryBaseSeconds: 0,
      fetchImpl: async () => {
        webhookAttempts += 1;
        return new Response(webhookAttempts === 1 ? "fail" : "ok", {
          status: webhookAttempts === 1 ? 500 : 200,
        });
      },
      publishRealtime: async (event) => { retryRealtime.push(event.eventId); },
    });
    const failed = await retryEffects.resume({
      actorUserId: ACTOR,
      idempotencyKey: "transfer-effects-retry-001",
    });
    assert.equal(failed.summary.complete, false);
    assert.equal(failed.summary.failed, 1);
    assert.equal(failed.completedThisRun, 2);
    assert.equal(failed.failedThisRun, 1);

    const retried = await retryEffects.resume({
      actorUserId: ACTOR,
      idempotencyKey: "transfer-effects-retry-001",
    });
    assert.equal(retried.summary.complete, true);
    assert.equal(retried.attempted, 1);
    assert.equal(webhookAttempts, 2);
    assert.equal(retryRealtime.length, 1);
    const stableDelivery = await pool.query(
      `SELECT COUNT(*)::int AS count, MAX(attempts)::int AS attempts
         FROM webhook_deliveries
        WHERE id = $1`,
      [`${retryCommitted.operation.id}:note.transfer.completed:webhook:${WEBHOOK}:delivery`],
    );
    assert.equal(stableDelivery.rows[0].count, 1);
    assert.equal(stableDelivery.rows[0].attempts, 2);

    const leaseCommitted = await commitCopy({
      operations,
      commits,
      key: "transfer-effects-lease-001",
    });
    await pool.query(
      `UPDATE note_transfer_effect_outbox
          SET status = CASE WHEN channel = 'realtime' THEN 'processing' ELSE 'completed' END,
              attempts = CASE WHEN channel = 'realtime' THEN 1 ELSE attempts END,
              "leaseToken" = CASE WHEN channel = 'realtime' THEN 'crashed-worker' ELSE NULL END,
              "leaseExpiresAt" = CASE WHEN channel = 'realtime' THEN CURRENT_TIMESTAMP - INTERVAL '1 minute' ELSE NULL END
        WHERE "operationId" = $1`,
      [leaseCommitted.operation.id],
    );
    let recoveredRealtime = 0;
    const leaseEffects = createNoteTransferEffectsRuntime(adapter, {
      concurrency: 2,
      retryBaseSeconds: 0,
      fetchImpl: async () => new Response("ok"),
      publishRealtime: async () => { recoveredRealtime += 1; },
    });
    const [leaseA, leaseB] = await Promise.all([
      leaseEffects.resume({ actorUserId: ACTOR, idempotencyKey: "transfer-effects-lease-001" }),
      leaseEffects.resume({ actorUserId: ACTOR, idempotencyKey: "transfer-effects-lease-001" }),
    ]);
    assert.equal(leaseA.summary.complete || leaseB.summary.complete, true);
    assert.equal(recoveredRealtime, 1);
    const leaseRow = await pool.query(
      `SELECT status, attempts FROM note_transfer_effect_outbox
        WHERE "operationId" = $1 AND channel = 'realtime'`,
      [leaseCommitted.operation.id],
    );
    assert.equal(leaseRow.rows[0].status, "completed");
    assert.equal(leaseRow.rows[0].attempts, 2);

    await operations.prepareOperation({
      actorUserId: ACTOR,
      idempotencyKey: "transfer-effects-stale-001",
      mode: "copy",
      sourceWorkspaceId: null,
      targetWorkspaceId: WORKSPACE,
      targetNotebookId: TARGET_NOTEBOOK,
      includeAttachments: false,
      includeTags: false,
      sourceNoteIds: [SOURCE_NOTE],
      sourceVersions: { [SOURCE_NOTE]: 3 },
      attachmentCount: 0,
      attachmentBytes: 0,
      tagCount: 0,
      internalNoteLinkCount: 0,
      externalNoteLinkCount: 0,
    });
    const staleOperation = await operations.beginStaging({
      actorUserId: ACTOR,
      idempotencyKey: "transfer-effects-stale-001",
    });
    await pool.query(`UPDATE notes SET version = version + 1 WHERE id = $1`, [SOURCE_NOTE]);
    await assert.rejects(
      commits.commit({ actorUserId: ACTOR, idempotencyKey: "transfer-effects-stale-001" }),
      (error: any) => error?.code === "NOTE_TRANSFER_COMMIT_STALE",
    );
    assert.equal(
      (await pool.query(`SELECT COUNT(*)::int AS count FROM note_transfer_effect_outbox WHERE "operationId" = $1`, [staleOperation.id])).rows[0].count,
      0,
    );
  } finally {
    await closePgPool(pool);
  }
});
