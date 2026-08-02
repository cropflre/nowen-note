import assert from "node:assert/strict";
import test from "node:test";

import { Hono } from "hono";
import { v4 as uuid } from "uuid";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import createNoteTransfersRuntimeRouter from "../src/routes/note-transfers-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const ACTOR = "pg-transfer-preview-actor";
const OUTSIDER = "pg-transfer-preview-outsider";
const SOURCE_NOTE_A = "11111111-1111-4111-8111-111111111111";
const SOURCE_NOTE_B = "22222222-2222-4222-8222-222222222222";
const EXTERNAL_NOTE = "33333333-3333-4333-8333-333333333333";
const SOURCE_NOTEBOOK = "pg-transfer-preview-source-notebook";
const PERSONAL_TARGET = "pg-transfer-preview-personal-target";
const ACTOR_WORKSPACE = "pg-transfer-preview-actor-workspace";
const ACTOR_TARGET = "pg-transfer-preview-actor-target";
const OUTSIDER_WORKSPACE = "pg-transfer-preview-outsider-workspace";
const OUTSIDER_TARGET = "pg-transfer-preview-outsider-target";
const TAG = "pg-transfer-preview-tag";

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
    `INSERT INTO tags (id, "userId", name, color)
     VALUES ($1, $2, 'transfer-tag', '#58a6ff')`,
    [TAG, ACTOR],
  );
  await pool.query(
    `INSERT INTO note_tags ("noteId", "tagId") VALUES ($1, $3), ($2, $3)`,
    [SOURCE_NOTE_A, SOURCE_NOTE_B, TAG],
  );
}

test("PostgreSQL note-transfer preview is permission-safe and execution stays closed", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);

  try {
    await initPgSchema(pool);
    await seed(pool);

    const app = new Hono();
    app.route(
      "/api/note-transfers",
      createNoteTransfersRuntimeRouter(new PostgresAdapter(pool)),
    );

    const preview = async (
      actorUserId: string,
      body: Record<string, unknown>,
      expectedStatus = 200,
      extraHeaders: Record<string, string> = {},
    ) => responseJson<Record<string, any>>(
      await app.request("/api/note-transfers/preview", {
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

    const success = await preview(ACTOR, {
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
    });
    assert.equal(success.canExecute, true);
    assert.equal(success.sourceWorkspaceId, null);
    assert.equal(success.targetWorkspaceId, ACTOR_WORKSPACE);
    assert.equal(success.noteCount, 2);
    assert.equal(success.attachmentCount, 0);
    assert.equal(success.attachmentBytes, 0);
    assert.equal(success.missingAttachmentCount, 0);
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
    assert(success.omitted.includes("笔记级 ACL 与成员权限覆写"));

    const stale = await preview(ACTOR, {
      sourceNoteIds: [SOURCE_NOTE_A],
      targetWorkspaceId: ACTOR_WORKSPACE,
      targetNotebookId: ACTOR_TARGET,
      mode: "copy",
      expectedVersions: { [SOURCE_NOTE_A]: 3 },
    });
    assert.equal(stale.canExecute, false);
    assert(stale.blockers.some((blocker: { code: string }) => blocker.code === "SOURCE_VERSION_CONFLICT"));

    await pool.query(`UPDATE notes SET "isLocked" = true WHERE id = $1`, [SOURCE_NOTE_A]);
    const lockedMove = await preview(ACTOR, {
      sourceNoteIds: [SOURCE_NOTE_A],
      targetWorkspaceId: ACTOR_WORKSPACE,
      targetNotebookId: ACTOR_TARGET,
      mode: "move",
      expectedVersions: { [SOURCE_NOTE_A]: 4 },
    });
    assert.equal(lockedMove.canExecute, false);
    assert(lockedMove.blockers.some((blocker: { code: string }) => blocker.code === "SOURCE_NOTE_LOCKED"));
    await pool.query(`UPDATE notes SET "isLocked" = false WHERE id = $1`, [SOURCE_NOTE_A]);

    const outsider = await preview(OUTSIDER, {
      sourceNoteIds: [SOURCE_NOTE_A],
      targetWorkspaceId: OUTSIDER_WORKSPACE,
      targetNotebookId: OUTSIDER_TARGET,
      mode: "copy",
    });
    assert.equal(outsider.canExecute, false);
    assert(outsider.blockers.some((blocker: { code: string }) => blocker.code === "SOURCE_NOTE_FORBIDDEN"));
    assert(outsider.blockers.some((blocker: { code: string }) => blocker.code === "SOURCE_PERSONAL_FORBIDDEN"));

    const sameWorkspace = await preview(ACTOR, {
      sourceNoteIds: [SOURCE_NOTE_A],
      targetWorkspaceId: null,
      targetNotebookId: PERSONAL_TARGET,
      mode: "copy",
    }, 400);
    assert.equal(sameWorkspace.code, "SAME_WORKSPACE_TRANSFER_FORBIDDEN");

    const apiToken = await preview(ACTOR, {
      sourceNoteIds: [SOURCE_NOTE_A],
      targetWorkspaceId: ACTOR_WORKSPACE,
      targetNotebookId: ACTOR_TARGET,
      mode: "copy",
    }, 403, { "X-Auth-Mode": "api-token" });
    assert.equal(apiToken.code, "INTERACTIVE_LOGIN_REQUIRED");

    const execution = await responseJson<{ code: string; issue: number }>(
      await app.request("/api/note-transfers", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-User-Id": ACTOR },
        body: JSON.stringify({
          sourceNoteIds: [SOURCE_NOTE_A],
          targetWorkspaceId: ACTOR_WORKSPACE,
          targetNotebookId: ACTOR_TARGET,
          mode: "copy",
        }),
      }),
      503,
    );
    assert.equal(execution.code, "POSTGRES_NOTE_TRANSFER_EXECUTION_PENDING");
    assert.equal(execution.issue, 249);
  } finally {
    await pool.query(`DELETE FROM users WHERE id IN ($1, $2)`, [ACTOR, OUTSIDER]).catch(() => undefined);
    await closePgPool();
  }
});
