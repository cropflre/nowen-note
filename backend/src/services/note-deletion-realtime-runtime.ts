import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import { URL } from "node:url";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import type { DatabaseAdapter } from "../db/adapters/types";
import { verifyLoginToken } from "../lib/auth-security";
import { createNoteCoreRuntime } from "./note-core-runtime";
import type { NoteDeletionCommittedEvent } from "./note-deletion-effects-runtime";

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

export interface NoteDeletionRealtimeRuntime {
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

export function createNoteDeletionRealtimeRuntime(
  adapter: DatabaseAdapter,
): NoteDeletionRealtimeRuntime {
  const noteCore = createNoteCoreRuntime(adapter, "postgres");
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
    if (message.type?.startsWith("y:")) {
      send(client.ws, {
        type: "error",
        noteId: message.noteId || null,
        code: "POSTGRES_YJS_MIGRATION_PENDING",
        error: "PostgreSQL Yjs realtime routes are not migrated yet",
      });
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
          ],
          pendingCapabilities: ["yjs-realtime"],
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
    console.log("[postgres-realtime-runtime] room and presence hub attached at /ws");
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
    return {
      clients: clients.size,
      users: clientsByUser.size,
      rooms: rooms.size,
      noteRooms,
      workspaceRooms,
      attached: Boolean(server),
    };
  }

  return { attach, publish, publishMutation, publishToUser, close, getStats };
}

export default createNoteDeletionRealtimeRuntime;
