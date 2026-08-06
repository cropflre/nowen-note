import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

import type { DatabaseAdapter } from "../src/db/adapters/types";

const databaseUrl = process.env.TEST_PG_DATABASE_URL;
const skip = !databaseUrl;

test("PostgreSQL knowledge-tree create runtime is permission-safe and transactional", { skip }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: databaseUrl });
  const runtime = await import("../src/db/runtime");

  await runtime.resetDatabaseRuntimeForTests();
  await runtime.initializeDatabase({
    env: {
      ...process.env,
      DB_DRIVER: "postgres",
      DATABASE_URL: databaseUrl,
    },
    dependencies: {
      createPostgresPool: () => pool,
      logger: { log: () => undefined, warn: () => undefined },
    },
  });

  const { runPostgresMigrations } = await import("../src/db/postgres/migrations");
  await runPostgresMigrations();

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const ownerId = `pg-tree-create-owner-${suffix}`;
  const editorId = `pg-tree-create-editor-${suffix}`;
  const viewerId = `pg-tree-create-viewer-${suffix}`;
  const workspaceId = `pg-tree-create-ws-${suffix}`;

  for (const userId of [ownerId, editorId, viewerId]) {
    await pool.query(
      `INSERT INTO users (id, username, "passwordHash") VALUES ($1, $2, $3)`,
      [userId, userId, "hash"],
    );
  }
  await pool.query(
    `INSERT INTO workspaces (id, name, "ownerId") VALUES ($1, $2, $3)`,
    [workspaceId, "Knowledge Create Workspace", ownerId],
  );
  await pool.query(
    `INSERT INTO workspace_members ("workspaceId", "userId", role)
     VALUES ($1, $2, 'editor'), ($1, $3, 'viewer')`,
    [workspaceId, editorId, viewerId],
  );

  try {
    const { default: createKnowledgeTreeRuntimeRouter } = await import(
      "../src/routes/knowledge-tree-runtime"
    );
    const app = new Hono();
    app.route(
      "/api/knowledge-tree",
      createKnowledgeTreeRuntimeRouter(runtime.getDatabaseAdapter(), "postgres"),
    );

    const folderResponse = await app.request(
      `/api/knowledge-tree/nodes?workspaceId=${encodeURIComponent(workspaceId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-User-Id": ownerId },
        body: JSON.stringify({
          parentId: null,
          nodeType: "folder",
          title: "Created Runtime Folder",
        }),
      },
    );
    assert.equal(folderResponse.status, 201);
    const folder = await folderResponse.json() as {
      id: string;
      resourceId: string;
      resourceType: string;
      parentId: string | null;
      title: string;
    };
    assert.equal(folder.resourceType, "notebook");
    assert.equal(folder.parentId, null);
    assert.equal(folder.title, "Created Runtime Folder");

    const markdownResponse = await app.request(
      `/api/knowledge-tree/nodes?workspaceId=${encodeURIComponent(workspaceId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-User-Id": editorId },
        body: JSON.stringify({
          parentId: folder.id,
          nodeType: "markdown",
          title: "Created Markdown",
        }),
      },
    );
    assert.equal(markdownResponse.status, 201);
    const markdown = await markdownResponse.json() as {
      id: string;
      resourceId: string;
      resourceType: string;
      parentId: string | null;
      title: string;
      contentFormat: string | null;
    };
    assert.equal(markdown.resourceType, "note");
    assert.equal(markdown.parentId, folder.id);
    assert.equal(markdown.title, "Created Markdown");
    assert.equal(markdown.contentFormat, "markdown");

    const stored = await pool.query<{
      notebookId: string;
      content: string;
      contentFormat: string;
      treeParentId: string;
    }>(
      `SELECT note."notebookId" AS "notebookId", note.content,
              note."contentFormat" AS "contentFormat", node."parentId" AS "treeParentId"
         FROM notes note
         JOIN knowledge_tree_nodes node
           ON node."resourceType" = 'note' AND node."resourceId" = note.id
        WHERE note.id = $1`,
      [markdown.resourceId],
    );
    assert.equal(stored.rows[0]?.notebookId, folder.resourceId);
    assert.equal(stored.rows[0]?.contentFormat, "markdown");
    assert.equal(stored.rows[0]?.treeParentId, folder.id);
    assert.match(stored.rows[0]?.content || "", /^# Created Markdown/);

    const history = await pool.query<{ action: string; toParentId: string | null }>(
      `SELECT action, "toParentId" AS "toParentId"
         FROM knowledge_tree_history
        WHERE "nodeId" = ANY($1::text[])
        ORDER BY "createdAt" ASC`,
      [[folder.id, markdown.id]],
    );
    assert.equal(history.rowCount, 2);
    assert(history.rows.every((row) => row.action === "create"));
    assert.equal(history.rows.find((row) => row.toParentId)?.toParentId, folder.id);

    const rootNoteResponse = await app.request(
      `/api/knowledge-tree/nodes?workspaceId=${encodeURIComponent(workspaceId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-User-Id": ownerId },
        body: JSON.stringify({ parentId: null, nodeType: "note", title: "Invalid Root Note" }),
      },
    );
    assert.equal(rootNoteResponse.status, 400);
    assert.equal(
      (await rootNoteResponse.json() as { code: string }).code,
      "KNOWLEDGE_TREE_NOTE_CONTAINER_REQUIRED",
    );

    const viewerCreateResponse = await app.request(
      `/api/knowledge-tree/nodes?workspaceId=${encodeURIComponent(workspaceId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-User-Id": viewerId },
        body: JSON.stringify({ parentId: null, nodeType: "folder", title: "Forbidden Folder" }),
      },
    );
    assert.equal(viewerCreateResponse.status, 403);
    assert.equal(
      (await viewerCreateResponse.json() as { code: string }).code,
      "KNOWLEDGE_CAPABILITY_FORBIDDEN",
    );

    await pool.query(
      `INSERT INTO knowledge_tree_acl ("nodeId", "userId", "rolePreset")
       VALUES ($1, $2, 'readonly')`,
      [folder.id, editorId],
    );
    const readonlyCreateResponse = await app.request(
      `/api/knowledge-tree/nodes?workspaceId=${encodeURIComponent(workspaceId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-User-Id": editorId },
        body: JSON.stringify({ parentId: folder.id, nodeType: "note", title: "Forbidden Note" }),
      },
    );
    assert.equal(readonlyCreateResponse.status, 403);
    const readonlyPayload = await readonlyCreateResponse.json() as {
      code: string;
      required: string;
    };
    assert.equal(readonlyPayload.code, "KNOWLEDGE_CAPABILITY_FORBIDDEN");
    assert.equal(readonlyPayload.required, "canCreate");

    const baseAdapter = runtime.getDatabaseAdapter();
    const failingAdapter: DatabaseAdapter = {
      queryOne: <T>(sql: string, params?: unknown[]) => baseAdapter.queryOne<T>(sql, params),
      queryMany: <T>(sql: string, params?: unknown[]) => baseAdapter.queryMany<T>(sql, params),
      execute: (sql: string, params?: unknown[]) => baseAdapter.execute(sql, params),
      executeBatch: (sql: string, paramsList: unknown[][]) => baseAdapter.executeBatch(sql, paramsList),
      executeStatements: (statements) => baseAdapter.executeStatements([
        ...statements,
        { sql: "INSERT INTO knowledge_tree_create_rollback_probe (id) VALUES (?)", params: [suffix] },
      ]),
    };
    const { createKnowledgeTreeMutationRepository } = await import(
      "../src/repositories/knowledgeTreeMutationRepository"
    );
    const failingRepository = createKnowledgeTreeMutationRepository(failingAdapter, "postgres");
    const rollbackTitle = `Rollback Folder ${suffix}`;
    await assert.rejects(
      failingRepository.createNode({
        actorUserId: ownerId,
        workspaceId,
        parentId: null,
        nodeType: "folder",
        title: rollbackTitle,
      }),
    );

    const rolledBackNotebook = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM notebooks WHERE name = $1 AND "workspaceId" = $2`,
      [rollbackTitle, workspaceId],
    );
    assert.equal(rolledBackNotebook.rows[0]?.count, "0");
    const rolledBackHistory = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM knowledge_tree_history history
         JOIN knowledge_tree_nodes node ON node.id = history."nodeId"
        WHERE node."workspaceId" = $1 AND history.metadata::text LIKE $2`,
      [workspaceId, `%${rollbackTitle}%`],
    );
    assert.equal(rolledBackHistory.rows[0]?.count, "0");
  } finally {
    await pool.query(`DELETE FROM knowledge_tree_acl WHERE "userId" = ANY($1::text[])`, [
      [editorId, viewerId],
    ]);
    await pool.query(`DELETE FROM notes WHERE "workspaceId" = $1`, [workspaceId]);
    await pool.query(`DELETE FROM notebooks WHERE "workspaceId" = $1`, [workspaceId]);
    await pool.query(`DELETE FROM workspace_members WHERE "workspaceId" = $1`, [workspaceId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [
      [ownerId, editorId, viewerId],
    ]);
    await runtime.resetDatabaseRuntimeForTests();
  }
});
