import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test from "node:test";

import { WebSocket } from "ws";

import { PostgresAdapter } from "../src/db/postgresAdapter";
import { signLoginToken } from "../src/lib/auth-security";
import { createPostgresRealtimeRuntime } from "../src/services/postgres-realtime-runtime";
import {
  createPostgresYjsSubdocumentContentUpdate,
} from "../src/services/postgres-yjs-subdocuments-runtime";
import {
  createPostgresYjsSubdocumentWebsocketRuntime,
} from "../src/services/postgres-yjs-subdocuments-websocket-runtime";
import { closePgPool, getPgPool, hasPg, initPgSchema } from "./helpers/pg-test-db";

const OWNER = "pg-subdoc-ws-owner";
const MEMBER = "pg-subdoc-ws-member";
const VIEWER = "pg-subdoc-ws-viewer";
const OUTSIDER = "pg-subdoc-ws-outsider";
const WORKSPACE = "pg-subdoc-ws-workspace";
const NOTEBOOK = "pg-subdoc-ws-notebook";
const NOTE = "f7777777-7777-4777-8777-777777777777";

interface ConnectedClient {
  ws: WebSocket;
  messages: Array<Record<string, any>>;
  connectionId: string;
}

function text(value: string) {
  return { type: "text", text: value };
}

function heading(blockId: string, value: string, level = 2) {
  return {
    type: "heading",
    attrs: { level, blockId },
    content: [text(value)],
  };
}

function paragraph(blockId: string, value: string) {
  return {
    type: "paragraph",
    attrs: { blockId },
    content: [text(value)],
  };
}

function documentContent(secondParagraph = "Beta"): string {
  return JSON.stringify({
    type: "doc",
    content: [
      heading("blk_ws_heading_one", "One", 1),
      paragraph("blk_ws_paragraph_one", "Alpha"),
      heading("blk_ws_heading_two", "Two", 2),
      paragraph("blk_ws_paragraph_two", secondParagraph),
    ],
  });
}

function secondSectionContent(secondParagraph = "Beta"): string {
  return JSON.stringify({
    type: "doc",
    content: [
      heading("blk_ws_heading_two", "Two", 2),
      paragraph("blk_ws_paragraph_two", secondParagraph),
    ],
  });
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

async function connectClient(port: number, userId: string, path: string): Promise<ConnectedClient> {
  const token = signLoginToken({ userId, username: userId, tokenVersion: 0 });
  const messages: Array<Record<string, any>> = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}?token=${encodeURIComponent(token)}`);
  ws.on("message", (data) => {
    messages.push(JSON.parse(data.toString()) as Record<string, any>);
  });
  await once(ws, "open");
  const connected = await waitForMessage(messages, "connected");
  return { ws, messages, connectionId: String(connected.connectionId) };
}

function send(client: ConnectedClient, message: Record<string, unknown>): void {
  client.ws.send(JSON.stringify(message));
}

async function prepareFixture(pool: import("pg").Pool): Promise<void> {
  await initPgSchema(pool);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[OWNER, MEMBER, VIEWER, OUTSIDER]]);
  for (const userId of [OWNER, MEMBER, VIEWER, OUTSIDER]) {
    await pool.query(
      `INSERT INTO users (id, username, "passwordHash", "tokenVersion", "isDisabled", role)
       VALUES ($1, $1, 'hash', 0, false, 'user')`,
      [userId],
    );
  }
  await pool.query(
    `INSERT INTO workspaces (id, name, "ownerId") VALUES ($1, 'Subdocument websocket', $2)`,
    [WORKSPACE, OWNER],
  );
  await pool.query(
    `INSERT INTO workspace_members ("workspaceId", "userId", role) VALUES ($1, $2, 'editor')`,
    [WORKSPACE, MEMBER],
  );
  await pool.query(
    `INSERT INTO workspace_members ("workspaceId", "userId", role) VALUES ($1, $2, 'viewer')`,
    [WORKSPACE, VIEWER],
  );
  await pool.query(
    `INSERT INTO notebooks (id, "userId", "workspaceId", name)
     VALUES ($1, $2, $3, 'Subdocument websocket')`,
    [NOTEBOOK, OWNER, WORKSPACE],
  );
  await pool.query(
    `INSERT INTO notes (
       id, "userId", "workspaceId", "notebookId", title, content, "contentText", "contentFormat", version
     ) VALUES ($1, $2, $3, $4, 'Subdocument websocket', $5, 'One Alpha Two Beta', 'tiptap-json', 1)`,
    [NOTE, OWNER, WORKSPACE, NOTEBOOK, documentContent()],
  );
}

test("PostgreSQL subdocument websocket joins, relays stable-section writes and fails closed", { skip: !hasPg }, async () => {
  const pool = await getPgPool();
  assert.ok(pool);
  await prepareFixture(pool);
  const adapter = new PostgresAdapter(pool);
  const server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  const hub = createPostgresRealtimeRuntime(adapter);
  const subdocuments = createPostgresYjsSubdocumentWebsocketRuntime(adapter, {
    publishMutation: hub.publishMutation,
    heartbeatIntervalMs: 50,
    clientTimeoutMs: 2_000,
  });
  const sockets: WebSocket[] = [];

  try {
    hub.attach(server);
    subdocuments.attach(server);
    const port = await listen(server);

    const normal = await connectClient(port, OWNER, "/ws");
    assert.ok((await waitForMessage(normal.messages, "connected")).capabilities.includes("yjs-read-sync"));

    const owner = await connectClient(port, OWNER, "/ws/subdocuments");
    const member = await connectClient(port, MEMBER, "/ws/subdocuments");
    const viewer = await connectClient(port, VIEWER, "/ws/subdocuments");
    const outsider = await connectClient(port, OUTSIDER, "/ws/subdocuments");
    sockets.push(normal.ws, owner.ws, member.ws, viewer.ws, outsider.ws);

    for (const client of [owner, member, viewer]) send(client, { type: "y:subdoc:join", noteId: NOTE });
    send(outsider, { type: "y:subdoc:join", noteId: NOTE });

    const ownerManifest = await waitForMessage(owner.messages, "y:subdoc:state", (message) => (
      message.noteId === NOTE && message.section === null
    ));
    const memberManifest = await waitForMessage(member.messages, "y:subdoc:state", (message) => (
      message.noteId === NOTE && message.section === null
    ));
    const viewerManifest = await waitForMessage(viewer.messages, "y:subdoc:state", (message) => (
      message.noteId === NOTE && message.section === null
    ));
    assert.equal(ownerManifest.readOnly, false);
    assert.equal(memberManifest.readOnly, false);
    assert.equal(viewerManifest.readOnly, true);
    assert.equal(ownerManifest.manifest.sections.length, 2);
    await waitForMessage(outsider.messages, "error", (message) => (
      message.noteId === NOTE && message.code === "FORBIDDEN"
    ));

    const target = ownerManifest.manifest.sections[1];
    assert.ok(target?.id);
    for (const client of [owner, member, viewer]) {
      send(client, { type: "y:subdoc:state", noteId: NOTE, sectionId: target.id });
    }

    const ownerState = await waitForMessage(owner.messages, "y:subdoc:state", (message) => (
      message.noteId === NOTE && message.section?.id === target.id
    ));
    const memberState = await waitForMessage(member.messages, "y:subdoc:state", (message) => (
      message.noteId === NOTE && message.section?.id === target.id
    ));
    const viewerState = await waitForMessage(viewer.messages, "y:subdoc:state", (message) => (
      message.noteId === NOTE && message.section?.id === target.id
    ));
    assert.equal(ownerState.readOnly, false);
    assert.equal(memberState.readOnly, false);
    assert.equal(viewerState.readOnly, true);

    const updateBytes = createPostgresYjsSubdocumentContentUpdate(
      String(memberState.section.guid),
      new Uint8Array(Buffer.from(String(memberState.section.state), "base64")),
      secondSectionContent("Beta websocket"),
    );
    const update = Buffer.from(updateBytes).toString("base64");
    const generation = Number(memberManifest.manifest.generation);

    send(member, {
      type: "y:subdoc:update",
      noteId: NOTE,
      sectionId: target.id,
      generation,
      update,
    });
    const ack = await waitForMessage(member.messages, "y:subdoc:update-ack", (message) => (
      message.noteId === NOTE && message.sectionId === target.id
    ));
    assert.equal(ack.version, 2);
    assert.equal(ack.generation, generation);
    const relayed = await waitForMessage(owner.messages, "y:subdoc:update", (message) => (
      message.noteId === NOTE && message.sectionId === target.id
    ));
    assert.equal(relayed.update, update);
    assert.equal(relayed.actorUserId, MEMBER);
    await waitForMessage(viewer.messages, "y:subdoc:update", (message) => (
      message.noteId === NOTE && message.sectionId === target.id
    ));

    const persisted = (await pool.query(
      `SELECT content, "contentText", version FROM notes WHERE id = $1`,
      [NOTE],
    )).rows[0];
    assert.equal(persisted.content, documentContent("Beta websocket"));
    assert.match(persisted.contentText, /Beta websocket/u);
    assert.equal(Number(persisted.version), 2);
    assert.equal(Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM note_y_subdocument_updates WHERE "noteId" = $1`,
      [NOTE],
    )).rows[0].count), 1);

    send(viewer, {
      type: "y:subdoc:update",
      noteId: NOTE,
      sectionId: target.id,
      generation,
      update,
    });
    await waitForMessage(viewer.messages, "error", (message) => (
      message.noteId === NOTE && message.code === "FORBIDDEN"
    ));

    send(member, {
      type: "y:subdoc:update",
      noteId: NOTE,
      sectionId: target.id,
      generation,
      update: "***",
    });
    await waitForMessage(member.messages, "error", (message) => (
      message.noteId === NOTE && message.code === "SUBDOCUMENT_INVALID_UPDATE"
    ));

    send(member, {
      type: "y:subdoc:update",
      noteId: NOTE,
      sectionId: target.id,
      generation: generation + 1,
      update,
    });
    await waitForMessage(member.messages, "y:subdoc:reload", (message) => message.noteId === NOTE);
    await waitForMessage(owner.messages, "y:subdoc:reload", (message) => message.noteId === NOTE);
    await waitForMessage(member.messages, "error", (message) => (
      message.noteId === NOTE && message.code === "SUBDOCUMENT_GENERATION_CONFLICT"
    ));

    send(member, {
      type: "y:subdoc:update",
      noteId: NOTE,
      sectionId: target.id,
      generation,
      update,
    });
    await waitForMessage(member.messages, "error", (message) => (
      message.noteId === NOTE && message.code === "SUBDOCUMENT_NOT_JOINED"
    ));

    const stats = subdocuments.getStats();
    assert.equal(stats.updates, 1);
    assert.equal(stats.invalidations, 1);
    assert.equal(stats.sectionRooms, 0);
  } finally {
    for (const socket of sockets) {
      try {
        socket.close();
      } catch {}
    }
    await subdocuments.close();
    await hub.close();
    await closeServer(server);
    await closePgPool(pool);
  }
});
