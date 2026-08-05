import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import { createNoteTransferCommitRepository } from "../src/repositories/noteTransferCommitRepository";
import { createNoteTransferOperationRepository } from "../src/repositories/noteTransferOperationRepository";
import { createAttachmentStorageRuntime } from "../src/services/attachment-storage-runtime";
import { createNoteTransferAttachmentStagingRuntime } from "../src/services/note-transfer-attachment-staging-runtime";
import { createNoteTransferCommitRuntime } from "../src/services/note-transfer-commit-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const ACTOR = "pg-transfer-commit-actor";
const WORKSPACE = "pg-transfer-commit-workspace";
const SOURCE_NOTEBOOK = "pg-transfer-commit-source-notebook";
const TARGET_NOTEBOOK = "pg-transfer-commit-target-notebook";
const SOURCE_A = "11111111-aaaa-4111-8111-111111111111";
const SOURCE_B = "22222222-bbbb-4222-8222-222222222222";
const EXTERNAL = "33333333-cccc-4333-8333-333333333333";
const ATTACHMENT = "44444444-dddd-4444-8444-444444444444";
const SOURCE_TAG_SHARED = "source-tag-shared";
const SOURCE_TAG_NEW = "source-tag-new";
const TARGET_TAG_SHARED = "target-tag-shared";

async function seed(pool: import("pg").Pool, attachmentContent: Buffer): Promise<void> {
  await pool.query(`DELETE FROM users WHERE id = $1`, [ACTOR]);
  await pool.query(
    `INSERT INTO users (id, username, "passwordHash", "tokenVersion")
     VALUES ($1, $1, 'hash', 0)`,
    [ACTOR],
  );
  await pool.query(
    `INSERT INTO workspaces (id, name, "ownerId") VALUES ($1, 'Commit target', $2)`,
    [WORKSPACE, ACTOR],
  );
  await pool.query(
    `INSERT INTO notebooks (id, "userId", "workspaceId", name)
     VALUES ($1, $3, NULL, 'Source'), ($2, $3, $4, 'Target')`,
    [SOURCE_NOTEBOOK, TARGET_NOTEBOOK, ACTOR, WORKSPACE],
  );
  const sourceAContent = [
    "# Alpha ^blk_alpha001",
    "",
    `Internal [[note:${SOURCE_B}|Beta]] and external note:${EXTERNAL}. ^blk_alpha002`,
    "",
    `Attachment /api/attachments/${ATTACHMENT} ^blk_alpha003`,
  ].join("\n");
  const sourceBContent = "# Beta ^blk_beta001\n\nBody ^blk_beta002";
  await pool.query(
    `INSERT INTO notes (
       id, "userId", "notebookId", title, content, "contentText",
       "contentFormat", version, "isPinned", "sortOrder"
     ) VALUES
       ($1, $4, $5, 'Alpha', $6, 'Alpha body', 'markdown', 4, true, 10),
       ($2, $4, $5, 'Beta', $7, 'Beta body', 'markdown', 7, false, 20),
       ($3, $4, $5, 'External', '# External', 'External', 'markdown', 1, false, 30)`,
    [SOURCE_A, SOURCE_B, EXTERNAL, ACTOR, SOURCE_NOTEBOOK, sourceAContent, sourceBContent],
  );
  await pool.query(
    `INSERT INTO attachments (
       id, "noteId", "userId", filename, "mimeType", size, path, hash
     ) VALUES ($1, $2, $3, 'commit.bin', 'application/octet-stream', $4, $5, $6)`,
    [
      ATTACHMENT,
      SOURCE_A,
      ACTOR,
      attachmentContent.length,
      "transfer-commit/source.bin",
      crypto.createHash("sha256").update(attachmentContent).digest("hex"),
    ],
  );
  await pool.query(
    `INSERT INTO tags (id, "userId", "workspaceId", name, color)
     VALUES
       ($1, $4, NULL, 'Shared', '#111111'),
       ($2, $4, NULL, 'New tag', '#222222'),
       ($3, $4, $5, 'Shared', '#abcdef')`,
    [SOURCE_TAG_SHARED, SOURCE_TAG_NEW, TARGET_TAG_SHARED, ACTOR, WORKSPACE],
  );
  await pool.query(
    `INSERT INTO note_tags ("noteId", "tagId")
     VALUES ($1, $3), ($1, $4), ($2, $3)`,
    [SOURCE_A, SOURCE_B, SOURCE_TAG_SHARED, SOURCE_TAG_NEW],
  );
}

async function prepareOperation(input: {
  operations: ReturnType<typeof createNoteTransferOperationRepository>;
  key: string;
  mode?: "copy" | "move";
  sourceNoteIds?: string[];
  sourceVersions?: Record<string, number>;
  includeAttachments?: boolean;
  includeTags?: boolean;
  attachmentSize: number;
}) {
  const sourceNoteIds = input.sourceNoteIds || [SOURCE_A, SOURCE_B];
  const sourceVersions = input.sourceVersions || { [SOURCE_A]: 4, [SOURCE_B]: 7 };
  const includeAttachments = input.includeAttachments !== false;
  const includeTags = input.includeTags !== false;
  await input.operations.prepareOperation({
    actorUserId: ACTOR,
    idempotencyKey: input.key,
    mode: input.mode || "copy",
    sourceWorkspaceId: null,
    targetWorkspaceId: WORKSPACE,
    targetNotebookId: TARGET_NOTEBOOK,
    includeAttachments,
    includeTags,
    sourceNoteIds,
    sourceVersions,
    attachmentCount: includeAttachments && sourceNoteIds.includes(SOURCE_A) ? 1 : 0,
    attachmentBytes: includeAttachments && sourceNoteIds.includes(SOURCE_A) ? input.attachmentSize : 0,
    tagCount: includeTags ? 2 : 0,
    internalNoteLinkCount: sourceNoteIds.length > 1 ? 1 : 0,
    externalNoteLinkCount: sourceNoteIds.includes(SOURCE_A) ? 1 : 0,
  });
  return input.operations.beginStaging({ actorUserId: ACTOR, idempotencyKey: input.key });
}

test("PostgreSQL note-transfer copy commit is atomic, idempotent and derived-data complete", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nowen-pg-transfer-commit-"));
  const attachmentContent = Buffer.from("atomic target commit attachment");

  try {
    await initPgSchema(pool);
    await seed(pool, attachmentContent);
    const adapter = new PostgresAdapter(pool);
    const operations = createNoteTransferOperationRepository(adapter);
    const commits = createNoteTransferCommitRepository(adapter);
    const storage = createAttachmentStorageRuntime(adapter, { dataDir });
    const staging = createNoteTransferAttachmentStagingRuntime(adapter, {
      operations,
      storage,
      concurrency: 2,
      maxAttempts: 3,
      leaseSeconds: 30,
    });
    const runtime = createNoteTransferCommitRuntime(adapter, { operations, commits });

    const sourcePath = path.join(storage.getAttachmentsDir(), "transfer-commit", "source.bin");
    await fs.promises.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.promises.writeFile(sourcePath, attachmentContent);

    const operation = await prepareOperation({
      operations,
      key: "transfer-atomic-commit-001",
      attachmentSize: attachmentContent.length,
    });
    await assert.rejects(
      runtime.commit({ actorUserId: ACTOR, idempotencyKey: "transfer-atomic-commit-001" }),
      (error: any) => error?.code === "NOTE_TRANSFER_ATTACHMENTS_NOT_STAGED",
    );

    const staged = await staging.resume({
      actorUserId: ACTOR,
      idempotencyKey: "transfer-atomic-commit-001",
    });
    assert.equal(staged.summary.complete, true);

    const committed = await runtime.commit({
      actorUserId: ACTOR,
      idempotencyKey: "transfer-atomic-commit-001",
    });
    assert.equal(committed.reused, false);
    assert.equal(committed.operation.status, "completed");
    assert.equal(committed.result.sourceNoteCount, 2);
    assert.equal(committed.result.attachmentCount, 1);
    assert.equal(committed.result.tagCount, 2);
    assert.ok(committed.result.blockCount >= 4);
    assert.equal(committed.result.noteLinkCount, 2);

    const targetA = committed.result.targetNoteIds[SOURCE_A];
    const targetB = committed.result.targetNoteIds[SOURCE_B];
    const targetAttachment = operation.stagedAttachments[0].targetAttachmentId;
    const targetRows = await pool.query(
      `SELECT id, title, content, "contentText", "contentFormat", "workspaceId", "notebookId",
              "isPinned", "sortOrder", version
         FROM notes WHERE id = ANY($1::text[]) ORDER BY id`,
      [[targetA, targetB]],
    );
    assert.equal(targetRows.rowCount, 2);
    const targetARow = targetRows.rows.find((row) => row.id === targetA);
    assert.ok(targetARow);
    assert.equal(targetARow.workspaceId, WORKSPACE);
    assert.equal(targetARow.notebookId, TARGET_NOTEBOOK);
    assert.equal(targetARow.isPinned, true);
    assert.equal(targetARow.sortOrder, 10);
    assert.equal(targetARow.version, 1);
    assert.match(targetARow.content, new RegExp(targetB));
    assert.match(targetARow.content, new RegExp(EXTERNAL));
    assert.match(targetARow.content, new RegExp(targetAttachment));
    assert.doesNotMatch(targetARow.content, new RegExp(ATTACHMENT));

    const attachmentRows = await pool.query(
      `SELECT attachment.id, attachment."noteId", attachment."workspaceId", attachment.path,
              attachment.hash, reference."noteId" AS reference_note_id
         FROM attachments attachment
         JOIN attachment_references reference ON reference."attachmentId" = attachment.id
        WHERE attachment.id = $1`,
      [targetAttachment],
    );
    assert.equal(attachmentRows.rowCount, 1);
    assert.equal(attachmentRows.rows[0].noteId, targetA);
    assert.equal(attachmentRows.rows[0].reference_note_id, targetA);
    assert.match(attachmentRows.rows[0].path, new RegExp(`^note-transfer-staging/${operation.id}/`));
    assert.equal(
      attachmentRows.rows[0].hash,
      crypto.createHash("sha256").update(attachmentContent).digest("hex"),
    );

    const tagRows = await pool.query(
      `SELECT note_tag."noteId", tag.id, tag.name, tag."workspaceId"
         FROM note_tags note_tag
         JOIN tags tag ON tag.id = note_tag."tagId"
        WHERE note_tag."noteId" = ANY($1::text[])
        ORDER BY note_tag."noteId", tag.name`,
      [[targetA, targetB]],
    );
    assert.equal(tagRows.rowCount, 3);
    assert(tagRows.rows.every((row) => row.workspaceId === WORKSPACE));
    assert(tagRows.rows.some((row) => row.id === TARGET_TAG_SHARED));
    assert(tagRows.rows.some((row) => row.name === "New tag"));

    const linkRows = await pool.query(
      `SELECT "sourceNoteId", "targetNoteId", "sourceBlockId", "targetBlockId"
         FROM note_links WHERE "sourceNoteId" = $1 ORDER BY "targetNoteId"`,
      [targetA],
    );
    assert.deepEqual(
      linkRows.rows.map((row) => row.targetNoteId).sort(),
      [EXTERNAL, targetB].sort(),
    );

    const blockRows = await pool.query(
      `SELECT "noteId", "blockId", "blockOrder"
         FROM note_blocks_index WHERE "noteId" = ANY($1::text[])
         ORDER BY "noteId", "blockOrder"`,
      [[targetA, targetB]],
    );
    assert.equal(blockRows.rowCount, committed.result.blockCount);

    const state = await pool.query(
      `SELECT operation.status, operation.result,
              COUNT(DISTINCT item."sourceNoteId")::int AS item_count,
              COUNT(DISTINCT manifest."sourceAttachmentId")::int AS attachment_count,
              MIN(item.status) AS item_status,
              MIN(manifest.status) AS attachment_status
         FROM note_transfer_operations operation
         JOIN note_transfer_operation_items item ON item."operationId" = operation.id
         LEFT JOIN note_transfer_staged_attachments manifest ON manifest."operationId" = operation.id
        WHERE operation.id = $1
        GROUP BY operation.status, operation.result`,
      [operation.id],
    );
    assert.equal(state.rows[0].status, "completed");
    assert.equal(state.rows[0].item_count, 2);
    assert.equal(state.rows[0].item_status, "committed");
    assert.equal(state.rows[0].attachment_count, 1);
    assert.equal(state.rows[0].attachment_status, "committed");
    assert.equal(state.rows[0].result.operationId, operation.id);

    const retried = await runtime.commit({
      actorUserId: ACTOR,
      idempotencyKey: "transfer-atomic-commit-001",
    });
    assert.equal(retried.reused, true);
    assert.deepEqual(retried.result, committed.result);
    const duplicateCounts = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM notes WHERE id = ANY($1::text[])) AS notes,
         (SELECT COUNT(*)::int FROM attachments WHERE id = $2) AS attachments,
         (SELECT COUNT(*)::int FROM note_links WHERE "sourceNoteId" = $3) AS links`,
      [[targetA, targetB], targetAttachment, targetA],
    );
    assert.deepEqual(duplicateCounts.rows[0], { notes: 2, attachments: 1, links: 2 });

    const stale = await prepareOperation({
      operations,
      key: "transfer-atomic-commit-stale",
      sourceNoteIds: [SOURCE_B],
      sourceVersions: { [SOURCE_B]: 7 },
      includeAttachments: false,
      includeTags: false,
      attachmentSize: 0,
    });
    await pool.query(`UPDATE notes SET version = 8 WHERE id = $1`, [SOURCE_B]);
    await assert.rejects(
      runtime.commit({ actorUserId: ACTOR, idempotencyKey: "transfer-atomic-commit-stale" }),
      (error: any) => error?.code === "NOTE_TRANSFER_COMMIT_STALE",
    );
    const staleState = await pool.query(
      `SELECT status FROM note_transfer_operations WHERE id = $1`,
      [stale.id],
    );
    assert.equal(staleState.rows[0].status, "staging");
    const staleTarget = stale.plan.targetNoteIds[SOURCE_B];
    assert.equal(
      Number((await pool.query(`SELECT COUNT(*) AS count FROM notes WHERE id = $1`, [staleTarget])).rows[0].count),
      0,
    );
    await pool.query(`UPDATE notes SET version = 7 WHERE id = $1`, [SOURCE_B]);

    await prepareOperation({
      operations,
      key: "transfer-atomic-commit-race",
      sourceNoteIds: [SOURCE_B],
      sourceVersions: { [SOURCE_B]: 7 },
      includeAttachments: false,
      includeTags: false,
      attachmentSize: 0,
    });
    const race = await Promise.all([
      runtime.commit({ actorUserId: ACTOR, idempotencyKey: "transfer-atomic-commit-race" }),
      runtime.commit({ actorUserId: ACTOR, idempotencyKey: "transfer-atomic-commit-race" }),
    ]);
    assert.equal(race.filter((item) => item.reused === false).length, 1);
    assert.equal(race.filter((item) => item.reused === true).length, 1);
    assert.equal(race[0].operation.status, "completed");
    assert.equal(race[1].operation.status, "completed");

    await prepareOperation({
      operations,
      key: "transfer-atomic-commit-move",
      mode: "move",
      sourceNoteIds: [SOURCE_B],
      sourceVersions: { [SOURCE_B]: 7 },
      includeAttachments: false,
      includeTags: false,
      attachmentSize: 0,
    });
    const moveCommit = await runtime.commit({
    actorUserId: ACTOR,
    idempotencyKey: "transfer-atomic-commit-move",
  });
  assert.equal(moveCommit.reused, false);
  assert.equal(moveCommit.operation.status, "target_committed");
  assert.equal(
    Number((await pool.query(`SELECT COUNT(*) AS count FROM notes WHERE id = $1`, [SOURCE_B])).rows[0].count),
    1,
  );
  assert.equal(
    Number((await pool.query(`SELECT COUNT(*) AS count FROM notes WHERE id = $1`, [moveCommit.result.targetNoteIds[SOURCE_B]])).rows[0].count),
    1,
  );
  } finally {
    await fs.promises.rm(dataDir, { recursive: true, force: true });
    await closePgPool(pool);
  }
});
