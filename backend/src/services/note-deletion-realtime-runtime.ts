import type { IncomingMessage, Server } from "http";
import { URL } from "url";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import type { DatabaseAdapter } from "../db/adapters/types";
import { verifyLoginToken } from "../lib/auth-security";
import type { NoteDeletionCommittedEvent } from "./note-deletion-effects-runtime";

interface RuntimeUserRow {
  id: string;
  username: string;
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

interface WorkspaceMemberRow {
  userId: string;
}

export interface NoteDeletionRealtimeRuntime {
  attach(server: Server): void;
  publish(event: NoteDeletionCommittedEvent): Promise<void>;
  close(): Promise<void>;
  getStats(): { clients: number; users: number; attached: boolean };
}

function unauthorized(socket: any, status = "401 Unauthorized"): void {
  try {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  } catch {}
  try {
    socket.destroy();
  } catch {}
}

function isDisabled(value: boolean | number): boolean {
  return value === true || value === 1;
}

export function createNoteDeletionRealtimeRuntime(
  adapter: DatabaseAdapter,
): NoteDeletionRealtimeRuntime {
  const clientsByUser = new Map<string, Set<WebSocket>>();
  let server: Server | null = null;
  let wss: WebSocketServer | null = null;

  function addClient(userId: string, ws: WebSocket): void {
    const clients = clientsByUser.get(userId) ?? new Set<WebSocket>();
    clients.add(ws);
    clientsByUser.set(userId, clients);
  }

  function removeClient(userId: string, ws: WebSocket): void {
    const clients = clientsByUser.get(userId);
    if (!clients) return;
    clients.delete(ws);
    if (clients.size === 0) clientsByUser.delete(userId);
  }

  function send(ws: WebSocket, message: Record<string, unknown>): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(message));
    } catch (error) {
      console.warn(
        "[note-deletion-realtime-runtime] send failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async function authenticate(token: string): Promise<RuntimeUserRow | null> {
    const payload = verifyLoginToken(token);
    if (!payload?.userId) return null;
    const user = await adapter.queryOne<RuntimeUserRow>(
      `SELECT id, username, "tokenVersion" AS "tokenVersion", "isDisabled" AS "isDisabled"
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

  function handleMessage(ws: WebSocket, data: RawData): void {
    let message: { type?: string };
    try {
      message = JSON.parse(data.toString()) as { type?: string };
    } catch {
      send(ws, { type: "error", error: "Invalid JSON" });
      return;
    }

    if (message.type === "ping") {
      send(ws, { type: "pong", t: Date.now() });
    }
    // subscribe / presence / Yjs 消息由后续完整 realtime 迁移处理。
    // 删除事件 Hub 只维持已认证用户连接，不加载 SQLite ACL 或 Yjs 服务。
  }

  const upgradeHandler = async (req: IncomingMessage, socket: any, head: Buffer) => {
    try {
      if (!req.url) {
        unauthorized(socket, "400 Bad Request");
        return;
      }
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (url.pathname !== "/ws") {
        unauthorized(socket, "404 Not Found");
        return;
      }
      const token = url.searchParams.get("token");
      if (!token) {
        unauthorized(socket);
        return;
      }
      const user = await authenticate(token);
      if (!user || !wss) {
        unauthorized(socket);
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        addClient(user.id, ws);
        send(ws, {
          type: "connected",
          connectionId: cryptoRandomId(),
          userId: user.id,
          username: user.username,
          capabilities: ["note-deletion-events"],
        });
        ws.on("message", (data) => handleMessage(ws, data));
        ws.on("close", () => removeClient(user.id, ws));
        ws.on("error", () => removeClient(user.id, ws));
      });
    } catch (error) {
      console.warn(
        "[note-deletion-realtime-runtime] upgrade failed:",
        error instanceof Error ? error.message : String(error),
      );
      unauthorized(socket);
    }
  };

  function cryptoRandomId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function attach(target: Server): void {
    if (server) return;
    server = target;
    wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", upgradeHandler);
    console.log("[note-deletion-realtime-runtime] deletion event hub attached at /ws");
  }

  async function recipientUserIds(event: NoteDeletionCommittedEvent): Promise<Set<string>> {
    const recipients = new Set<string>([event.actorUserId]);
    if (!event.workspaceId) return recipients;

    const owner = await adapter.queryOne<WorkspaceOwnerRow>(
      `SELECT "ownerId" AS "ownerId" FROM workspaces WHERE id = ?`,
      [event.workspaceId],
    );
    if (owner?.ownerId) recipients.add(owner.ownerId);
    const members = await adapter.queryMany<WorkspaceMemberRow>(
      `SELECT "userId" AS "userId" FROM workspace_members WHERE "workspaceId" = ?`,
      [event.workspaceId],
    );
    for (const member of members) recipients.add(member.userId);
    return recipients;
  }

  async function publish(event: NoteDeletionCommittedEvent): Promise<void> {
    const recipients = await recipientUserIds(event);
    const message = event.kind === "note.deleted"
      ? {
          type: "note:deleted",
          noteId: event.noteId,
          actorConnectionId: null,
          actorUserId: event.actorUserId,
          workspaceId: event.workspaceId,
          trashed: false,
        }
      : {
          type: "notes:deleted",
          noteIds: event.noteIds,
          actorUserId: event.actorUserId,
          workspaceId: event.workspaceId,
          trashed: false,
        };

    for (const userId of recipients) {
      const clients = clientsByUser.get(userId);
      if (!clients) continue;
      for (const ws of clients) send(ws, message);
    }
  }

  async function close(): Promise<void> {
    if (server) server.off("upgrade", upgradeHandler);
    for (const clients of clientsByUser.values()) {
      for (const ws of clients) {
        try {
          ws.close(1001, "server shutdown");
        } catch {}
      }
    }
    clientsByUser.clear();
    if (wss) {
      await new Promise<void>((resolve) => wss?.close(() => resolve()));
    }
    wss = null;
    server = null;
  }

  function getStats(): { clients: number; users: number; attached: boolean } {
    let clients = 0;
    for (const set of clientsByUser.values()) clients += set.size;
    return { clients, users: clientsByUser.size, attached: Boolean(server) };
  }

  return { attach, publish, close, getStats };
}

export default createNoteDeletionRealtimeRuntime;
