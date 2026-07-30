import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import { URL } from "node:url";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import type { DatabaseAdapter } from "../db/adapters/types";
import { verifyLoginToken } from "../lib/auth-security";
import { createNoteCoreRuntime } from "./note-core-runtime";
import type { NoteDeletionCommittedEvent } from "./note-deletion-effects-runtime";
import {
  createPostgresYjsReadRuntime,
  PostgresYjsReadRuntimeError,
} from "./postgres-yjs-read-runtime";

interface RuntimeUserRow {
  id: string;
  username: string;
  role: string;
  tokenVersion: number;
  isDisabled: boolean | number;
}

interface RuntimeSessionRow {
  revokedAt: string | Date | null;
  expiresAt: string | Date | null;
}

interface WorkspaceOwnerRow {
  ownerId: string;
}

interface NoteWorkspaceRow {
  workspaceId: string | null;
  ownerId: string | null;
}

interface ClientInfo {
  userId: string;
  username: string;
  role: string;
  connectionId: string;
  activeNoteId: string | null;
  editing: boolean;
  lastSeen: number;
  rooms: Set<string>;
  yRooms: Set<string>;
}

interface RuntimeClient {
  ws: WebSocket;
  info: ClientInfo;
}

interface ClientMessage {
  type?: string;
  room?: string;
  noteId?: string | null;
  editing?: boolean;
  cursor?: { line?: number; ch?: number; selection?: string };
  update?: string;
  stateVector?: string;
}

export interface RealtimeNoteSnapshot {
  id: string;
  workspaceId: string | null;
  version: number;
  updatedAt: string;
  title?: string;
  contentText?: string;
  notebookId?: string;
}

export type NoteRuntimeMutationEvent =
  | {
      kind: "note.created" | "note.updated" | "note.trashed" | "note.restored" | "note.moved";
      actorUserId: string;
      actorConnectionId?: string | null;
      note: RealtimeNoteSnapshot;
    }
  | {
      kind: "notes.reordered";
      actorUserId: string;
      actorConnectionId?: string | null;
      noteIds: string[];
    };

export interface PostgresRealtimeRuntime {
  attach(server: Server): void;
  publish(event: NoteDeletionCommittedEvent): Promise<void>;
  publishMutation(event: NoteRuntimeMutationEvent): Promise<void>;
  publishToUser(
    userId: string,
    message: Record<string, unknown>,
    excludeConnectionId?: string | null,
  ): void;
  close(): Promise<void>;
  getStats(): {
    clients: number;
    users: number;
    rooms: number;
    noteRooms: number;
    workspaceRooms: number;
    yjsRooms: number;
    yjsConnections: number;
    yjsLoadingRooms: number;
    yjsWritingRooms: number;
    yjsSeededRooms: number;
    yjsReplayedUpdates: number;
    attached: boolean;
  };
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const CLIENT_TIMEOUT_MS = 60_000;
const MAX_ROOM_ID_LENGTH = 200;

function isDisabled(value: boolean | number): boolean {
  return value === true || value === 1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rejectUpgrade(socket: any, status = "401 Unauthorized"): void {
  try {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  } catch {}
  try {
    socket.destroy();
  } catch {}
}

export function createPostgresRealtimeRuntime(
  adapter: DatabaseAdapter,
): PostgresRealtimeRuntime {
  const noteCore = createNoteCoreRuntime(adapter, "postgres");
  const yjs = createPostgresYjsReadRuntime(adapter);
  const clients = new Map<string, RuntimeClient>();
  const clientsByUser = new Map<string, Set<string>>();
  const rooms = new Map<string, Set<string>>();
  let server: Server | null = null;
  let wss: WebSocketServer | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;

  function send(ws: WebSocket, message: Record<string, unknown>): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(message));
    } catch (error) {
      console.warn("[postgres-realtime-runtime] send failed:", errorMessage(error));
    }
  }

  function sendRuntimeError(
    client: RuntimeClient,
    error: unknown,
    noteId?: string | null,
  ): void {
    if (error instanceof PostgresYjsReadRuntimeError) {
      send(client.ws, {
        type: "error",
        noteId: noteId || null,
        code: error.code,
        error: error.message,
        details: error.details,
      });
      return;
    }
    send(client.ws, {
      type: "error",
      noteId: noteId || null,
      code: "YJS_READ_SYNC_FAILED",
      error: "PostgreSQL Yjs read sync failed",
    });
  }

  function addClient(client: RuntimeClient): void {
    clients.set(client.info.connectionId, client);
    const connections = clientsByUser.get(client.info.userId) ?? new Set<string>();
    connections.add(client.info.connectionId);
    clientsByUser.set(client.info.userId, connections);
  }

  function removeClientIndex(info: ClientInfo): void {
    clients.delete(info.connectionId);
    const connections = clientsByUser.get(info.userId);
    if (!connections) return;
    connections.delete(info.connectionId);
    if (connections.size === 0) clientsByUser.delete(info.userId);
  }

  function joinRoom(connectionId: string, room: string): void {
    const client = clients.get(connectionId);
    if (!client || client.info.rooms.has(room)) return;
    const members = rooms.get(room) ?? new Set<string>();
    members.add(connectionId);
    rooms.set(room, members);
    client.info.rooms.add(room);
  }

  function leaveRoom(connectionId: string, room: string): void {
    const members = rooms.get(room);
    members?.delete(connectionId);
    if (members?.size === 0) rooms.delete(room);
    clients.get(connectionId)?.info.rooms.delete(room);
  }

  function collectRoomTargets(room: string, target: Set<string>): void {
    for (const connectionId of rooms.get(room) ?? []) target.add(connectionId);
  }

  function collectUserTargets(userId: string, target: Set<string>): void {
    for (const connectionId of clientsByUser.get(userId) ?? []) target.add(connectionId);
  }

  function sendTargets(
    target: Set<string>,
    message: Record<string, unknown>,
    excludeConnectionId?: string | null,
  ): void {
    for (const connectionId of target) {
      if (excludeConnectionId && connectionId === excludeConnectionId) continue;
      const client = clients.get(connectionId);
      if (client) send(client.ws, message);
    }
  }

  function broadcastRoom(
    room: string,
    message: Record<string, unknown>,
    excludeConnectionId?: string | null,
  ): void {
    const target = new Set<string>();
    collectRoomTargets(room, target);
    sendTargets(target, message, excludeConnectionId);
  }

  function broadcastYRoom(
    noteId: string,
    message: Record<string, unknown>,
    excludeConnectionId?: string | null,
  ): void {
    sendTargets(new Set(yjs.getMembers(noteId)), message, excludeConnectionId);
  }

  function publishToUser(
    userId: string,
    message: Record<string, unknown>,
    excludeConnectionId?: string | null,
  ): void {
    const target = new Set<string>();
    collectUserTargets(userId, target);
    sendTargets(target, message, excludeConnectionId);
  }

  function presenceUsers(noteId: string) {
    const result: Array<{
      userId: string;
      username: string;
      connectionId: string;
      editing: boolean;
    }> = [];
    for (const connectionId of rooms.get(`note:${noteId}`) ?? []) {
      const client = clients.get(connectionId);
      if (!client || client.info.activeNoteId !== noteId) continue;
      result.push({
        userId: client.info.userId,
        username: client.info.username,
        connectionId,
        editing: client.info.editing,
      });
    }
    return result;
  }

  function broadcastPresence(noteId: string): void {
    broadcastRoom(`note:${noteId}`, {
      type: "presence",
      noteId,
      users: presenceUsers(noteId),
    });
  }

  async function authenticate(token: string): Promise<RuntimeUserRow | null> {
    const payload = verifyLoginToken(token);
    if (!payload?.userId) return null;
    const user = await adapter.queryOne<RuntimeUserRow>(
      `SELECT id, username, role, "tokenVersion" AS "tokenVersion", "isDisabled" AS "isDisabled"
         FROM users WHERE id = ?`,
      [payload.userId],
    );
    if (!user || isDisabled(user.isDisabled)) return null;
    if ((payload.tver ?? 0) !== (user.tokenVersion ?? 0)) return null;

    if (payload.jti) {
      const session = await adapter.queryOne<RuntimeSessionRow>(
        `SELECT "revokedAt" AS "revokedAt", "expiresAt" AS "expiresAt"
           FROM user_sessions WHERE id = ? AND "userId" = ?`,
        [payload.jti, payload.userId],
      );
      if (!session || session.revokedAt) return null;
      if (session.expiresAt && new Date(session.expiresAt).getTime() <= Date.now()) return null;
    }
    return user;
  }

  async function canJoinWorkspaceRoom(
    workspaceId: string,
    info: Pick<ClientInfo, "userId" | "role">,
  ): Promise<boolean> {
    const workspace = await adapter.queryOne<WorkspaceOwnerRow>(
      `SELECT "ownerId" AS "ownerId" FROM workspaces WHERE id = ?`,
      [workspaceId],
    );
    if (!workspace) return false;
    if (info.role === "admin" || workspace.ownerId === info.userId) return true;
    return Boolean(await adapter.queryOne<{ present: number }>(
      `SELECT 1 AS present FROM workspace_members WHERE "workspaceId" = ? AND "userId" = ?`,
      [workspaceId, info.userId],
    ));
  }

  async function canJoinNoteRoom(
    noteId: string,
    info: Pick<ClientInfo, "userId" | "role">,
  ): Promise<boolean> {
    const note = await adapter.queryOne<NoteWorkspaceRow>(
      `SELECT n."workspaceId" AS "workspaceId", w."ownerId" AS "ownerId"
         FROM notes n
         LEFT JOIN workspaces w ON w.id = n."workspaceId"
        WHERE n.id = ?`,
      [noteId],
    );
    if (!note) return false;
    if (info.role === "admin" || note.ownerId === info.userId) return true;
    const resolved = await noteCore.resolveNotePermissionAsync(noteId, info.userId);
    return resolved.permission !== null;
  }

  async function canWriteNote(
    noteId: string,
    info: Pick<ClientInfo, "userId" | "role">,
  ): Promise<boolean> {
    if (info.role === "admin") return true;
    const resolved = await noteCore.resolveNotePermissionAsync(noteId, info.userId);
    return resolved.permission === "write" || resolved.permission === "manage";
  }

  function roomError(client: RuntimeClient, room: string, code: string, error: string): void {
    send(client.ws, { type: "error", room, code, error });
  }

  async function subscribe(connectionId: string, room: string): Promise<void> {
    const client = clients.get(connectionId);
    if (!client) return;
    if (!room || room.length > MAX_ROOM_ID_LENGTH) {
      roomError(client, room, "INVALID_ROOM", "Invalid room");
      return;
    }

    if (room.startsWith("note:")) {
      const noteId = room.slice(5);
      if (!noteId || !(await canJoinNoteRoom(noteId, client.info))) {
        roomError(client, room, "FORBIDDEN", "Forbidden");
        return;
      }
      joinRoom(connectionId, room);
      broadcastPresence(noteId);
      return;
    }

    if (room.startsWith("workspace:")) {
      const workspaceId = room.slice(10);
      if (!workspaceId || !(await canJoinWorkspaceRoom(workspaceId, client.info))) {
        roomError(client, room, "FORBIDDEN", "Forbidden");
        return;
      }
      joinRoom(connectionId, room);
      return;
    }

    roomError(client, room, "UNKNOWN_ROOM", "Unknown room type");
  }

  async function setPresence(client: RuntimeClient, noteId: string | null, editing: boolean): Promise<void> {
    const previous = client.info.activeNoteId;
    if (!noteId) {
      client.info.activeNoteId = null;
      client.info.editing = false;
      if (previous) broadcastPresence(previous);
      return;
    }
    if (!(await canJoinNoteRoom(noteId, client.info))) {
      send(client.ws, { type: "error", noteId, code: "FORBIDDEN", error: "Forbidden" });
      return;
    }
    joinRoom(client.info.connectionId, `note:${noteId}`);
    client.info.activeNoteId = noteId;
    client.info.editing = editing;
    if (previous && previous !== noteId) broadcastPresence(previous);
    broadcastPresence(noteId);
  }

  async function handleYjsMessage(client: RuntimeClient, message: ClientMessage): Promise<boolean> {
    const connectionId = client.info.connectionId;
    const noteId = typeof message.noteId === "string" ? message.noteId : "";

    if (message.type === "y:join") {
      if (!noteId) {
        send(client.ws, { type: "error", code: "YJS_NOTE_ID_REQUIRED", error: "Missing noteId" });
        return true;
      }
      if (!(await canJoinNoteRoom(noteId, client.info))) {
        send(client.ws, { type: "error", noteId, code: "FORBIDDEN", error: "Forbidden" });
        return true;
      }
      const writable = await canWriteNote(noteId, client.info);
      try {
        const result = await yjs.join(noteId, connectionId);
        const current = clients.get(connectionId);
        if (!current) {
          yjs.leave(noteId, connectionId);
          return true;
        }
        current.info.yRooms.add(noteId);
        joinRoom(connectionId, `note:${noteId}`);
        send(current.ws, {
          type: "y:sync",
          noteId,
          state: result.stateBase64,
          source: result.source,
          replayedUpdates: result.replayedUpdates,
          warnings: result.warnings,
          readOnly: !writable,
        });
      } catch (error) {
        sendRuntimeError(client, error, noteId);
      }
      return true;
    }

    if (message.type === "y:leave") {
      if (!noteId) return true;
      client.info.yRooms.delete(noteId);
      yjs.leave(noteId, connectionId);
      return true;
    }

    if (message.type === "y:sync-step1") {
      if (!noteId || !message.stateVector) {
        send(client.ws, {
          type: "error",
          noteId: noteId || null,
          code: "YJS_STATE_VECTOR_REQUIRED",
          error: "Missing stateVector",
        });
        return true;
      }
      try {
        const update = yjs.syncStep1(noteId, connectionId, message.stateVector);
        const writable = await canWriteNote(noteId, client.info);
        send(client.ws, { type: "y:sync-step2", noteId, update, readOnly: !writable });
      } catch (error) {
        sendRuntimeError(client, error, noteId);
      }
      return true;
    }

    if (message.type === "y:awareness") {
      if (!noteId || !message.update) return true;
      try {
        const update = yjs.validateAwareness(noteId, connectionId, message.update);
        broadcastYRoom(noteId, {
          type: "y:awareness",
          noteId,
          update,
          actorConnectionId: connectionId,
          actorUserId: client.info.userId,
        }, connectionId);
      } catch (error) {
        sendRuntimeError(client, error, noteId);
      }
      return true;
    }

    if (message.type === "y:update") {
      if (!noteId) return true;
      if (!message.update) {
        send(client.ws, { type: "error", noteId, code: "YJS_UPDATE_REQUIRED", error: "Missing update" });
        return true;
      }
      if (!yjs.hasJoined(noteId, connectionId)) {
        send(client.ws, { type: "error", noteId, code: "YJS_NOT_JOINED", error: "Yjs room has not been joined" });
        return true;
      }
      if (!(await canWriteNote(noteId, client.info))) {
        send(client.ws, { type: "error", noteId, code: "FORBIDDEN", error: "Write permission required" });
        return true;
      }
      try {
        const persisted = await yjs.applyUpdate(
          noteId,
          connectionId,
          client.info.userId,
          message.update,
        );
        broadcastYRoom(noteId, {
          type: "y:update",
          noteId,
          update: persisted.updateBase64,
          version: persisted.version,
          updatedAt: persisted.updatedAt,
          actorConnectionId: connectionId,
          actorUserId: client.info.userId,
        }, connectionId);
        send(client.ws, {
          type: "y:update-ack",
          noteId,
          version: persisted.version,
          updatedAt: persisted.updatedAt,
        });
        await publishMutation({
          kind: "note.updated",
          actorUserId: client.info.userId,
          actorConnectionId: connectionId,
          note: {
            id: noteId,
            workspaceId: persisted.workspaceId,
            notebookId: persisted.notebookId,
            version: persisted.version,
            updatedAt: persisted.updatedAt,
            title: persisted.title,
            contentText: persisted.contentText,
          },
        });
      } catch (error) {
        if (error instanceof PostgresYjsReadRuntimeError && error.code === "YJS_WRITE_CONFLICT") {
          for (const current of clients.values()) current.info.yRooms.delete(noteId);
        }
        sendRuntimeError(client, error, noteId);
      }
      return true;
    }

    if (message.type?.startsWith("y:")) {
      send(client.ws, {
        type: "error",
        noteId: noteId || null,
        code: "POSTGRES_YJS_MESSAGE_PENDING",
        error: "This PostgreSQL Yjs message is not migrated yet",
      });
      return true;
    }

    return false;
  }

  async function handleMessage(connectionId: string, data: RawData): Promise<void> {
    const client = clients.get(connectionId);
    if (!client) return;
    client.info.lastSeen = Date.now();

    let message: ClientMessage;
    try {
      message = JSON.parse(data.toString()) as ClientMessage;
    } catch {
      send(client.ws, { type: "error", code: "INVALID_JSON", error: "Invalid JSON" });
      return;
    }

    if (message.type === "ping") {
      send(client.ws, { type: "pong", t: Date.now() });
      return;
    }
    if (await handleYjsMessage(client, message)) return;
    if (message.type === "subscribe") {
      await subscribe(connectionId, String(message.room || ""));
      return;
    }
    if (message.type === "unsubscribe") {
      const room = String(message.room || "");
      if (!room) return;
      leaveRoom(connectionId, room);
      if (room.startsWith("note:")) {
        const noteId = room.slice(5);
        if (client.info.activeNoteId === noteId) {
          client.info.activeNoteId = null;
          client.info.editing = false;
        }
        broadcastPresence(noteId);
      }
      return;
    }
    if (message.type === "presence") {
      const noteId = typeof message.noteId === "string" && message.noteId ? message.noteId : null;
      await setPresence(client, noteId, Boolean(message.editing));
      return;
    }
    if (message.type === "editing") {
      const noteId = typeof message.noteId === "string" && message.noteId
        ? message.noteId
        : client.info.activeNoteId;
      if (!noteId || client.info.activeNoteId !== noteId || !client.info.rooms.has(`note:${noteId}`)) {
        send(client.ws, { type: "error", noteId, code: "NOT_SUBSCRIBED", error: "Not subscribed" });
        return;
      }
      client.info.editing = Boolean(message.editing);
      broadcastPresence(noteId);
      return;
    }
    if (message.type === "cursor") {
      const noteId = typeof message.noteId === "string" && message.noteId
        ? message.noteId
        : client.info.activeNoteId;
      if (!noteId || client.info.activeNoteId !== noteId || !client.info.rooms.has(`note:${noteId}`)) return;
      broadcastRoom(`note:${noteId}`, {
        type: "presence",
        noteId,
        cursorUpdate: {
          userId: client.info.userId,
          username: client.info.username,
          connectionId,
          cursor: message.cursor || null,
        },
      }, connectionId);
      return;
    }
    send(client.ws, {
      type: "error",
      code: "UNKNOWN_MESSAGE_TYPE",
      error: "Unknown message type",
    });
  }

  function cleanupClient(connectionId: string): void {
    const client = clients.get(connectionId);
    if (!client) return;
    const previous = client.info.activeNoteId;
    yjs.closeConnection(connectionId);
    client.info.yRooms.clear();
    for (const room of Array.from(client.info.rooms)) leaveRoom(connectionId, room);
    removeClientIndex(client.info);
    if (previous) broadcastPresence(previous);
  }

  const upgradeHandler = async (req: IncomingMessage, socket: any, head: Buffer) => {
    try {
      if (!req.url) return rejectUpgrade(socket, "400 Bad Request");
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (url.pathname !== "/ws") return rejectUpgrade(socket, "404 Not Found");
      const token = url.searchParams.get("token");
      if (!token) return rejectUpgrade(socket);
      const user = await authenticate(token);
      if (!user || !wss) return rejectUpgrade(socket);

      wss.handleUpgrade(req, socket, head, (ws) => {
        const info: ClientInfo = {
          userId: user.id,
          username: user.username,
          role: user.role,
          connectionId: randomUUID(),
          activeNoteId: null,
          editing: false,
          lastSeen: Date.now(),
          rooms: new Set<string>(),
          yRooms: new Set<string>(),
        };
        addClient({ ws, info });
        send(ws, {
          type: "connected",
          connectionId: info.connectionId,
          userId: info.userId,
          username: info.username,
          capabilities: [
            "room-subscriptions",
            "note-presence",
            "cursor-events",
            "note-mutation-events",
            "workspace-events",
            "yjs-read-sync",
            "yjs-awareness-relay",
            "yjs-update-write",
          ],
          pendingCapabilities: ["yjs-snapshot-compaction"],
        });
        ws.on("message", (raw) => {
          void handleMessage(info.connectionId, raw).catch((error) => {
            console.warn("[postgres-realtime-runtime] message failed:", errorMessage(error));
            send(ws, { type: "error", code: "REALTIME_FAILED", error: "Realtime message failed" });
          });
        });
        ws.on("close", () => cleanupClient(info.connectionId));
        ws.on("error", () => cleanupClient(info.connectionId));
      });
    } catch (error) {
      console.warn("[postgres-realtime-runtime] upgrade failed:", errorMessage(error));
      rejectUpgrade(socket);
    }
  };

  function attach(target: Server): void {
    if (server) return;
    server = target;
    wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", upgradeHandler);
    heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const [connectionId, client] of clients) {
        if (now - client.info.lastSeen > CLIENT_TIMEOUT_MS) {
          try {
            client.ws.terminate();
          } catch {}
          cleanupClient(connectionId);
        } else {
          send(client.ws, { type: "pong", t: now });
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();
    console.log("[postgres-realtime-runtime] room, presence and Yjs read/write hub attached at /ws");
  }

  async function workspaceRecipients(workspaceId: string): Promise<Set<string>> {
    const recipients = new Set<string>();
    const workspace = await adapter.queryOne<WorkspaceOwnerRow>(
      `SELECT "ownerId" AS "ownerId" FROM workspaces WHERE id = ?`,
      [workspaceId],
    );
    if (workspace?.ownerId) recipients.add(workspace.ownerId);
    const members = await adapter.queryMany<{ userId: string }>(
      `SELECT "userId" AS "userId" FROM workspace_members WHERE "workspaceId" = ?`,
      [workspaceId],
    );
    for (const member of members) recipients.add(member.userId);
    return recipients;
  }

  async function publish(event: NoteDeletionCommittedEvent): Promise<void> {
    const target = new Set<string>();
    collectUserTargets(event.actorUserId, target);
    if (event.workspaceId) {
      collectRoomTargets(`workspace:${event.workspaceId}`, target);
      for (const userId of await workspaceRecipients(event.workspaceId)) collectUserTargets(userId, target);
    }

    if (event.kind === "note.deleted") {
      collectRoomTargets(`note:${event.noteId}`, target);
      yjs.destroyNote(event.noteId);
      for (const client of clients.values()) client.info.yRooms.delete(event.noteId);
      sendTargets(target, {
        type: "note:deleted",
        noteId: event.noteId,
        actorConnectionId: null,
        actorUserId: event.actorUserId,
        workspaceId: event.workspaceId,
        trashed: false,
      });
      return;
    }

    for (const noteId of event.noteIds) {
      yjs.destroyNote(noteId);
      for (const client of clients.values()) client.info.yRooms.delete(noteId);
    }
    sendTargets(target, {
      type: "notes:deleted",
      noteIds: event.noteIds,
      actorUserId: event.actorUserId,
      workspaceId: event.workspaceId,
      trashed: false,
    });
  }

  async function publishMutation(event: NoteRuntimeMutationEvent): Promise<void> {
    const actorConnectionId = event.actorConnectionId || null;
    if (event.kind === "notes.reordered") {
      const noteIds = [...new Set(event.noteIds.filter(Boolean))];
      publishToUser(event.actorUserId, {
        type: "note:list-updated",
        reason: "reordered",
        noteIds,
        actorUserId: event.actorUserId,
        actorConnectionId,
      }, actorConnectionId);
      if (noteIds.length === 0) return;
      const placeholders = noteIds.map(() => "?").join(",");
      const scopes = await adapter.queryMany<{ workspaceId: string | null }>(
        `SELECT DISTINCT "workspaceId" AS "workspaceId" FROM notes WHERE id IN (${placeholders})`,
        noteIds,
      );
      for (const scope of scopes) {
        if (!scope.workspaceId) continue;
        broadcastRoom(`workspace:${scope.workspaceId}`, {
          type: "workspace:updated",
          workspaceId: scope.workspaceId,
          kind: "notebook:updated",
          reason: "notes:reordered",
          noteIds,
          actorUserId: event.actorUserId,
          actorConnectionId,
        }, actorConnectionId);
      }
      return;
    }

    const note = event.note;
    const common = {
      noteId: note.id,
      workspaceId: note.workspaceId,
      actorUserId: event.actorUserId,
      actorConnectionId,
    };
    const target = new Set<string>();
    collectRoomTargets(`note:${note.id}`, target);
    collectUserTargets(event.actorUserId, target);

    if (event.kind === "note.trashed") {
      sendTargets(target, { type: "note:deleted", ...common, trashed: true }, actorConnectionId);
    } else {
      sendTargets(target, {
        type: "note:updated",
        ...common,
        version: note.version,
        updatedAt: note.updatedAt,
        title: note.title,
        contentText: note.contentText,
        mutationKind: event.kind,
      }, actorConnectionId);
    }

    publishToUser(event.actorUserId, {
      type: "note:list-updated",
      reason: event.kind,
      noteId: note.id,
      workspaceId: note.workspaceId,
      actorUserId: event.actorUserId,
      actorConnectionId,
    }, actorConnectionId);

    if (note.workspaceId) {
      broadcastRoom(`workspace:${note.workspaceId}`, {
        type: "workspace:updated",
        workspaceId: note.workspaceId,
        kind: event.kind === "note.created"
          ? "note:created"
          : event.kind === "note.trashed"
            ? "note:deleted"
            : "notebook:updated",
        reason: event.kind,
        noteId: note.id,
        notebookId: note.notebookId,
        actorUserId: event.actorUserId,
        actorConnectionId,
      }, actorConnectionId);
    }
  }

  async function close(): Promise<void> {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    server?.off("upgrade", upgradeHandler);
    for (const client of clients.values()) {
      try {
        client.ws.close(1001, "server shutdown");
      } catch {}
    }
    await yjs.close();
    clients.clear();
    clientsByUser.clear();
    rooms.clear();
    if (wss) await new Promise<void>((resolve) => wss?.close(() => resolve()));
    wss = null;
    server = null;
  }

  function getStats() {
    let noteRooms = 0;
    let workspaceRooms = 0;
    for (const room of rooms.keys()) {
      if (room.startsWith("note:")) noteRooms += 1;
      else if (room.startsWith("workspace:")) workspaceRooms += 1;
    }
    const yjsStats = yjs.getStats();
    return {
      clients: clients.size,
      users: clientsByUser.size,
      rooms: rooms.size,
      noteRooms,
      workspaceRooms,
      yjsRooms: yjsStats.rooms,
      yjsConnections: yjsStats.connections,
      yjsLoadingRooms: yjsStats.loadingRooms,
      yjsWritingRooms: yjsStats.writingRooms,
      yjsSeededRooms: yjsStats.seededRooms,
      yjsReplayedUpdates: yjsStats.replayedUpdates,
      attached: Boolean(server),
    };
  }

  return { attach, publish, publishMutation, publishToUser, close, getStats };
}

export default createPostgresRealtimeRuntime;
