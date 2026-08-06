import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test from "node:test";

import { WebSocket } from "ws";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import { signLoginToken } from "../src/lib/auth-security";
import { createPostgresYjsSubdocumentWebsocketRuntime } from "../src/services/postgres-yjs-subdocuments-websocket-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const USER = "pg-subdoc-structure-ws-user";
const NOTEBOOK = "pg-subdoc-structure-ws-notebook";
const NOTE = "f9999999-9999-4999-8999-999999999999";

function text(value: string) {
  return { type: "text", text: value };
}

function heading(blockId: string, value: string, level = 2) {
  return { type: "heading", attrs: { level, blockId }, content: [text(value)] };
}

function paragraph(blockId: string, value: string) {
  return { type: "paragraph", attrs: { blockId }, content: [text(value)] };
}

function document(nodes: unknown[]): string {
  return JSON.stringify({ type: "doc", content: nodes });
}

const baseContent = document([
  heading("blk_ws_structure_one", "One", 1),
  paragraph("blk_ws_structure_alpha", "Alpha"),
  heading("blk_ws_structure_two", "Two", 2),
  paragraph("blk_ws_structure_beta", "Beta"),
]);

const expandedContent = document([
  heading("blk_ws_structure_one", "One", 1),
  paragraph("blk_ws_structure_alpha", "Alpha"),
  heading("blk_ws_structure_two", "Two", 2),
  paragraph("blk_ws_structure_beta", "Beta"),
  heading("blk_ws_structure_three", "Three", 2),
  paragraph("blk_ws_structure_gamma", "Gamma"),
]);

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function waitForMessage(
  messages: Array<Record<string, any>>,
  type: string,
  predicate: (message: Record<string, any>) => boolean = () => true,
  timeoutMs = 3_000,
): Promise<Record<string, any>> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const message = messages.find((entry) => entry.type === type && predicate(entry));
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for websocket message ${type}`);
}

test("PostgreSQL subdocument websocket applies idempotent structure changes and reloads rooms", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  await initPgSchema(pool);
  await pool.query(`DELETE FROM users WHERE id = $1`, [USER]);
  await pool.query(
    `INSERT INTO users (id, username, "passwordHash", "tokenVersion", "isDisabled")
     VALUES ($1, $1, 'hash', 0, false)`,
    [USER],
  );
  await pool.query(
    `INSERT INTO notebooks (id, "userId", name) VALUES ($1, $2, 'Structure websocket')`,
    [NOTEBOOK, USER],
  );
  await pool.query(
    `INSERT INTO notes (
       id, "userId", "notebookId", title, content, "contentText", "contentFormat", version
     ) VALUES ($1, $2, $3, 'Structure websocket', $4, 'One Alpha Two Beta', 'tiptap-json', 1)`,
    [NOTE, USER, NOTEBOOK, baseContent],
  );

  const server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  const runtime = createPostgresYjsSubdocumentWebsocketRuntime(new PostgresAdapter(pool), {
    heartbeatIntervalMs: 50,
    clientTimeoutMs: 2_000,
  });
  let ws: WebSocket | null = null;

  try {
    runtime.attach(server);
    const port = await listen(server);
    const token = signLoginToken({ userId: USER, username: USER, tokenVersion: 0 });
    const messages: Array<Record<string, any>> = [];
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws/subdocuments?token=${encodeURIComponent(token)}`);
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await once(ws, "open");

    const connected = await waitForMessage(messages, "connected");
    assert.ok(connected.capabilities.includes("yjs-subdocument-structure-change"));
    assert.ok(connected.capabilities.includes("yjs-subdocument-idempotent-structure-operations"));
    assert.deepEqual(connected.pendingCapabilities, []);

    ws.send(JSON.stringify({ type: "y:subdoc:join", noteId: NOTE }));
    const initial = await waitForMessage(messages, "y:subdoc:state", (message) => (
      message.noteId === NOTE && message.section === null
    ));
    assert.equal(initial.manifest.generation, 1);

    ws.send(JSON.stringify({
      type: "y:subdoc:structure",
      noteId: NOTE,
      generation: 1,
      operationId: "ws-structure-add-third",
      content: expandedContent,
    }));
    const ack = await waitForMessage(messages, "y:subdoc:structure-ack", (message) => (
      message.operationId === "ws-structure-add-third" && message.replayed === false
    ));
    assert.equal(ack.version, 2);
    assert.equal(ack.generation, 2);
    assert.equal(ack.structureVersion, 2);
    assert.equal(ack.manifest.sections.length, 3);
    await waitForMessage(messages, "y:subdoc:reload", (message) => (
      message.noteId === NOTE && message.reason === "structure-changed"
    ));

    messages.length = 0;
    ws.send(JSON.stringify({ type: "y:subdoc:join", noteId: NOTE }));
    await waitForMessage(messages, "y:subdoc:state", (message) => (
      message.noteId === NOTE && message.manifest?.generation === 2
    ));
    ws.send(JSON.stringify({
      type: "y:subdoc:structure",
      noteId: NOTE,
      generation: 1,
      operationId: "ws-structure-add-third",
      content: expandedContent,
    }));
    const replay = await waitForMessage(messages, "y:subdoc:structure-ack", (message) => (
      message.operationId === "ws-structure-add-third" && message.replayed === true
    ));
    assert.equal(replay.version, 2);
    assert.equal(replay.generation, 2);
    await waitForMessage(messages, "y:subdoc:reload", (message) => (
      message.noteId === NOTE && message.reason === "structure-operation-replayed"
    ));

    messages.length = 0;
    ws.send(JSON.stringify({ type: "y:subdoc:join", noteId: NOTE }));
    await waitForMessage(messages, "y:subdoc:state", (message) => (
      message.noteId === NOTE && message.manifest?.generation === 2
    ));
    ws.send(JSON.stringify({
      type: "y:subdoc:structure",
      noteId: NOTE,
      generation: 2,
      operationId: "ws-structure-add-third",
      content: baseContent,
    }));
    await waitForMessage(messages, "error", (message) => (
      message.noteId === NOTE && message.code === "SUBDOCUMENT_OPERATION_REUSED"
    ));

    const persisted = (await pool.query(
      `SELECT content, version FROM notes WHERE id = $1`,
      [NOTE],
    )).rows[0];
    assert.equal(persisted.content, expandedContent);
    assert.equal(Number(persisted.version), 2);
    assert.equal(Number((await pool.query(
      `SELECT COUNT(*)::int AS count
         FROM note_y_subdocument_structure_operations WHERE "noteId" = $1`,
      [NOTE],
    )).rows[0].count), 1);

    const stats = runtime.getStats();
    assert.equal(stats.structureChanges, 1);
    assert.equal(stats.invalidations, 2);
  } finally {
    if (ws) {
      try {
        ws.close();
      } catch {}
    }
    await runtime.close();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await closePgPool(pool);
  }
});
