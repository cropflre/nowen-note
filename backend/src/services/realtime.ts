/**
 * Phase 2: 实时协作（WebSocket Hub）
 *
 * 设计要点：
 *   1. 房间模型：note:<noteId>, workspace:<workspaceId>
 *   2. Presence：谁在线 + 谁在看哪篇笔记 + 谁正在编辑（软锁）
 *   3. Y.js 更新只有写入 append-only 恢复日志后才 ACK 和广播
 *   4. 心跳：每 30s ping；60s 未响应视为断线，清理 Presence
 */
import type { IncomingMessage } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { URL } from "url";
import { verifyLoginToken } from "../lib/auth-security";
import { getDb } from "../db/schema";
import {
  getUserAccessibleWorkspaceIds,
  resolveNotePermission,
  resolveNotebookPermission,
} from "../middleware/acl";
import { yJoin, yLeave, yFlushAll, yEncodeDiffSinceStateVector } from "./yjs";
import { yApplyUpdateDurably } from "./yjsDurability";

// ---------------- 类型 ----------------
export interface ClientInfo {
  userId: string;
  username: string;
  /** 服务端分配的连接 ID（同一用户多标签页也会有不同 connectionId） */
  connectionId: string;
  /** 当前正在查看的笔记，null 表示未聚焦任何笔记 */
  activeNoteId: string | null;
  /** 是否处于编辑态（进入编辑框 / 最近 N 秒内有输入） */
  editing: boolean;
  /** 最近一次心跳时间戳（毫秒） */
  lastSeen: number;
  /** 加入的房间集合 */
  rooms: Set<string>;
  /** 已加入的 CRDT 笔记房间集合（用于断线时批量释放） */
  yRooms: Set<string>;
}

interface ClientMessage {
  type:
    | "subscribe"
    | "unsubscribe"
    | "presence"
    | "ping"
    | "editing"
    | "cursor"
    | "y:join"
    | "y:leave"
    | "y:update"
    | "y:awareness"
    | "y:sync-step1";
  room?: string;
  noteId?: string | null;
  editing?: boolean;
  cursor?: { line?: number; ch?: number; selection?: string };
  /** Base64 Y update 或 awareness update */
  update?: string;
  /** 客户端为一次持久化发送生成的唯一 ID，服务端原样回传 y:ack/error */
  operationId?: string;
  /** y:sync-step1 携带的客户端 stateVector（Base64） */
  stateVector?: string;
}

interface ServerMessage {
  type:
    | "connected"
    | "presence"
    | "note:updated"
    | "note:deleted"
    | "notes:deleted"
    | "workspace:updated"
    | "pong"
    | "error"
    | "y:sync"
    | "y:sync-step2"
    | "y:update"
    | "y:ack"
    | "y:awareness"
    | "force-logout";
  [key: string]: any;
}

const clients = new Map<string, { ws: WebSocket; info: ClientInfo }>();
const rooms = new Map<string, Set<string>>();

const HEARTBEAT_INTERVAL_MS = 30_000;
const CLIENT_TIMEOUT_MS = 60_000;
let heartbeatTimer: NodeJS.Timeout | null = null;

function genId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch (e) {
    console.warn("[realtime] send failed:", e);
  }
}

function joinRoom(connectionId: string, room: string) {
  let set = rooms.get(room);
  if (!set) {
    set = new Set();
    rooms.set(room, set);
  }
  set.add(connectionId);
  const client = clients.get(connectionId);
  if (client) client.info.rooms.add(room);
}

function leaveRoom(connectionId: string, room: string) {
  const set = rooms.get(room);
  if (!set) return;
  set.delete(connectionId);
  if (set.size === 0) rooms.delete(room);
  const client = clients.get(connectionId);
  if (client) client.info.rooms.delete(room);
}

function canJoinNoteRoom(noteId: string, userId: string): boolean {
  const { permission } = resolveNotePermission(noteId, userId);
  return permission !== null;
}

function canJoinNotebookResource(notebookId: string, userId: string): boolean {
  const { permission } = resolveNotebookPermission(notebookId, userId);
  return permission !== null;
}

function canJoinWorkspaceRoom(workspaceId: string, userId: string): boolean {
  const accessible = getUserAccessibleWorkspaceIds(userId);
  return accessible.includes(workspaceId);
}

/**
 * Re-check note access at send time, not only when the socket joined the room.
 * Revoking a member must immediately stop presence, cursor and Yjs delivery even
 * when the browser keeps an old WebSocket connection alive.
 */
function broadcastRoom(room: string, msg: ServerMessage, excludeConnectionId?: string) {
  const set = rooms.get(room);
  if (!set) return;
  const noteId = room.startsWith("note:") ? room.slice(5) : null;
  for (const cid of Array.from(set)) {
    if (cid === excludeConnectionId) continue;
    const client = clients.get(cid);
    if (!client) continue;
    if (noteId && !canJoinNoteRoom(noteId, client.info.userId)) {
      leaveRoom(cid, room);
      if (client.info.yRooms.delete(noteId)) {
        try { yLeave(noteId); } catch {}
      }
      if (client.info.activeNoteId === noteId) {
        client.info.activeNoteId = null;
        client.info.editing = false;
      }
      continue;
    }
    send(client.ws, msg);
  }
}

function buildNotePresence(noteId: string) {
  const room = `note:${noteId}`;
  const set = rooms.get(room);
  if (!set) return [];
  const users: Array<{
    userId: string;
    username: string;
    connectionId: string;
    editing: boolean;
  }> = [];
  for (const cid of Array.from(set)) {
    const c = clients.get(cid);
    if (!c) continue;
    if (!canJoinNoteRoom(noteId, c.info.userId)) {
      leaveRoom(cid, room);
      if (c.info.yRooms.delete(noteId)) {
        try { yLeave(noteId); } catch {}
      }
      continue;
    }
    users.push({
      userId: c.info.userId,
      username: c.info.username,
      connectionId: cid,
      editing: c.info.editing,
    });
  }
  return users;
}

function broadcastPresence(noteId: string) {
  const users = buildNotePresence(noteId);
  broadcastRoom(`note:${noteId}`, {
    type: "presence",
    noteId,
    users,
  });
}

export function attachRealtimeServer(server: import("http").Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: any, head) => {
    if (!req.url) {
      socket.destroy();
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }

    const token = url.searchParams.get("token");
    if (!token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const payload = verifyLoginToken(token);
    if (!payload || !payload.userId) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const db = getDb();
    const user = db
      .prepare("SELECT id, username, isDisabled, tokenVersion FROM users WHERE id = ?")
      .get(payload.userId) as
      | { id: string; username: string; isDisabled: number; tokenVersion: number }
      | undefined;
    if (!user || user.isDisabled || (payload.tver ?? 0) !== (user.tokenVersion ?? 0)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws, user.id, user.username);
    });
  });

  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const [cid, client] of clients.entries()) {
      if (now - client.info.lastSeen > CLIENT_TIMEOUT_MS) {
        try { client.ws.terminate(); } catch {}
        cleanupClient(cid);
      } else {
        send(client.ws, { type: "pong", t: now });
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  console.log("[realtime] WebSocket server attached at /ws");
}

function handleConnection(ws: WebSocket, userId: string, username: string) {
  const connectionId = genId();
  const info: ClientInfo = {
    userId,
    username,
    connectionId,
    activeNoteId: null,
    editing: false,
    lastSeen: Date.now(),
    rooms: new Set(),
    yRooms: new Set(),
  };
  clients.set(connectionId, { ws, info });

  send(ws, { type: "connected", connectionId, userId, username });

  ws.on("message", (data) => {
    info.lastSeen = Date.now();
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      send(ws, { type: "error", error: "Invalid JSON" });
      return;
    }
    handleClientMessage(connectionId, msg);
  });

  ws.on("close", () => cleanupClient(connectionId));
  ws.on("error", (e) => {
    console.warn(`[realtime] ws error (${connectionId}):`, e.message);
    cleanupClient(connectionId);
  });
}

function handleClientMessage(connectionId: string, msg: ClientMessage) {
  const client = clients.get(connectionId);
  if (!client) return;
  const { info, ws } = client;

  switch (msg.type) {
    case "ping": {
      send(ws, { type: "pong", t: Date.now() });
      return;
    }

    case "subscribe": {
      const room = msg.room;
      if (!room) {
        send(ws, { type: "error", error: "Missing room" });
        return;
      }
      if (room.startsWith("note:")) {
        const noteId = room.slice(5);
        if (!canJoinNoteRoom(noteId, info.userId)) {
          send(ws, { type: "error", error: "Forbidden", room });
          return;
        }
      } else if (room.startsWith("workspace:")) {
        const wsId = room.slice(10);
        if (!canJoinWorkspaceRoom(wsId, info.userId)) {
          send(ws, { type: "error", error: "Forbidden", room });
          return;
        }
      } else {
        send(ws, { type: "error", error: "Unknown room type" });
        return;
      }
      joinRoom(connectionId, room);
      if (room.startsWith("note:")) {
        const noteId = room.slice(5);
        info.activeNoteId = noteId;
        broadcastPresence(noteId);
      }
      return;
    }

    case "unsubscribe": {
      const room = msg.room;
      if (!room) return;
      leaveRoom(connectionId, room);
      if (room.startsWith("note:")) {
        const noteId = room.slice(5);
        if (info.activeNoteId === noteId) {
          info.activeNoteId = null;
          info.editing = false;
        }
        broadcastPresence(noteId);
      }
      return;
    }

    case "presence": {
      const nextNoteId = msg.noteId ?? null;
      const prevNoteId = info.activeNoteId;
      if (nextNoteId && !canJoinNoteRoom(nextNoteId, info.userId)) {
        send(ws, { type: "error", error: "Forbidden", noteId: nextNoteId });
        return;
      }
      info.activeNoteId = nextNoteId;
      info.editing = !!msg.editing;

      if (prevNoteId && prevNoteId !== nextNoteId) broadcastPresence(prevNoteId);
      if (nextNoteId) {
        const room = `note:${nextNoteId}`;
        if (!info.rooms.has(room)) joinRoom(connectionId, room);
        broadcastPresence(nextNoteId);
      }
      return;
    }

    case "editing": {
      const noteId = msg.noteId ?? info.activeNoteId;
      if (!noteId || !canJoinNoteRoom(noteId, info.userId)) return;
      info.editing = !!msg.editing;
      broadcastPresence(noteId);
      return;
    }

    case "cursor": {
      const noteId = msg.noteId ?? info.activeNoteId;
      if (!noteId || !canJoinNoteRoom(noteId, info.userId)) return;
      broadcastRoom(
        `note:${noteId}`,
        {
          type: "presence",
          noteId,
          cursorUpdate: {
            userId: info.userId,
            username: info.username,
            connectionId,
            cursor: msg.cursor || null,
          },
        },
        connectionId,
      );
      return;
    }

    case "y:join": {
      const noteId = msg.noteId;
      if (!noteId) {
        send(ws, { type: "error", error: "Missing noteId" });
        return;
      }
      if (!canJoinNoteRoom(noteId, info.userId)) {
        send(ws, { type: "error", error: "Forbidden", noteId });
        return;
      }
      const room = `note:${noteId}`;
      if (!info.rooms.has(room)) joinRoom(connectionId, room);
      info.yRooms.add(noteId);

      try {
        const { stateBase64 } = yJoin(noteId, info.userId);
        send(ws, {
          type: "y:sync",
          noteId,
          state: stateBase64,
          persistedAt: new Date().toISOString(),
        });
      } catch (e) {
        console.warn("[realtime] y:join failed:", e);
        send(ws, { type: "error", error: "y:join failed", noteId });
      }
      return;
    }

    case "y:leave": {
      const noteId = msg.noteId;
      if (!noteId) return;
      if (info.yRooms.has(noteId)) {
        info.yRooms.delete(noteId);
        try { yLeave(noteId); } catch {}
      }
      return;
    }

    case "y:update": {
      const noteId = msg.noteId;
      const operationId = typeof msg.operationId === "string" && msg.operationId
        ? msg.operationId
        : null;
      if (!noteId || !msg.update) return;

      const { permission } = resolveNotePermission(noteId, info.userId);
      if (permission !== "write" && permission !== "manage") {
        send(ws, {
          type: "error",
          error: "Forbidden (write)",
          noteId,
          operationId,
          code: "forbidden",
        });
        return;
      }
      if (!info.yRooms.has(noteId)) {
        send(ws, {
          type: "error",
          error: "Not joined",
          noteId,
          operationId,
          code: "no_room",
        });
        return;
      }

      const result = yApplyUpdateDurably(noteId, msg.update, info.userId, operationId);
      if (!result.ok) {
        const errMap: Record<string, string> = {
          too_large: "Update too large",
          invalid: "Bad update",
          no_room: "Not joined",
          persist_failed: "Update persistence failed",
          invalid_operation: "Invalid operation id",
          operation_conflict: "Operation id was reused for different content",
        };
        send(ws, {
          type: "error",
          error: errMap[result.code] || "Bad update",
          noteId,
          operationId,
          code: result.code,
        });
        return;
      }

      if (operationId) {
        send(ws, {
          type: "y:ack",
          noteId,
          operationId,
          updateId: result.updateId,
          persistedAt: result.persistedAt,
          duplicate: result.duplicate,
        });
      }

      broadcastRoom(
        `note:${noteId}`,
        {
          type: "y:update",
          noteId,
          update: msg.update,
          actorConnectionId: connectionId,
          actorUserId: info.userId,
        },
        connectionId,
      );
      return;
    }

    case "y:sync-step1": {
      const noteId = msg.noteId;
      if (!noteId || !msg.stateVector) return;
      if (!canJoinNoteRoom(noteId, info.userId)) {
        send(ws, { type: "error", error: "Forbidden", noteId });
        return;
      }
      if (!info.yRooms.has(noteId)) {
        send(ws, { type: "error", error: "Not joined", noteId });
        return;
      }
      const diff = yEncodeDiffSinceStateVector(noteId, msg.stateVector);
      if (diff == null) {
        send(ws, { type: "error", error: "sync-step1 failed", noteId });
        return;
      }
      send(ws, { type: "y:sync-step2", noteId, update: diff });
      return;
    }

    case "y:awareness": {
      const noteId = msg.noteId;
      if (!noteId || !msg.update) return;
      if (!canJoinNoteRoom(noteId, info.userId)) return;
      broadcastRoom(
        `note:${noteId}`,
        {
          type: "y:awareness",
          noteId,
          update: msg.update,
          actorConnectionId: connectionId,
          actorUserId: info.userId,
        },
        connectionId,
      );
      return;
    }
  }
}

function cleanupClient(connectionId: string) {
  const client = clients.get(connectionId);
  if (!client) return;
  const { info } = client;

  for (const noteId of Array.from(info.yRooms)) {
    try { yLeave(noteId); } catch {}
  }
  info.yRooms.clear();

  for (const room of Array.from(info.rooms)) leaveRoom(connectionId, room);
  clients.delete(connectionId);

  if (info.activeNoteId) broadcastPresence(info.activeNoteId);
}

export function broadcastNoteUpdated(
  noteId: string,
  payload: {
    version: number;
    updatedAt: string;
    title?: string;
    contentText?: string;
    actorUserId?: string;
    actorUsername?: string;
  },
  actorConnectionId?: string,
) {
  broadcastRoom(
    `note:${noteId}`,
    {
      type: "note:updated",
      noteId,
      actorConnectionId: actorConnectionId || null,
      ...payload,
    },
    actorConnectionId,
  );
}

export function broadcastNoteDeleted(
  noteId: string,
  payload: { actorUserId?: string; actorUsername?: string; trashed?: boolean } = {},
  actorConnectionId?: string,
) {
  const deleteMsg = {
    type: "note:deleted" as const,
    noteId,
    actorConnectionId: actorConnectionId || null,
    ...payload,
  };
  console.log("[realtime] broadcastNoteDeleted", {
    noteId,
    actorUserId: payload.actorUserId,
    trashed: payload.trashed,
    actorConnectionId,
  });
  broadcastRoom(`note:${noteId}`, deleteMsg, actorConnectionId);
  if (payload.actorUserId) broadcastToUser(payload.actorUserId, deleteMsg);
}

export function broadcastNotesDeleted(
  noteIds: string[],
  payload: { actorUserId: string; workspaceId?: string; trashed?: boolean },
) {
  if (noteIds.length === 0) return;
  const message = {
    type: "notes:deleted",
    noteIds,
    actorUserId: payload.actorUserId,
    workspaceId: payload.workspaceId || null,
    trashed: payload.trashed ?? false,
  } as const;

  // The actor needs exact IDs to update optimistic local state. Other workspace
  // members receive only a generic refresh signal because deleted nodes may no
  // longer be resolvable for an after-the-fact ACL check.
  broadcastToUser(payload.actorUserId, message);
  if (payload.workspaceId) {
    broadcastRoom(`workspace:${payload.workspaceId}`, {
      type: "workspace:updated",
      workspaceId: payload.workspaceId,
      kind: "note:deleted",
    });
  }
}

export function broadcastYjsUpdate(noteId: string, updateBase64: string) {
  broadcastRoom(`note:${noteId}`, {
    type: "y:update",
    noteId,
    update: updateBase64,
    actorConnectionId: null,
    actorUserId: "server",
  });
}

export function broadcastWorkspaceUpdated(
  workspaceId: string,
  payload: {
    kind:
      | "member:joined"
      | "member:left"
      | "member:updated"
      | "note:created"
      | "note:deleted"
      | "notebook:updated";
    [k: string]: any;
  },
) {
  const room = `workspace:${workspaceId}`;
  const set = rooms.get(room);
  if (!set) return;
  const noteId = typeof payload.noteId === "string" ? payload.noteId : null;
  const notebookId = typeof payload.notebookId === "string" ? payload.notebookId : null;
  const noteIds = Array.isArray(payload.noteIds)
    ? payload.noteIds.filter((id: unknown): id is string => typeof id === "string")
    : null;

  for (const cid of Array.from(set)) {
    const client = clients.get(cid);
    if (!client) continue;
    let detailedPayload: Record<string, any> | null = payload;
    if (noteId && !canJoinNoteRoom(noteId, client.info.userId)) detailedPayload = null;
    if (notebookId && !canJoinNotebookResource(notebookId, client.info.userId)) detailedPayload = null;
    if (noteIds) {
      const visibleIds = noteIds.filter((id) => canJoinNoteRoom(id, client.info.userId));
      detailedPayload = visibleIds.length > 0 ? { ...payload, noteIds: visibleIds } : null;
    }
    send(client.ws, detailedPayload
      ? { type: "workspace:updated", workspaceId, ...detailedPayload }
      : { type: "workspace:updated", workspaceId, kind: payload.kind });
  }
}

export function broadcastToUser(userId: string, msg: ServerMessage) {
  for (const [, client] of clients.entries()) {
    if (client.info.userId === userId) send(client.ws, msg);
  }
}

export function getRealtimeStats() {
  return {
    clients: clients.size,
    rooms: rooms.size,
    roomDetails: Array.from(rooms.entries()).map(([name, set]) => ({
      name,
      size: set.size,
    })),
  };
}

export function disconnectUser(
  userId: string,
  reason: "account_disabled" | "account_deleted" | "password_reset" | "session_revoked",
) {
  for (const [cid, client] of clients.entries()) {
    if (client.info.userId !== userId) continue;
    try { send(client.ws, { type: "force-logout", reason }); } catch {}
    try { client.ws.close(4401, reason); } catch {}
    cleanupClient(cid);
  }
}

export async function shutdownRealtime(): Promise<void> {
  try {
    await yFlushAll();
  } catch (e) {
    console.warn("[shutdown] yFlushAll error:", e);
  }
}
