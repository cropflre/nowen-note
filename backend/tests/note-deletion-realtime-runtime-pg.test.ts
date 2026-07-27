import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { WebSocket } from "ws";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import { signLoginToken } from "../src/lib/auth-security";
import { createNoteDeletionRealtimeRuntime } from "../src/services/note-deletion-realtime-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const USER = "pg-deletion-ws-user";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function waitForMessage(
  messages: Array<Record<string, unknown>>,
  type: string,
  timeoutMs = 2_000,
): Promise<Record<string, unknown>> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const message = messages.find((entry) => entry.type === type);
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for websocket message ${type}`);
}

test("PostgreSQL deletion-only websocket hub authenticates and broadcasts single/batch events", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  const server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  let ws: WebSocket | null = null;
  const realtime = createNoteDeletionRealtimeRuntime(new PostgresAdapter(pool));
  try {
    await initPgSchema(pool);
    await pool.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await pool.query(
      `INSERT INTO users (id, username, "passwordHash", "tokenVersion", "isDisabled")
       VALUES ($1, $1, 'hash', 0, false)`,
      [USER],
    );

    realtime.attach(server);
    const port = await listen(server);
    const token = signLoginToken({ userId: USER, username: USER, tokenVersion: 0 });
    const messages: Array<Record<string, unknown>> = [];
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    ws.on("message", (data) => {
      messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    await once(ws, "open");
    const connected = await waitForMessage(messages, "connected");
    assert.equal(connected.userId, USER);
    assert.deepEqual(connected.capabilities, ["note-deletion-events"]);

    await realtime.publish({
      kind: "note.deleted",
      actorUserId: USER,
      noteOwnerUserId: USER,
      workspaceId: null,
      noteId: "ws-note-single",
      attachmentCount: 0,
      removedFiles: 0,
      skippedSharedPaths: 0,
      cleanupWarnings: [],
    });
    const single = await waitForMessage(messages, "note:deleted");
    assert.equal(single.noteId, "ws-note-single");
    assert.equal(single.trashed, false);

    await realtime.publish({
      kind: "note.trash_emptied",
      actorUserId: USER,
      ownerUserId: USER,
      workspaceId: null,
      noteIds: ["ws-note-a", "ws-note-b"],
      skipped: 1,
      attachmentCount: 0,
      removedFiles: 0,
      skippedSharedPaths: 0,
      cleanupWarnings: [],
      freedBytesEstimate: 10,
    });
    const batch = await waitForMessage(messages, "notes:deleted");
    assert.deepEqual(batch.noteIds, ["ws-note-a", "ws-note-b"]);
    assert.equal(realtime.getStats().clients, 1);
  } finally {
    if (ws) ws.terminate();
    await realtime.close();
    await closeServer(server);
    await closePgPool(pool);
  }
});
