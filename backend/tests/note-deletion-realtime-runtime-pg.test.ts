import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { WebSocket } from "ws";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import { signLoginToken } from "../src/lib/auth-security";
import { createNoteDeletionRealtimeRuntime } from "../src/services/note-deletion-realtime-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const OWNER = "pg-realtime-owner";
const MEMBER = "pg-realtime-member";
const OUTSIDER = "pg-realtime-outsider";
const WORKSPACE = "pg-realtime-workspace";
const NOTEBOOK = "pg-realtime-notebook";
const NOTE = "pg-realtime-note";

interface ConnectedClient {
  ws: WebSocket;
  messages: Array<Record<string, any>>;
  connectionId: string;
}

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
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
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

async function waitForCondition(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}

async function connectClient(port: number, userId: string): Promise<ConnectedClient> {
  const token = signLoginToken({ userId, username: userId, tokenVersion: 0 });
  const messages: Array<Record<string, any>> = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
  ws.on("message", (data) => {
    messages.push(JSON.parse(data.toString()) as Record<string, any>);
  });
  await once(ws, "open");
  const connected = await waitForMessage(messages, "connected");
  assert.equal(connected.userId, userId);
  assert.ok(Array.isArray(connected.capabilities));
  assert.ok(connected.capabilities.includes("room-subscriptions"));
  assert.ok(connected.capabilities.includes("note-presence"));
  assert.deepEqual(connected.pendingCapabilities, ["yjs-realtime"]);
  return { ws, messages, connectionId: String(connected.connectionId) };
}

function send(client: ConnectedClient, message: Record<string, unknown>): void {
  client.ws.send(JSON.stringify(message));
}

async function prepareFixture(pool: import("pg").Pool): Promise<void> {
  await initPgSchema(pool);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[OWNER, MEMBER, OUTSIDER]]);
  for (const userId of [OWNER, MEMBER, OUTSIDER]) {
    await pool.query(
      `INSERT INTO users (id, username, "passwordHash", "tokenVersion", "isDisabled", role)
       VALUES ($1, $1, 'hash', 0, false, 'user')`,
      [userId],
    );
  }
  await pool.query(
    `INSERT INTO workspaces (id, name, "ownerId") VALUES ($1, 'Realtime', $2)`,
    [WORKSPACE, OWNER],
  );
  await pool.query(
    `INSERT INTO workspace_members ("workspaceId", "userId", role) VALUES ($1, $2, 'editor')`,
    [WORKSPACE, MEMBER],
  );
  await pool.query(
    `INSERT INTO notebooks (id, "userId", "workspaceId", name) VALUES ($1, $2, $3, 'Realtime')`,
    [NOTEBOOK, OWNER, WORKSPACE],
  );
  await pool.query(
    `INSERT INTO notes (
       id, "userId", "workspaceId", "notebookId", title, content, "contentText", "contentFormat"
     ) VALUES ($1, $2, $3, $4, 'Realtime note', '{}', '', 'tiptap-json')`,
    [NOTE, OWNER, WORKSPACE, NOTEBOOK],
  );
}

test("PostgreSQL websocket hub supports room permissions, presence, cursor, mutation events and reconnect cleanup", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  const adapter = new PostgresAdapter(pool);
  const server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  const realtime = createNoteDeletionRealtimeRuntime(adapter);
  const sockets: WebSocket[] = [];

  try {
    await prepareFixture(pool);
    realtime.attach(server);
    const port = await listen(server);

    const owner = await connectClient(port, OWNER);
    const member = await connectClient(port, MEMBER);
    const outsider = await connectClient(port, OUTSIDER);
    sockets.push(owner.ws, member.ws, outsider.ws);

    send(owner, { type: "subscribe", room: `workspace:${WORKSPACE}` });
    send(owner, { type: "subscribe", room: `note:${NOTE}` });
    send(owner, { type: "presence", noteId: NOTE, editing: false });
    send(member, { type: "subscribe", room: `workspace:${WORKSPACE}` });
    send(member, { type: "subscribe", room: `note:${NOTE}` });
    send(member, { type: "presence", noteId: NOTE, editing: true });

    const presence = await waitForMessage(owner.messages, "presence", (message) => (
      message.noteId === NOTE
      && Array.isArray(message.users)
      && message.users.some((user: any) => user.userId === MEMBER && user.editing === true)
    ));
    assert.ok(presence.users.some((user: any) => user.userId === OWNER));
    assert.equal(realtime.getStats().noteRooms, 1);
    assert.equal(realtime.getStats().workspaceRooms, 1);

    send(member, {
      type: "cursor",
      noteId: NOTE,
      cursor: { line: 4, ch: 2, selection: "abc" },
    });
    const cursor = await waitForMessage(owner.messages, "presence", (message) => (
      message.cursorUpdate?.userId === MEMBER
    ));
    assert.equal(cursor.cursorUpdate.cursor.line, 4);

    send(outsider, { type: "subscribe", room: `workspace:${WORKSPACE}` });
    const workspaceForbidden = await waitForMessage(outsider.messages, "error", (message) => (
      message.room === `workspace:${WORKSPACE}` && message.code === "FORBIDDEN"
    ));
    assert.equal(workspaceForbidden.error, "Forbidden");
    send(outsider, { type: "subscribe", room: `note:${NOTE}` });
    await waitForMessage(outsider.messages, "error", (message) => (
      message.room === `note:${NOTE}` && message.code === "FORBIDDEN"
    ));

    send(member, { type: "y:join", noteId: NOTE });
    await waitForMessage(member.messages, "error", (message) => (
      message.code === "POSTGRES_YJS_MIGRATION_PENDING"
    ));

    await realtime.publishMutation({
      kind: "note.updated",
      actorUserId: OWNER,
      actorConnectionId: owner.connectionId,
      note: {
        id: NOTE,
        workspaceId: WORKSPACE,
        notebookId: NOTEBOOK,
        version: 2,
        updatedAt: new Date().toISOString(),
        title: "Updated title",
        contentText: "Updated",
      },
    });
    const updated = await waitForMessage(member.messages, "note:updated", (message) => (
      message.noteId === NOTE && message.version === 2
    ));
    assert.equal(updated.actorConnectionId, owner.connectionId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(owner.messages.some((message) => (
      message.type === "note:updated" && message.version === 2
    )), false);

    await realtime.publishMutation({
      kind: "note.created",
      actorUserId: OWNER,
      actorConnectionId: owner.connectionId,
      note: {
        id: "pg-realtime-new-note",
        workspaceId: WORKSPACE,
        notebookId: NOTEBOOK,
        version: 1,
        updatedAt: new Date().toISOString(),
        title: "Created",
        contentText: "",
      },
    });
    const workspaceCreated = await waitForMessage(member.messages, "workspace:updated", (message) => (
      message.reason === "note.created" && message.noteId === "pg-realtime-new-note"
    ));
    assert.equal(workspaceCreated.kind, "note:created");

    await realtime.publishMutation({
      kind: "note.trashed",
      actorUserId: OWNER,
      actorConnectionId: owner.connectionId,
      note: {
        id: NOTE,
        workspaceId: WORKSPACE,
        notebookId: NOTEBOOK,
        version: 2,
        updatedAt: new Date().toISOString(),
      },
    });
    const trashed = await waitForMessage(member.messages, "note:deleted", (message) => (
      message.noteId === NOTE && message.trashed === true
    ));
    assert.equal(trashed.actorUserId, OWNER);

    await realtime.publishMutation({
      kind: "notes.reordered",
      actorUserId: OWNER,
      actorConnectionId: owner.connectionId,
      noteIds: [NOTE],
    });
    await waitForMessage(member.messages, "workspace:updated", (message) => (
      message.reason === "notes:reordered" && message.noteIds?.includes(NOTE)
    ));

    await realtime.publish({
      kind: "note.deleted",
      actorUserId: OWNER,
      noteOwnerUserId: OWNER,
      workspaceId: WORKSPACE,
      noteId: NOTE,
      attachmentCount: 0,
      removedFiles: 0,
      skippedSharedPaths: 0,
      cleanupWarnings: [],
    });
    await waitForMessage(owner.messages, "note:deleted", (message) => (
      message.noteId === NOTE && message.trashed === false
    ));
    await waitForMessage(member.messages, "note:deleted", (message) => (
      message.noteId === NOTE && message.trashed === false
    ));

    owner.ws.terminate();
    member.ws.terminate();
    outsider.ws.terminate();
    await waitForCondition(() => realtime.getStats().clients === 0);
    assert.equal(realtime.getStats().rooms, 0);

    const reconnected = await connectClient(port, MEMBER);
    sockets.push(reconnected.ws);
    send(reconnected, { type: "subscribe", room: `note:${NOTE}` });
    send(reconnected, { type: "subscribe", room: `note:${NOTE}` });
    send(reconnected, { type: "presence", noteId: NOTE, editing: false });
    await waitForMessage(reconnected.messages, "presence", (message) => (
      message.noteId === NOTE && Array.isArray(message.users) && message.users.length === 1
    ));
    assert.equal(realtime.getStats().clients, 1);
    assert.equal(realtime.getStats().rooms, 1);
    assert.equal(realtime.getStats().noteRooms, 1);
  } finally {
    for (const ws of sockets) {
      try {
        ws.terminate();
      } catch {}
    }
    await realtime.close();
    await closeServer(server);
    await closePgPool(pool);
  }
});
