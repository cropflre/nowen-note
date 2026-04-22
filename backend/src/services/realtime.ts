/**
 * Phase 2: 实时协作（WebSocket Hub）
 *
 * 设计要点：
 *   1. 房间模型：note:<noteId>, workspace:<workspaceId>
 *      - note 房间：订阅某篇笔记的 Presence 与更新广播
 *      - workspace 房间：订阅工作区级事件（成员变化、笔记列表增删）
 *   2. Presence：谁在线 + 谁在看哪篇笔记 + 谁正在编辑（软锁）
 *   3. 软锁：某用户进入编辑态时广播 editing=true；其它端显示"xx 正在编辑"提示，
 *      不阻塞保存（由后端 version 乐观锁兜底）。
 *   4. 广播：笔记保存成功后由业务路由调用 broadcastNoteUpdated，将最新版本号推给
 *      同房间其它客户端，让它们静默刷新或提示"已更新"。
 *   5. 心跳：每 30s ping；60s 未响应视为断线，清理 Presence。
 *
 * 20 人规模下，完全内存态，无需 Redis。若未来扩展到多节点，替换 broadcast / Hub 即可。
 */
import type { IncomingMessage } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { URL } from "url";
import { verifyLoginToken } from "../lib/auth-security";
import { getDb } from "../db/schema";
import {
  getUserAccessibleWorkspaceIds,
  resolveNotePermission,
} from "../middleware/acl";
import { yJoin, yLeave, yApplyUpdate, yFlushAll, yEncodeDiffSinceStateVector } from "./yjs";

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
  /** Phase 3: 已加入的 CRDT 笔记房间集合（用于断线时批量释放） */
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
  /** Phase 3: Base64 Y update 或 awareness update 或 stateVector */
  update?: string;
  /** Phase 3: y:sync-step1 携带的客户端 stateVector（Base64） */
  stateVector?: string;
}

interface ServerMessage {
  type:
    | "connected"
    | "presence"
    | "note:updated"
    | "note:deleted"
    | "workspace:updated"
    | "pong"
    | "error"
    | "y:sync"
    | "y:sync-step2"
    | "y:update"
    | "y:awareness"
    | "force-logout";
  [key: string]: any;
}

// ---------------- 全局状态 ----------------

// connectionId → { ws, info }
const clients = new Map<string, { ws: WebSocket; info: ClientInfo }>();

// room → Set<connectionId>
const rooms = new Map<string, Set<string>>();

// 心跳 / 超时
const HEARTBEAT_INTERVAL_MS = 30_000;
const CLIENT_TIMEOUT_MS = 60_000;
let heartbeatTimer: NodeJS.Timeout | null = null;

// ---------------- 工具函数 ----------------

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

/** 向房间内所有客户端广播（可排除自己） */
function broadcastRoom(room: string, msg: ServerMessage, excludeConnectionId?: string) {
  const set = rooms.get(room);
  if (!set) return;
  for (const cid of set) {
    if (cid === excludeConnectionId) continue;
    const client = clients.get(cid);
    if (client) send(client.ws, msg);
  }
}

/** 构造某笔记房间的 Presence 快照 */
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
  for (const cid of set) {
    const c = clients.get(cid);
    if (!c) continue;
    users.push({
      userId: c.info.userId,
      username: c.info.username,
      connectionId: cid,
      editing: c.info.editing,
    });
  }
  return users;
}

/** 向所有看这篇笔记的客户端广播 Presence */
function broadcastPresence(noteId: string) {
  const users = buildNotePresence(noteId);
  broadcastRoom(`note:${noteId}`, {
    type: "presence",
    noteId,
    users,
  });
}

// ---------------- 权限校验 ----------------

/** 校验用户能否加入某笔记房间（至少 read 权限） */
function canJoinNoteRoom(noteId: string, userId: string): boolean {
  const { permission } = resolveNotePermission(noteId, userId);
  return permission !== null; // read 以上都允许
}

/** 校验用户能否加入某工作区房间（成员即可） */
function canJoinWorkspaceRoom(workspaceId: string, userId: string): boolean {
  const accessible = getUserAccessibleWorkspaceIds(userId);
  return accessible.includes(workspaceId);
}

// ---------------- 对外 API ----------------

/**
 * 启动 WebSocket 服务，附加到一个已有的 HTTP server 上。
 * 挂载路径：/ws
 * 鉴权：Query 参数 ?token=<JWT>
 */
export function attachRealtimeServer(server: import("http").Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: any, head) => {
    if (!req.url) {
      socket.destroy();
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname !== "/ws") {
      // 非 /ws 路径直接丢弃，交还给其它 upgrade handler（当前没有）
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

    // 验证用户仍然存在、未被禁用、tokenVersion 一致
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

  // 启动心跳巡检
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const [cid, client] of clients.entries()) {
      if (now - client.info.lastSeen > CLIENT_TIMEOUT_MS) {
        try { client.ws.terminate(); } catch {}
        cleanupClient(cid);
      } else {
        // 发 ping（纯应用层，不依赖 TCP ping）
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
      // 权限校验
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
      // 笔记房间：广播 Presence
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
      // 客户端主动上报：{ type: 'presence', noteId, editing }
      const nextNoteId = msg.noteId ?? null;
      const prevNoteId = info.activeNoteId;
      info.activeNoteId = nextNoteId;
      info.editing = !!msg.editing;

      if (prevNoteId && prevNoteId !== nextNoteId) {
        broadcastPresence(prevNoteId);
      }
      if (nextNoteId) {
        // 自动加入房间（若还没加）
        const room = `note:${nextNoteId}`;
        if (!info.rooms.has(room)) {
          if (canJoinNoteRoom(nextNoteId, info.userId)) {
            joinRoom(connectionId, room);
          }
        }
        broadcastPresence(nextNoteId);
      }
      return;
    }

    case "editing": {
      // 轻量编辑态：不切换笔记，只改 editing 标志
      const noteId = msg.noteId ?? info.activeNoteId;
      if (!noteId) return;
      info.editing = !!msg.editing;
      broadcastPresence(noteId);
      return;
    }

    case "cursor": {
      // 光标广播：只在房间内转发，不存状态
      const noteId = msg.noteId ?? info.activeNoteId;
      if (!noteId) return;
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

    // --------- Phase 3: Y.js CRDT 协同 ---------
    case "y:join": {
      const noteId = msg.noteId;
      if (!noteId) {
        send(ws, { type: "error", error: "Missing noteId" });
        return;
      }
      // 权限：至少 read（y:update 时再额外要求 write）
      if (!canJoinNoteRoom(noteId, info.userId)) {
        send(ws, { type: "error", error: "Forbidden", noteId });
        return;
      }
      // 自动加入 note 房间（让 update 广播可达）
      const room = `note:${noteId}`;
      if (!info.rooms.has(room)) {
        joinRoom(connectionId, room);
      }
      info.yRooms.add(noteId);

      try {
        const { stateBase64 } = yJoin(noteId, info.userId);
        send(ws, { type: "y:sync", noteId, state: stateBase64 });
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
      if (!noteId || !msg.update) return;
      // 二次权限校验：write 以上才能编辑
      const { permission } = resolveNotePermission(noteId, info.userId);
      if (permission !== "write" && permission !== "manage") {
        send(ws, { type: "error", error: "Forbidden (write)", noteId });
        return;
      }
      if (!info.yRooms.has(noteId)) {
        // 没 join 就直接发 update？拒绝
        send(ws, { type: "error", error: "Not joined", noteId });
        return;
      }
      const result = yApplyUpdate(noteId, msg.update, info.userId);
      if (result !== "ok") {
        // 精细化错误码：too_large 让客户端知道是大小问题，不应重试
        const errMap: Record<string, string> = {
          too_large: "Update too large",
          invalid: "Bad update",
          no_room: "Not joined",
        };
        send(ws, { type: "error", error: errMap[result] || "Bad update", noteId, code: result });
        return;
      }
      // 广播给同房间其它客户端
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
      // Phase 3 / P2-#6：双向 sync 第一步
      // 客户端发自己的 stateVector，服务端返回 diff（服务端有而客户端没有的部分）
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
      // awareness 只转发，不持久化
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

  // Phase 3: 释放 CRDT 房间引用
  for (const noteId of Array.from(info.yRooms)) {
    try { yLeave(noteId); } catch {}
  }
  info.yRooms.clear();

  // 离开所有房间
  for (const room of Array.from(info.rooms)) {
    leaveRoom(connectionId, room);
  }
  clients.delete(connectionId);

  // 如果客户端曾在看某篇笔记，广播 Presence 变更
  if (info.activeNoteId) {
    broadcastPresence(info.activeNoteId);
  }
}

// ---------------- 业务广播 API（供路由调用） ----------------

/**
 * 笔记已被保存，通知同房间其它客户端静默刷新
 * @param actorUserId   触发保存的用户（前端可用于"忽略自己"）
 * @param actorConnectionId 可选：触发保存的连接，若提供则排除
 */
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
      ...payload,
    },
    actorConnectionId,
  );
}

/** 笔记被删除/放入回收站 */
export function broadcastNoteDeleted(
  noteId: string,
  payload: { actorUserId?: string; actorUsername?: string; trashed?: boolean } = {},
) {
  broadcastRoom(`note:${noteId}`, {
    type: "note:deleted",
    noteId,
    ...payload,
  });
}

/**
 * 广播一条"服务端主动产生"的 y:update 给 room 中所有订阅者。
 *
 * 当前唯一的触发路径是 EditorPane RTE→MD 切换：
 *   业务侧调用 yReplaceContentAsUpdate 把 Tiptap JSON 规范化后的 markdown 重新写入
 *   yText，产生一个 update。此时已经订阅了该笔记 room 的所有连接（包括发起切换的
 *   这个 tab 自己的 MarkdownEditor 在后续 y:join 前的同会话中、以及其他协作者的 RTE）
 *   都需要收到这个 update，否则它们的 yDoc 仍停留在旧状态。
 *
 * 注意：
 *   - actorUserId 填"server"，以便客户端日志可以识别来源（非人类编辑）。
 *   - 不 exclude 任何连接：发起方自己的连接也需要收到——切换发生在 REST 路径上，
 *     此时客户端还没 y:join 或已经 leave；如果自己当前还 join 着，收到自己的 update
 *     是幂等的（Y.applyUpdate 幂等），不会造成问题。
 */
export function broadcastYjsUpdate(noteId: string, updateBase64: string) {
  broadcastRoom(`note:${noteId}`, {
    type: "y:update",
    noteId,
    update: updateBase64,
    actorConnectionId: null,
    actorUserId: "server",
  });
}

/** 工作区级变更（成员变动、笔记本/笔记增删） */
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
  broadcastRoom(`workspace:${workspaceId}`, {
    type: "workspace:updated",
    workspaceId,
    ...payload,
  });
}

/** 调试：返回当前 Hub 状态 */
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

/**
 * 强制踢掉某用户的所有 WebSocket 连接。
 * 触发时机：
 *   - 管理员禁用 / 删除该用户
 *   - 管理员重置该用户密码
 *   - 用户自己 tokenVersion 被 bump（例如改密码后其它 tab）
 *
 * 行为：向每条连接发送一条 `force-logout` 消息（前端据此清 token + 刷新），
 *       然后关闭连接。前端也可监听此消息即时提示用户。
 */
export function disconnectUser(
  userId: string,
  reason: "account_disabled" | "account_deleted" | "password_reset" | "session_revoked",
) {
  for (const [cid, client] of clients.entries()) {
    if (client.info.userId !== userId) continue;
    try {
      send(client.ws, { type: "force-logout", reason });
    } catch {}
    try {
      client.ws.close(4401, reason);
    } catch {}
    cleanupClient(cid);
  }
}

/** 进程关闭钩子：flush Y.js 到磁盘（异步，caller 应 await） */
export async function shutdownRealtime(): Promise<void> {
  try {
    await yFlushAll();
  } catch (e) {
    console.warn("[shutdown] yFlushAll error:", e);
  }
}
