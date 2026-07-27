import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { WebSocket } from "ws";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import { signLoginToken } from "../src/lib/auth-security";
import { createPostgresRealtimeRuntime } from "../src/services/postgres-realtime-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const OWNER = "pg-yws-owner";
const MEMBER = "pg-yws-member";
const OUTSIDER = "pg-yws-outsider";
const WORKSPACE = "pg-yws-workspace";
const NOTEBOOK = "pg-yws-notebook";
const NOTE = "e91f6e2c-5b41-4af0-9e6d-cc0f71b2a864";

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
  assert.ok(connected.capabilities.includes("room-subscriptions"));
  assert.ok(connected.capabilities.includes("yjs-read-sync"));
  assert.ok(connected.capabilities.includes("yjs-awareness-relay"));
  assert.deepEqual(connected.pendingCapabilities, ["yjs-update-write", "yjs-snapshot-compaction"]);
  return { ws, messages, connectionId: String(connected.connectionId) };
}

function send(client: ConnectedClient, message: Record<string, unknown>): void {
  client.ws.send(JSON.stringify(message));
}

function decodeYDoc(stateBase64: string): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(Buffer.from(stateBase64, "base64")));
  return doc;
}

async function prepareFixture(pool: import("pg").Pool): Promise<Uint8Array> {
  await initPgSchema(pool);
  await pool.query(`DELETE FROM notes WHERE id = $1`, [NOTE]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[OWNER, MEMBER, OUTSIDER]]);
  for (const userId of [OWNER, MEMBER, OUTSIDER]) {
    await pool.query(
      `INSERT INTO users (id, username, "passwordHash", "tokenVersion", "isDisabled", role)
       VALUES ($1, $1, 'hash', 0, false, 'user')`,
      [userId],
    );
  }
  await pool.query(
    `INSERT INTO workspaces (id, name, "ownerId") VALUES ($1, 'Yjs websocket', $2)`,
    [WORKSPACE, OWNER],
  );
  await pool.query(
    `INSERT INTO workspace_members ("workspaceId", "userId", role) VALUES ($1, $2, 'editor')`,
    [WORKSPACE, MEMBER],
  );
  await pool.query(
    `INSERT INTO notebooks (id, "userId", "workspaceId", name) VALUES ($1, $2, $3, 'Yjs websocket')`,
    [NOTEBOOK, OWNER, WORKSPACE],
  );
  await pool.query(
    `INSERT INTO notes (
       id, "userId", "workspaceId", "notebookId", title, content, "contentText", "contentFormat"
     ) VALUES ($1, $2, $3, $4, 'Yjs websocket', 'fallback', 'fallback', 'markdown')`,
    [NOTE, OWNER, WORKSPACE, NOTEBOOK],
  );

  const source = new Y.Doc();
  source.getText("content").insert(0, "server snapshot");
  const snapshot = Y.encodeStateAsUpdate(source);
  const snapshotVector = Y.encodeStateVector(source);
  source.getText("content").insert(source.getText("content").length, " + delta");
  const delta = Y.encodeStateAsUpdate(source, snapshotVector);
  await pool.query(
    `INSERT INTO note_ysnapshots ("noteId", snapshot_blob, "updatesMergedTo") VALUES ($1, $2, 0)`,
    [NOTE, Buffer.from(snapshot)],
  );
  await pool.query(
    `INSERT INTO note_yupdates ("noteId", "userId", update_blob, clock) VALUES ($1, $2, $3, 1)`,
    [NOTE, OWNER, Buffer.from(delta)],
  );
  return snapshot;
}

test("PostgreSQL websocket Yjs boundary supports join/sync-step1/awareness and rejects writes", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  const adapter = new PostgresAdapter(pool);
  const server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  const realtime = createPostgresRealtimeRuntime(adapter);
  const sockets: WebSocket[] = [];

  try {
    const snapshot = await prepareFixture(pool);
    realtime.attach(server);
    const port = await listen(server);

    const owner = await connectClient(port, OWNER);
    const member = await connectClient(port, MEMBER);
    const outsider = await connectClient(port, OUTSIDER);
    sockets.push(owner.ws, member.ws, outsider.ws);

    send(owner, { type: "y:join", noteId: NOTE });
    send(member, { type: "y:join", noteId: NOTE });
    send(outsider, { type: "y:join", noteId: NOTE });

    const ownerSync = await waitForMessage(owner.messages, "y:sync", (message) => message.noteId === NOTE);
    const memberSync = await waitForMessage(member.messages, "y:sync", (message) => message.noteId === NOTE);
    assert.equal(ownerSync.readOnly, true);
    assert.equal(memberSync.replayedUpdates, 1);
    assert.equal(decodeYDoc(ownerSync.state).getText("content").toString(), "server snapshot + delta");
    await waitForMessage(outsider.messages, "error", (message) => (
      message.noteId === NOTE && message.code === "FORBIDDEN"
    ));
    assert.equal(realtime.getStats().yjsRooms, 1);
    assert.equal(realtime.getStats().yjsConnections, 2);

    const partial = new Y.Doc();
    Y.applyUpdate(partial, snapshot);
    send(owner, {
      type: "y:sync-step1",
      noteId: NOTE,
      stateVector: Buffer.from(Y.encodeStateVector(partial)).toString("base64"),
    });
    const step2 = await waitForMessage(owner.messages, "y:sync-step2", (message) => message.noteId === NOTE);
    Y.applyUpdate(partial, new Uint8Array(Buffer.from(step2.update, "base64")));
    assert.equal(partial.getText("content").toString(), "server snapshot + delta");

    const awarenessDoc = new Y.Doc();
    const awareness = new Awareness(awarenessDoc);
    awareness.setLocalState({ user: { id: MEMBER, name: MEMBER } });
    const awarenessBase64 = Buffer.from(
      encodeAwarenessUpdate(awareness, [awareness.clientID]),
    ).toString("base64");
    send(member, { type: "y:awareness", noteId: NOTE, update: awarenessBase64 });
    const relayed = await waitForMessage(owner.messages, "y:awareness", (message) => (
      message.noteId === NOTE && message.actorConnectionId === member.connectionId
    ));
    assert.equal(relayed.update, awarenessBase64);
    assert.equal(relayed.actorUserId, MEMBER);

    const beforeWrites = Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM note_yupdates WHERE "noteId" = $1`,
      [NOTE],
    )).rows[0].count);
    send(member, {
      type: "y:update",
      noteId: NOTE,
      update: Buffer.from([1, 2, 3]).toString("base64"),
    });
    await waitForMessage(member.messages, "error", (message) => (
      message.noteId === NOTE && message.code === "POSTGRES_YJS_WRITE_PENDING"
    ));
    const afterWrites = Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM note_yupdates WHERE "noteId" = $1`,
      [NOTE],
    )).rows[0].count);
    assert.equal(afterWrites, beforeWrites);

    send(member, { type: "y:leave", noteId: NOTE });
    await waitForCondition(() => realtime.getStats().yjsConnections === 1);
    send(member, { type: "y:awareness", noteId: NOTE, update: awarenessBase64 });
    await waitForMessage(member.messages, "error", (message) => (
      message.noteId === NOTE && message.code === "YJS_NOT_JOINED"
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
        title: "Updated",
        contentText: "server snapshot + delta",
      },
    });
    await waitForMessage(member.messages, "note:updated", (message) => (
      message.noteId === NOTE && message.version === 2
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
    assert.equal(realtime.getStats().yjsRooms, 0);
    assert.equal(realtime.getStats().yjsConnections, 0);
    await waitForMessage(member.messages, "note:deleted", (message) => (
      message.noteId === NOTE && message.trashed === false
    ));

    owner.ws.terminate();
    member.ws.terminate();
    outsider.ws.terminate();
    await waitForCondition(() => realtime.getStats().clients === 0);
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
