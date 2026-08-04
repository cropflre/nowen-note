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
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const ACTOR = "pg-transfer-copy-actor";
const WORKSPACE = "pg-transfer-copy-workspace";
const SOURCE_NOTEBOOK = "pg-transfer-copy-source-notebook";
const TARGET_NOTEBOOK = "pg-transfer-copy-target-notebook";
const SOURCE_NOTE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SOURCE_ATTACHMENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function seed(pool: import("pg").Pool, content: Buffer): Promise<void> {
  await pool.query(`DELETE FROM users WHERE id = $1`, [ACTOR]);
  await pool.query(
    `INSERT INTO users (id, username, "passwordHash", "tokenVersion")
     VALUES ($1, $1, 'hash', 0)`,
    [ACTOR],
  );
  await pool.query(
    `INSERT INTO workspaces (id, name, "ownerId") VALUES ($1, 'Transfer', $2)`,
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
      "transfer-source/source.bin",
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

test("PostgreSQL note-transfer attachment staging is verified, retryable and crash-safe", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nowen-pg-transfer-copy-"));
  const sourceContent = Buffer.from("recoverable physical attachment copy");

  try {
    await initPgSchema(pool);
    await seed(pool, sourceContent);
    const adapter = new PostgresAdapter(pool);
    const operations = createNoteTransferOperationRepository(adapter);
    const storage = createAttachmentStorageRuntime(adapter, { dataDir });
    const runtime = createNoteTransferAttachmentStagingRuntime(adapter, {
      operations,
      storage,
      concurrency: 2,
      maxAttempts: 3,
      leaseSeconds: 30,
    });
    const attachmentsDir = storage.getAttachmentsDir();
    const sourcePath = path.join(attachmentsDir, "transfer-source", "source.bin");
    await fs.promises.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.promises.writeFile(sourcePath, sourceContent);

    const staged = await prepare(operations, "transfer-physical-copy-001", sourceContent.length);
    const first = await runtime.resume({
      actorUserId: ACTOR,
      idempotencyKey: "transfer-physical-copy-001",
    });
    assert.equal(first.summary.complete, true);
    assert.equal(first.summary.attempted, 1);
    assert.equal(first.summary.copied, 1);
    assert.equal(first.summary.failed, 0);
    assert.equal(first.operation.status, "staging");
    assert.equal(first.operation.stagedAttachments[0].status, "staged");
    assert.equal(first.operation.stagedAttachments[0].attempts, 1);
    assert.equal(first.operation.stagedAttachments[0].verifiedSize, sourceContent.length);
    assert.equal(
      first.operation.stagedAttachments[0].verifiedHash,
      crypto.createHash("sha256").update(sourceContent).digest("hex"),
    );
    assert.ok(first.operation.stagedAttachments[0].stagedAt);
    const stagedPath = path.join(
      attachmentsDir,
      ...first.operation.stagedAttachments[0].stagedPath.split("/"),
    );
    assert.deepEqual(await fs.promises.readFile(stagedPath), sourceContent);

    const idempotent = await runtime.resume({
      actorUserId: ACTOR,
      idempotencyKey: "transfer-physical-copy-001",
    });
    assert.equal(idempotent.summary.complete, true);
    assert.equal(idempotent.summary.attempted, 0);
    assert.equal(idempotent.operation.stagedAttachments[0].attempts, 1);

    await pool.query(
      `UPDATE note_transfer_staged_attachments
          SET status = 'copying', "leaseToken" = 'crashed-worker',
              "leaseExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 minute'
        WHERE "operationId" = $1`,
      [staged.id],
    );
    const recovered = await runtime.resume({
      actorUserId: ACTOR,
      idempotencyKey: "transfer-physical-copy-001",
    });
    assert.equal(recovered.summary.complete, true);
    assert.equal(recovered.summary.reusedObjects, 1);
    assert.equal(recovered.operation.stagedAttachments[0].attempts, 2);

    await pool.query(
      `DELETE FROM note_transfer_operations WHERE "userId" = $1 AND "idempotencyKey" = $2`,
      [ACTOR, "transfer-physical-copy-retry"],
    );
    await fs.promises.rm(sourcePath, { force: true });
    await prepare(operations, "transfer-physical-copy-retry", sourceContent.length);
    const failed = await runtime.resume({
      actorUserId: ACTOR,
      idempotencyKey: "transfer-physical-copy-retry",
    });
    assert.equal(failed.summary.complete, false);
    assert.equal(failed.summary.failed, 1);
    assert.equal(failed.summary.failedThisRun, 1);
    assert.equal(failed.operation.stagedAttachments[0].status, "failed");
    assert.equal(failed.operation.stagedAttachments[0].attempts, 1);
    assert.match(failed.operation.stagedAttachments[0].lastError || "", /源附件文件不存在/);

    await fs.promises.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.promises.writeFile(sourcePath, sourceContent);
    const retried = await runtime.resume({
      actorUserId: ACTOR,
      idempotencyKey: "transfer-physical-copy-retry",
    });
    assert.equal(retried.summary.complete, true);
    assert.equal(retried.summary.failed, 0);
    assert.equal(retried.operation.stagedAttachments[0].status, "staged");
    assert.equal(retried.operation.stagedAttachments[0].attempts, 2);

    await assert.rejects(
      storage.copyAndVerify({
        sourcePath: "../escape.bin",
        stagedPath: "note-transfer-staging/escape",
        expectedSize: 0,
        expectedHash: null,
      }),
      (error: any) => error?.code === "ATTACHMENT_PATH_INVALID",
    );
  } finally {
    await fs.promises.rm(dataDir, { recursive: true, force: true });
    await closePgPool(pool);
  }
});
