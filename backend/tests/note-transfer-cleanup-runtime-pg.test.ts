import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import { createNoteTransferOperationRepository } from "../src/repositories/noteTransferOperationRepository";
import { createAttachmentStorageRuntime } from "../src/services/attachment-storage-runtime";
import { createNoteTransferAttachmentStagingRuntime } from "../src/services/note-transfer-attachment-staging-runtime";
import { createNoteTransferCleanupRuntime } from "../src/services/note-transfer-cleanup-runtime";
import { createNoteTransferCommitRuntime } from "../src/services/note-transfer-commit-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const ACTOR = "pg-transfer-cleanup-actor";
const WORKSPACE = "pg-transfer-cleanup-workspace";
const SOURCE_NOTEBOOK = "pg-transfer-cleanup-source-notebook";
const TARGET_NOTEBOOK = "pg-transfer-cleanup-target-notebook";
const SOURCE_NOTE = "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa";
const SOURCE_ATTACHMENT = "bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb";

async function seed(pool: import("pg").Pool, content: Buffer): Promise<void> {
  await pool.query(`DELETE FROM users WHERE id = $1`, [ACTOR]);
  await pool.query(
    `INSERT INTO users (id, username, "passwordHash", "tokenVersion")
     VALUES ($1, $1, 'hash', 0)`,
    [ACTOR],
  );
  await pool.query(
    `INSERT INTO workspaces (id, name, "ownerId") VALUES ($1, 'Cleanup target', $2)`,
    [WORKSPACE, ACTOR],
  );
  await pool.query(
    `INSERT INTO notebooks (id, "userId", "workspaceId", name)
     VALUES ($1, $3, NULL, 'Source'), ($2, $3, $4, 'Target')`,
    [SOURCE_NOTEBOOK, TARGET_NOTEBOOK, ACTOR, WORKSPACE],
  );
  await pool.query(
    `INSERT INTO notes (
       id, "userId", "notebookId", title, content, "contentText", "contentFormat", version
     ) VALUES ($1, $2, $3, 'Source', '# Source', 'Source', 'markdown', 3)`,
    [SOURCE_NOTE, ACTOR, SOURCE_NOTEBOOK],
  );
  await pool.query(
    `INSERT INTO attachments (
       id, "noteId", "userId", filename, "mimeType", size, path, hash
     ) VALUES ($1, $2, $3, 'source.bin', 'application/octet-stream', $4, $5, $6)`,
    [
      SOURCE_ATTACHMENT,
      SOURCE_NOTE,
      ACTOR,
      content.length,
      "transfer-cleanup/source.bin",
      crypto.createHash("sha256").update(content).digest("hex"),
    ],
  );
}

async function prepare(
  operations: ReturnType<typeof createNoteTransferOperationRepository>,
  key: string,
  size: number,
) {
  await operations.prepareOperation({
    actorUserId: ACTOR,
    idempotencyKey: key,
    mode: "copy",
    sourceWorkspaceId: null,
    targetWorkspaceId: WORKSPACE,
    targetNotebookId: TARGET_NOTEBOOK,
    includeAttachments: true,
    includeTags: false,
    sourceNoteIds: [SOURCE_NOTE],
    sourceVersions: { [SOURCE_NOTE]: 3 },
    attachmentCount: 1,
    attachmentBytes: size,
    tagCount: 0,
    internalNoteLinkCount: 0,
    externalNoteLinkCount: 0,
  });
  return operations.beginStaging({ actorUserId: ACTOR, idempotencyKey: key });
}

function objectPath(root: string, relative: string): string {
  return path.join(root, ...relative.split("/"));
}

test("PostgreSQL note-transfer cleanup is cancellable, leased, retryable and preserves committed objects", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nowen-pg-transfer-cleanup-"));
  const sourceContent = Buffer.from("recoverable note transfer cleanup");

  try {
    await initPgSchema(pool);
    await seed(pool, sourceContent);
    const adapter = new PostgresAdapter(pool);
    const operations = createNoteTransferOperationRepository(adapter);
    const storage = createAttachmentStorageRuntime(adapter, { dataDir });
    const staging = createNoteTransferAttachmentStagingRuntime(adapter, {
      operations,
      storage,
      concurrency: 2,
      maxAttempts: 3,
      leaseSeconds: 30,
    });
    const cleanup = createNoteTransferCleanupRuntime(adapter, {
      operations,
      storage,
      concurrency: 2,
      maxAttempts: 3,
      leaseSeconds: 30,
    });
    const commit = createNoteTransferCommitRuntime(adapter, { operations });
    const sourcePath = objectPath(storage.getAttachmentsDir(), "transfer-cleanup/source.bin");
    await fs.promises.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.promises.writeFile(sourcePath, sourceContent);

    const staged = await prepare(operations, "transfer-cleanup-basic", sourceContent.length);
    await staging.resume({ actorUserId: ACTOR, idempotencyKey: "transfer-cleanup-basic" });
    const stagedObject = objectPath(
      storage.getAttachmentsDir(),
      staged.stagedAttachments[0].stagedPath,
    );
    assert.equal(fs.existsSync(stagedObject), true);
    const cancelled = await operations.cancelOperation({
      actorUserId: ACTOR,
      idempotencyKey: "transfer-cleanup-basic",
    });
    assert.equal(cancelled.status, "cancelled");
    const cleaned = await cleanup.resume({
      actorUserId: ACTOR,
      idempotencyKey: "transfer-cleanup-basic",
    });
    assert.equal(cleaned.summary.complete, true);
    assert.equal(cleaned.summary.attempted, 1);
    assert.equal(cleaned.summary.deleted, 1);
    assert.equal(cleaned.operation.stagedAttachments[0].status, "cleaned");
    assert.equal(cleaned.operation.stagedAttachments[0].cleanupStatus, "cleaned");
    assert.equal(cleaned.operation.stagedAttachments[0].cleanupAttempts, 1);
    assert.ok(cleaned.operation.stagedAttachments[0].cleanedAt);
    assert.equal(fs.existsSync(stagedObject), false);

    const idempotent = await cleanup.resume({
      actorUserId: ACTOR,
      idempotencyKey: "transfer-cleanup-basic",
    });
    assert.equal(idempotent.summary.complete, true);
    assert.equal(idempotent.summary.attempted, 0);

    const retryOperation = await prepare(
      operations,
      "transfer-cleanup-retry",
      sourceContent.length,
    );
    await staging.resume({ actorUserId: ACTOR, idempotencyKey: "transfer-cleanup-retry" });
    await operations.cancelOperation({ actorUserId: ACTOR, idempotencyKey: "transfer-cleanup-retry" });
    let failDelete = true;
    const flakyStorage = {
      ...storage,
      async deleteObject(relativePath: string): Promise<void> {
        if (failDelete) {
          failDelete = false;
          throw new Error("injected cleanup delete failure");
        }
        await storage.deleteObject(relativePath);
      },
    };
    const flakyCleanup = createNoteTransferCleanupRuntime(adapter, {
      operations,
      storage: flakyStorage,
      maxAttempts: 3,
      leaseSeconds: 30,
    });
    const failed = await flakyCleanup.resume({
      actorUserId: ACTOR,
      idempotencyKey: "transfer-cleanup-retry",
    });
    assert.equal(failed.summary.complete, false);
    assert.equal(failed.summary.failedThisRun, 1);
    assert.equal(failed.operation.stagedAttachments[0].cleanupStatus, "failed");
    assert.equal(failed.operation.stagedAttachments[0].cleanupAttempts, 1);
    assert.match(failed.operation.stagedAttachments[0].cleanupLastError || "", /injected cleanup/);
    assert.equal(
      fs.existsSync(objectPath(storage.getAttachmentsDir(), retryOperation.stagedAttachments[0].stagedPath)),
      true,
    );
    const retried = await flakyCleanup.resume({
      actorUserId: ACTOR,
      idempotencyKey: "transfer-cleanup-retry",
    });
    assert.equal(retried.summary.complete, true);
    assert.equal(retried.operation.stagedAttachments[0].cleanupAttempts, 2);

    const crashed = await prepare(operations, "transfer-cleanup-crash", sourceContent.length);
    await staging.resume({ actorUserId: ACTOR, idempotencyKey: "transfer-cleanup-crash" });
    await operations.cancelOperation({ actorUserId: ACTOR, idempotencyKey: "transfer-cleanup-crash" });
    await pool.query(
      `UPDATE note_transfer_staged_attachments
          SET "cleanupStatus" = 'cleaning', "cleanupLeaseToken" = 'crashed-cleaner',
              "cleanupLeaseExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 minute'
        WHERE "operationId" = $1`,
      [crashed.id],
    );
    const recovered = await cleanup.resume({
      actorUserId: ACTOR,
      idempotencyKey: "transfer-cleanup-crash",
    });
    assert.equal(recovered.summary.complete, true);
    assert.equal(recovered.operation.stagedAttachments[0].cleanupAttempts, 1);

    const active = await prepare(operations, "transfer-cleanup-active-copy", sourceContent.length);
    await storage.copyAndVerify({
      sourcePath: active.stagedAttachments[0].sourcePath,
      stagedPath: active.stagedAttachments[0].stagedPath,
      expectedSize: active.stagedAttachments[0].size,
      expectedHash: active.stagedAttachments[0].hash,
    });
    await pool.query(
      `UPDATE note_transfer_staged_attachments
          SET status = 'copying', "leaseToken" = 'active-copy-worker',
              "leaseExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '10 minutes'
        WHERE "operationId" = $1`,
      [active.id],
    );
    await operations.cancelOperation({
      actorUserId: ACTOR,
      idempotencyKey: "transfer-cleanup-active-copy",
    });
    const blocked = await cleanup.resume({
      actorUserId: ACTOR,
      idempotencyKey: "transfer-cleanup-active-copy",
    });
    assert.equal(blocked.summary.complete, false);
    assert.equal(blocked.summary.attempted, 0);
    assert.equal(blocked.summary.pending, 1);
    await pool.query(
      `UPDATE note_transfer_staged_attachments
          SET "leaseExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 minute'
        WHERE "operationId" = $1`,
      [active.id],
    );
    const activeRecovered = await cleanup.resume({
      actorUserId: ACTOR,
      idempotencyKey: "transfer-cleanup-active-copy",
    });
    assert.equal(activeRecovered.summary.complete, true);

    const completedOperation = await prepare(
      operations,
      "transfer-cleanup-retained",
      sourceContent.length,
    );
    await staging.resume({ actorUserId: ACTOR, idempotencyKey: "transfer-cleanup-retained" });
    const committed = await commit.commit({
      actorUserId: ACTOR,
      idempotencyKey: "transfer-cleanup-retained",
    });
    assert.equal(committed.operation.status, "completed");
    const retainedPath = objectPath(
      storage.getAttachmentsDir(),
      completedOperation.stagedAttachments[0].stagedPath,
    );
    assert.equal(fs.existsSync(retainedPath), true);
    const retained = await operations.getPrepared({
      actorUserId: ACTOR,
      idempotencyKey: "transfer-cleanup-retained",
    });
    assert.equal(retained?.stagedAttachments[0].cleanupStatus, "retained");
    await assert.rejects(
      operations.cancelOperation({ actorUserId: ACTOR, idempotencyKey: "transfer-cleanup-retained" }),
      (error: any) => error?.code === "NOTE_TRANSFER_CANCEL_CONFLICT",
    );
    await assert.rejects(
      cleanup.resume({ actorUserId: ACTOR, idempotencyKey: "transfer-cleanup-retained" }),
      (error: any) => error?.code === "NOTE_TRANSFER_CLEANUP_STATE_CONFLICT",
    );
    assert.equal(fs.existsSync(retainedPath), true);
  } finally {
    await fs.promises.rm(dataDir, { recursive: true, force: true });
    await closePgPool(pool);
  }
});
