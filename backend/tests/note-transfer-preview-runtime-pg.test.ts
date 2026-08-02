import assert from "node:assert/strict";
import test from "node:test";

import { Hono } from "hono";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import { createNoteTransferOperationRepository } from "../src/repositories/noteTransferOperationRepository";
import createNoteTransfersRuntimeRouter from "../src/routes/note-transfers-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const ACTOR = "pg-transfer-preview-actor";
const OUTSIDER = "pg-transfer-preview-outsider";
const SOURCE_NOTE_A = "11111111-1111-4111-8111-111111111111";
const SOURCE_NOTE_B = "22222222-2222-4222-8222-222222222222";
const EXTERNAL_NOTE = "33333333-3333-4333-8333-333333333333";
const ATTACHMENT = "44444444-4444-4444-8444-444444444444";
const SOURCE_NOTEBOOK = "pg-transfer-preview-source-notebook";
const PERSONAL_TARGET = "pg-transfer-preview-personal-target";
const ACTOR_WORKSPACE = "pg-transfer-preview-actor-workspace";
const ACTOR_TARGET = "pg-transfer-preview-actor-target";
const OUTSIDER_WORKSPACE = "pg-transfer-preview-outsider-workspace";
const OUTSIDER_TARGET = "pg-transfer-preview-outsider-target";
const TAG = "pg-transfer-preview-tag";
const IDEMPOTENCY_KEY = "transfer-preview-operation-001";

async function responseJson<T>(response: Response, expectedStatus: number): Promise<T> {
  const text = await response.text();
  assert.equal(response.status, expectedStatus, text);
  return JSON.parse(text) as T;
}

async function seed(pool: import("pg").Pool): Promise<void> {
  await pool.query(`DELETE FROM users WHERE id IN ($1, $2)`, [ACTOR, OUTSIDER]);
  await pool.query(
    `INSERT INTO users (id, username, "passwordHash", "tokenVersion")
     VALUES ($1, $1, 'hash', 0), ($2, $2, 'hash', 0)`,
    [ACTOR, OUTSIDER],
  );
  await pool.query(
    `INSERT INTO workspaces (id, name, "ownerId")
     VALUES ($1, 'Actor workspace', $2), ($3, 'Outsider workspace', $4)`,
    [ACTOR_WORKSPACE, ACTOR, OUTSIDER_WORKSPACE, OUTSIDER],
  );
  await pool.query(
    `INSERT INTO notebooks (id, "userId", "workspaceId", name)
     VALUES
       ($1, $2, NULL, 'Source'),
       ($3, $2, NULL, 'Personal target'),
       ($4, $2, $5, 'Actor target'),
       ($6, $7, $8, 'Outsider target')`,
    [
      SOURCE_NOTEBOOK,
      ACTOR,
      PERSONAL_TARGET,
      ACTOR_TARGET,
      ACTOR_WORKSPACE,
      OUTSIDER_TARGET,
      OUTSIDER,
      OUTSIDER_WORKSPACE,
    ],
  );
  await pool.query(
    `INSERT INTO notes (
       id, "userId", "notebookId", title, content, "contentText",
       "contentFormat", version, "isLocked"
     ) VALUES
       ($1, $2, $3, 'Transfer A', $4, 'Transfer A', 'markdown', 4, false),
       ($5, $2, $3, 'Transfer B', '# Transfer B', 'Transfer B', 'markdown', 7, false)`,
    [
      SOURCE_NOTE_A,
      ACTOR,
      SOURCE_NOTEBOOK,
      `# Transfer A\n\nInternal note:${SOURCE_NOTE_B}\nExternal note:${EXTERNAL_NOTE}`,
      SOURCE_NOTE_B,
    ],
  );
  await pool.query(
    `INSERT INTO attachments (
       id, "noteId", "userId", filename, "mimeType", size, path, hash
     ) VALUES ($1, $2, $3, 'missing.bin', 'application/octet-stream', 24,
               'pg-transfer-preview/missing.bin', 'missing-hash')`,
    [ATTACHMENT, SOURCE_NOTE_A, ACTOR],
  );
  await pool.query(
    `INSERT INTO tags (id, "userId", name, color)
     VALUES ($1, $2, 'transfer-tag', '#58a6ff')`,
    [TAG, ACTOR],
  );
  await pool.query(
    `INSERT INTO note_tags ("noteId", "tagId") VALUES ($1, $3), ($2, $3)`,
    [SOURCE_NOTE_A, SOURCE_NOTE_B, TAG],
  );
}

test("PostgreSQL note-transfer preview and durable preparation are permission-safe", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);

  try {
    await initPgSchema(pool);
    await seed(pool);

    const adapter = new PostgresAdapter(pool);
    const app = new Hono();
    app.route(
      "/api/note-transfers",
      createNoteTransfersRuntimeRouter(adapter),
    );

    const request = async (
      path: string,
      actorUserId: string,
      body: Record<string, unknown>,
      expectedStatus = 200,
      extraHeaders: Record<string, string> = {},
    ) => responseJson<Record<string, any>>(
      await app.request(`/api/note-transfers${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-User-Id": actorUserId,
          ...extraHeaders,
        },
        body: JSON.stringify(body),
      }),
      expectedStatus,
    );

    const previewBody = {
      sourceNoteIds: [SOURCE_NOTE_A, SOURCE_NOTE_B, SOURCE_NOTE_A],
      targetWorkspaceId: ACTOR_WORKSPACE,
      targetNotebookId: ACTOR_TARGET,
      mode: "copy",
      includeAttachments: true,
      includeTags: true,
      expectedVersions: {
        [SOURCE_NOTE_A]: 4,
        [SOURCE_NOTE_B]: 7,
      },
    };
    const success = await request("/preview", ACTOR, previewBody);
    assert.equal(success.canExecute, true);
    assert.equal(success.sourceWorkspaceId, null);
    assert.equal(success.targetWorkspaceId, ACTOR_WORKSPACE);
    assert.equal(success.noteCount, 2);
    assert.equal(success.attachmentCount, 1);
    assert.equal(success.attachmentBytes, 24);
    assert.equal(success.missingAttachmentCount, 1);
    assert.equal(success.tagCount, 1);
    assert.equal(success.internalNoteLinkCount, 1);
    assert.equal(success.externalNoteLinkCount, 1);
    assert.deepEqual(success.sourceVersions, {
      [SOURCE_NOTE_A]: 4,
      [SOURCE_NOTE_B]: 7,
    });
    assert.deepEqual(
      success.notes.map((note: { id: string; version: number }) => [note.id, note.version]),
      [[SOURCE_NOTE_A, 4], [SOURCE_NOTE_B, 7]],
    );
    assert(success.warnings.some((warning: string) => warning.includes("批次外笔记")));
    assert(success.warnings.some((warning: string) => warning.includes("附件文件缺失")));
    assert(success.omitted.includes("笔记级 ACL 与成员权限覆写"));

    const prepared = await request("/prepare", ACTOR, {
      ...previewBody,
      idempotencyKey: IDEMPOTENCY_KEY,
    }, 201);
    assert.equal(prepared.status, "prepared");
    assert.equal(prepared.reused, false);
    assert.equal(prepared.sourceNoteCount, 2);
    assert.equal(prepared.plan.attachmentCount, 1);
    assert.equal(prepared.plan.attachmentBytes, 24);
    assert.deepEqual(prepared.plan.sourceNoteIds, [SOURCE_NOTE_A, SOURCE_NOTE_B]);
    assert.equal(prepared.items.length, 2);
    assert.equal(new Set(prepared.items.map((item: { targetNoteId: string }) => item.targetNoteId)).size, 2);
    assert.deepEqual(
      prepared.items.map((item: { sourceNoteId: string; sourceVersion: number; itemOrder: number }) => [
        item.sourceNoteId,
        item.sourceVersion,
        item.itemOrder,
      ]),
      [[SOURCE_NOTE_A, 4, 0], [SOURCE_NOTE_B, 7, 1]],
    );

    const reused = await request("/prepare", ACTOR, {
      ...previewBody,
      idempotencyKey: IDEMPOTENCY_KEY,
    }, 200);
    assert.equal(reused.id, prepared.id);
    assert.equal(reused.reused, true);
    assert.deepEqual(reused.plan.targetNoteIds, prepared.plan.targetNoteIds);

    const loaded = await responseJson<Record<string, any>>(
      await app.request(`/api/note-transfers/operations/${encodeURIComponent(IDEMPOTENCY_KEY)}`, {
        headers: { "X-User-Id": ACTOR },
      }),
      200,
    );
    assert.equal(loaded.id, prepared.id);
    assert.equal(loaded.reused, false);

    const idempotencyConflict = await request("/prepare", ACTOR, {
      ...previewBody,
      sourceNoteIds: [SOURCE_NOTE_A],
      expectedVersions: { [SOURCE_NOTE_A]: 4 },
      idempotencyKey: IDEMPOTENCY_KEY,
    }, 409);
    assert.equal(idempotencyConflict.code, "NOTE_TRANSFER_IDEMPOTENCY_CONFLICT");

    const invalidKey = await request("/prepare", ACTOR, {
      ...previewBody,
      idempotencyKey: "short",
    }, 400);
    assert.equal(invalidKey.code, "NOTE_TRANSFER_IDEMPOTENCY_KEY_INVALID");

    const operations = createNoteTransferOperationRepository(adapter);
    await assert.rejects(
      operations.prepare({
        actorUserId: ACTOR,
        idempotencyKey: "transfer-preview-stale-rollback",
        mode: "copy",
        sourceWorkspaceId: null,
        targetWorkspaceId: ACTOR_WORKSPACE,
        targetNotebookId: ACTOR_TARGET,
        includeAttachments: true,
        includeTags: true,
        sourceNoteIds: [SOURCE_NOTE_A, SOURCE_NOTE_B],
        sourceVersions: { [SOURCE_NOTE_A]: 4, [SOURCE_NOTE_B]: 6 },
        attachmentCount: 1,
        attachmentBytes: 24,
        tagCount: 1,
        internalNoteLinkCount: 1,
        externalNoteLinkCount: 1,
      }),
      (error: any) => error?.code === "NOTE_TRANSFER_PLAN_STALE",
    );
    const rolledBack = await pool.query(
      `SELECT COUNT(*)::int AS count
         FROM note_transfer_operations
        WHERE "userId" = $1 AND "idempotencyKey" = $2`,
      [ACTOR, "transfer-preview-stale-rollback"],
    );
    assert.equal(rolledBack.rows[0].count, 0);

    const stale = await request("/preview", ACTOR, {
      sourceNoteIds: [SOURCE_NOTE_A],
      targetWorkspaceId: ACTOR_WORKSPACE,
      targetNotebookId: ACTOR_TARGET,
      mode: "copy",
      expectedVersions: { [SOURCE_NOTE_A]: 3 },
    });
    assert.equal(stale.canExecute, false);
    assert(stale.blockers.some((blocker: { code: string }) => blocker.code === "SOURCE_VERSION_CONFLICT"));

    await pool.query(`UPDATE notes SET "isLocked" = true WHERE id = $1`, [SOURCE_NOTE_A]);
    const lockedMove = await request("/preview", ACTOR, {
      sourceNoteIds: [SOURCE_NOTE_A],
      targetWorkspaceId: ACTOR_WORKSPACE,
      targetNotebookId: ACTOR_TARGET,
      mode: "move",
      expectedVersions: { [SOURCE_NOTE_A]: 4 },
    });
    assert.equal(lockedMove.canExecute, false);
    assert(lockedMove.blockers.some((blocker: { code: string }) => blocker.code === "SOURCE_NOTE_LOCKED"));
    assert(lockedMove.blockers.some((blocker: { code: string }) => blocker.code === "ATTACHMENT_FILE_MISSING"));
    await pool.query(`UPDATE notes SET "isLocked" = false WHERE id = $1`, [SOURCE_NOTE_A]);

    const outsider = await request("/preview", OUTSIDER, {
      sourceNoteIds: [SOURCE_NOTE_A],
      targetWorkspaceId: OUTSIDER_WORKSPACE,
      targetNotebookId: OUTSIDER_TARGET,
      mode: "copy",
    });
    assert.equal(outsider.canExecute, false);
    assert(outsider.blockers.some((blocker: { code: string }) => blocker.code === "SOURCE_NOTE_FORBIDDEN"));
    assert(outsider.blockers.some((blocker: { code: string }) => blocker.code === "SOURCE_PERSONAL_FORBIDDEN"));

    const sameWorkspace = await request("/preview", ACTOR, {
      sourceNoteIds: [SOURCE_NOTE_A],
      targetWorkspaceId: null,
      targetNotebookId: PERSONAL_TARGET,
      mode: "copy",
    }, 400);
    assert.equal(sameWorkspace.code, "SAME_WORKSPACE_TRANSFER_FORBIDDEN");

    const apiToken = await request("/preview", ACTOR, {
      sourceNoteIds: [SOURCE_NOTE_A],
      targetWorkspaceId: ACTOR_WORKSPACE,
      targetNotebookId: ACTOR_TARGET,
      mode: "copy",
    }, 403, { "X-Auth-Mode": "api-token" });
    assert.equal(apiToken.code, "INTERACTIVE_LOGIN_REQUIRED");

    const execution = await request("", ACTOR, {
      sourceNoteIds: [SOURCE_NOTE_A],
      targetWorkspaceId: ACTOR_WORKSPACE,
      targetNotebookId: ACTOR_TARGET,
      mode: "copy",
    }, 503);
    assert.equal(execution.code, "POSTGRES_NOTE_TRANSFER_EXECUTION_PENDING");
    assert.equal(execution.issue, 249);
  } finally {
    await pool.query(`DELETE FROM users WHERE id IN ($1, $2)`, [ACTOR, OUTSIDER]).catch(() => undefined);
    await closePgPool();
  }
});
