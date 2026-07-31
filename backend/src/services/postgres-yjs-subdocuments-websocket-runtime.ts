import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import { URL } from "node:url";

import { WebSocket, WebSocketServer, type RawData } from "ws";

import type { DatabaseAdapter } from "../db/adapters/types";
import { verifyLoginToken } from "../lib/auth-security";
import { createPostgresSubdocumentWebsocketRepository } from "../repositories/postgresSubdocumentWebsocketRepository";
import { createNoteCoreRuntime } from "./note-core-runtime";
import {
  createPostgresYjsSubdocumentRuntime,
  PostgresYjsSubdocumentRuntimeError,
  type PostgresYjsSubdocumentManifest,
} from "./postgres-yjs-subdocuments-runtime";

interface RuntimeClient {
  ws: WebSocket;
  connectionId: string;
  userId: string;
  username: string;
  role: string;
  joinedNotes: Set<string>;
  joinedSections: Set<string>;
  lastSeen: number;
}

interface ClientMessage {
  type?: string;
  noteId?: string;
  sectionId?: string;
  update?: string;
  content?: string;
  operationId?: string;
  generation?: number;
}

type UpgradeHandler = (req: IncomingMessage, socket: any, head: Buffer) => void;

export interface PostgresYjsSubdocumentMutationEvent {
  kind: "note.updated";
  actorUserId: string;
  actorConnectionId: null;
  note: {
    id: string;
    workspaceId: string | null;
    notebookId: string;
    version: number;
    updatedAt: string;
    title: string;
    contentText: string;
  };
}

export interface PostgresYjsSubdocumentWebsocketOptions {
  path?: string;
  heartbeatIntervalMs?: number;
  clientTimeoutMs?: number;
  maxUpdateBytes?: number;
  maxStructureContentBytes?: number;
  publishMutation?: (event: PostgresYjsSubdocumentMutationEvent) => Promise<void>;
}

export interface PostgresYjsSubdocumentWebsocketRuntime {
  attach(server: Server): void;
  close(): Promise<void>;
  getStats(): {
    attached: boolean;
    clients: number;
    noteRooms: number;
    sectionRooms: number;
    memberships: number;
    updates: number;
    structureChanges: number;
    invalidations: number;
  };
}

const DEFAULT_PATH = "/ws/subdocuments";
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_CLIENT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_UPDATE_BYTES = 1024 * 1024;
const DEFAULT_MAX_STRUCTURE_CONTENT_BYTES = 8 * 1024 * 1024;
const MAX_ID_LENGTH = 200;

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

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function roomKey(noteId: string, sectionId: string): string {
  return `${noteId}\u0000${sectionId}`;
}

function decodeCanonicalBase64(value: unknown, maxBytes: number): Uint8Array {
  const input = typeof value === "string" ? value.trim() : "";
  if (!input || input.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(input)) {
    throw new PostgresYjsSubdocumentRuntimeError(
      "SUBDOCUMENT_INVALID_UPDATE",
      "Invalid base64 subdocument update",
    );
  }
  const buffer = Buffer.from(input, "base64");
  if (buffer.toString("base64").replace(/=+$/u, "") !== input.replace(/=+$/u, "")) {
    throw new PostgresYjsSubdocumentRuntimeError(
      "SUBDOCUMENT_INVALID_UPDATE",
      "Invalid base64 subdocument update",
    );
  }
  if (buffer.byteLength === 0 || buffer.byteLength > maxBytes) {
    throw new PostgresYjsSubdocumentRuntimeError(
      "SUBDOCUMENT_INVALID_UPDATE_SIZE",
      `Subdocument update must be between 1 and ${maxBytes} bytes`,
      { maxBytes, actualBytes: buffer.byteLength },
    );
  }
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

export function createPostgresYjsSubdocumentWebsocketRuntime(
  adapter: DatabaseAdapter,
  options: PostgresYjsSubdocumentWebsocketOptions = {},
): PostgresYjsSubdocumentWebsocketRuntime {
  const path = options.path || DEFAULT_PATH;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const clientTimeoutMs = options.clientTimeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS;
  const maxUpdateBytes = options.maxUpdateBytes ?? DEFAULT_MAX_UPDATE_BYTES;
  const maxStructureContentBytes = options.maxStructureContentBytes
    ?? DEFAULT_MAX_STRUCTURE_CONTENT_BYTES;
  const repository = createPostgresSubdocumentWebsocketRepository(adapter);
  const noteCore = createNoteCoreRuntime(adapter, "postgres");
  const subdocuments = createPostgresYjsSubdocumentRuntime(adapter);
  const prepareManifest = subdocuments.prepare;
  const clients = new Map<string, RuntimeClient>();
  const noteRooms = new Map<string, Set<string>>();
  const sectionRooms = new Map<string, Set<string>>();
  const knownGenerations = new Map<string, number>();
  let server: Server | null = null;
  let wss: WebSocketServer | null = null;
  let dispatcher: UpgradeHandler | null = null;
  let capturedUpgradeHandlers: UpgradeHandler[] = [];
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let updates = 0;
  let structureChanges = 0;
  let invalidations = 0;

  function send(ws: WebSocket, message: Record<string, unknown>): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(message));
    } catch (error) {
      console.warn("[postgres-subdocument-ws] send failed:", errorMessage(error));
    }
  }

  function sendError(
    client: RuntimeClient,
    error: unknown,
    noteId?: string | null,
    sectionId?: string | null,
  ): void {
    if (error instanceof PostgresYjsSubdocumentRuntimeError) {
      send(client.ws, {
        type: "error",
        noteId: noteId || null,
        sectionId: sectionId || null,
        code: error.code,
        error: error.message,
        details: error.details,
      });
      return;
    }
    send(client.ws, {
      type: "error",
      noteId: noteId || null,
      sectionId: sectionId || null,
      code: "SUBDOCUMENT_PROTOCOL_FAILED",
      error: "PostgreSQL subdocument protocol failed",
    });
  }

  async function authenticate(token: string) {
    const payload = verifyLoginToken(token);
    if (!payload?.userId) return null;
    const user = await repository.findUser(payload.userId);
    if (!user || user.isDisabled === true || user.isDisabled === 1) return null;
    if ((payload.tver ?? 0) !== (user.tokenVersion ?? 0)) return null;
    if (payload.jti) {
      const session = await repository.findSession(payload.jti, payload.userId);
      if (!session || session.revokedAt) return null;
      if (session.expiresAt && new Date(session.expiresAt).getTime() <= Date.now()) return null;
    }
    return user;
  }

  async function canRead(noteId: string, client: RuntimeClient): Promise<boolean> {
    if (client.role === "admin") return true;
    return (await noteCore.resolveNotePermissionAsync(noteId, client.userId)).permission !== null;
  }

  async function canWrite(noteId: string, client: RuntimeClient): Promise<boolean> {
    if (client.role === "admin") return true;
    const permission = (await noteCore.resolveNotePermissionAsync(noteId, client.userId)).permission;
    return permission === "write" || permission === "manage";
  }

  function addMembership(client: RuntimeClient, noteId: string, sectionId?: string): void {
    const noteMembers = noteRooms.get(noteId) ?? new Set<string>();
    noteMembers.add(client.connectionId);
    noteRooms.set(noteId, noteMembers);
    client.joinedNotes.add(noteId);
    if (!sectionId) return;
    const key = roomKey(noteId, sectionId);
    const sectionMembers = sectionRooms.get(key) ?? new Set<string>();
    sectionMembers.add(client.connectionId);
    sectionRooms.set(key, sectionMembers);
    client.joinedSections.add(key);
  }

  function removeMembership(client: RuntimeClient, noteId: string, sectionId?: string): void {
    if (sectionId) {
      const key = roomKey(noteId, sectionId);
      const sectionMembers = sectionRooms.get(key);
      sectionMembers?.delete(client.connectionId);
      if (sectionMembers?.size === 0) sectionRooms.delete(key);
      client.joinedSections.delete(key);
      if (Array.from(client.joinedSections).some((entry) => entry.startsWith(`${noteId}\u0000`))) return;
    } else {
      for (const key of Array.from(client.joinedSections)) {
        if (!key.startsWith(`${noteId}\u0000`)) continue;
        const sectionMembers = sectionRooms.get(key);
        sectionMembers?.delete(client.connectionId);
        if (sectionMembers?.size === 0) sectionRooms.delete(key);
        client.joinedSections.delete(key);
      }
    }
    const noteMembers = noteRooms.get(noteId);
    noteMembers?.delete(client.connectionId);
    if (noteMembers?.size === 0) noteRooms.delete(noteId);
    client.joinedNotes.delete(noteId);
  }

  function cleanupClient(connectionId: string): void {
    const client = clients.get(connectionId);
    if (!client) return;
    for (const noteId of Array.from(client.joinedNotes)) removeMembership(client, noteId);
    clients.delete(connectionId);
  }

  function broadcastSection(
    noteId: string,
    sectionId: string,
    message: Record<string, unknown>,
    excludeConnectionId?: string,
  ): void {
    for (const connectionId of sectionRooms.get(roomKey(noteId, sectionId)) ?? []) {
      if (connectionId === excludeConnectionId) continue;
      const client = clients.get(connectionId);
      if (client) send(client.ws, message);
    }
  }

  function invalidateNote(
    noteId: string,
    reason: string,
    manifest?: PostgresYjsSubdocumentManifest,
  ): void {
    const members = Array.from(noteRooms.get(noteId) ?? []);
    if (members.length === 0) return;
    invalidations += 1;
    for (const connectionId of members) {
      const client = clients.get(connectionId);
      if (!client) continue;
      send(client.ws, {
        type: "y:subdoc:reload",
        noteId,
        reason,
        manifest: manifest || null,
      });
      removeMembership(client, noteId);
    }
  }

  async function prepareForJoin(noteId: string): Promise<PostgresYjsSubdocumentManifest> {
    const manifest = await prepareManifest(noteId);
    if (!manifest) {
      throw new PostgresYjsSubdocumentRuntimeError(
        "SUBDOCUMENT_UNSUPPORTED_CONTENT_FORMAT",
        "Subdocument protocol requires a Tiptap JSON note",
      );
    }
    const previous = knownGenerations.get(noteId);
    if (previous != null && previous !== manifest.generation) {
      invalidateNote(noteId, "manifest-generation-changed", manifest);
    }
    knownGenerations.set(noteId, manifest.generation);
    return manifest;
  }

  async function sendState(client: RuntimeClient, noteId: string, sectionId?: string): Promise<void> {
    if (!(await canRead(noteId, client))) {
      send(client.ws, { type: "error", noteId, code: "FORBIDDEN", error: "Forbidden" });
      return;
    }
    const manifest = await prepareForJoin(noteId);
    const readOnly = !(await canWrite(noteId, client));
    let section: Record<string, unknown> | null = null;
    if (sectionId) {
      const descriptor = manifest.sections.find((entry) => entry.id === sectionId);
      const state = descriptor ? await subdocuments.getState(noteId, sectionId) : null;
      if (!descriptor || !state) {
        throw new PostgresYjsSubdocumentRuntimeError(
          "SUBDOCUMENT_NOT_FOUND",
          "Subdocument section not found",
        );
      }
      section = {
        ...descriptor,
        state: Buffer.from(state.snapshot).toString("base64"),
      };
    }
    const current = clients.get(client.connectionId);
    if (!current) return;
    addMembership(current, noteId, sectionId);
    send(current.ws, {
      type: "y:subdoc:state",
      noteId,
      manifest,
      section,
      readOnly,
    });
  }

  async function publishNoteMutation(
    noteId: string,
    client: RuntimeClient,
    version: number,
    contentText: string,
  ): Promise<void> {
    if (!options.publishMutation) return;
    const note = await repository.findNoteSnapshot(noteId);
    if (!note) return;
    await options.publishMutation({
      kind: "note.updated",
      actorUserId: client.userId,
      actorConnectionId: null,
      note: {
        id: noteId,
        workspaceId: note.workspaceId,
        notebookId: note.notebookId,
        version,
        updatedAt: new Date(note.updatedAt).toISOString(),
        title: note.title,
        contentText,
      },
    });
  }

  async function handleUpdate(
    client: RuntimeClient,
    message: ClientMessage,
    noteId: string,
    sectionId: string,
  ): Promise<void> {
    if (!client.joinedSections.has(roomKey(noteId, sectionId))) {
      send(client.ws, {
        type: "error",
        noteId,
        sectionId,
        code: "SUBDOCUMENT_NOT_JOINED",
        error: "Subdocument section has not been joined",
      });
      return;
    }
    if (!(await canWrite(noteId, client))) {
      send(client.ws, { type: "error", noteId, sectionId, code: "FORBIDDEN", error: "Write permission required" });
      return;
    }
    if (!Number.isInteger(message.generation) || Number(message.generation) < 1) {
      send(client.ws, {
        type: "error",
        noteId,
        sectionId,
        code: "SUBDOCUMENT_GENERATION_REQUIRED",
        error: "Missing generation",
      });
      return;
    }
    try {
      const update = decodeCanonicalBase64(message.update, maxUpdateBytes);
      const persisted = await subdocuments.applyUpdate(
        noteId,
        sectionId,
        update,
        client.userId,
        Number(message.generation),
      );
      updates += 1;
      knownGenerations.set(noteId, persisted.generation);
      const updateBase64 = Buffer.from(update).toString("base64");
      broadcastSection(noteId, sectionId, {
        type: "y:subdoc:update",
        noteId,
        sectionId,
        update: updateBase64,
        version: persisted.version,
        generation: persisted.generation,
        structureVersion: persisted.structureVersion,
        actorConnectionId: client.connectionId,
        actorUserId: client.userId,
      }, client.connectionId);
      send(client.ws, {
        type: "y:subdoc:update-ack",
        noteId,
        sectionId,
        version: persisted.version,
        generation: persisted.generation,
        structureVersion: persisted.structureVersion,
      });
      try {
        await publishNoteMutation(noteId, client, persisted.version, persisted.contentText);
      } catch (publishError) {
        console.warn(
          "[postgres-subdocument-ws] note mutation publish failed:",
          errorMessage(publishError),
        );
      }
    } catch (error) {
      if (
        error instanceof PostgresYjsSubdocumentRuntimeError
        && [
          "SUBDOCUMENT_GENERATION_CONFLICT",
          "SUBDOCUMENT_WRITE_CONFLICT",
          "SUBDOCUMENT_STRUCTURE_CHANGE_PENDING",
        ].includes(error.code)
      ) {
        invalidateNote(
          noteId,
          error.code,
          error.details?.currentManifest as PostgresYjsSubdocumentManifest | undefined,
        );
      }
      sendError(client, error, noteId, sectionId);
    }
  }


  async function handleStructureChange(
    client: RuntimeClient,
    message: ClientMessage,
    noteId: string,
  ): Promise<void> {
    if (!client.joinedNotes.has(noteId)) {
      send(client.ws, {
        type: "error",
        noteId,
        code: "SUBDOCUMENT_NOT_JOINED",
        error: "Join the manifest before changing structure",
      });
      return;
    }
    if (!(await canWrite(noteId, client))) {
      send(client.ws, {
        type: "error",
        noteId,
        code: "FORBIDDEN",
        error: "Write permission required",
      });
      return;
    }
    if (!Number.isInteger(message.generation) || Number(message.generation) < 1) {
      send(client.ws, {
        type: "error",
        noteId,
        code: "SUBDOCUMENT_GENERATION_REQUIRED",
        error: "Missing generation",
      });
      return;
    }
    if (!validId(message.operationId)) {
      send(client.ws, {
        type: "error",
        noteId,
        code: "SUBDOCUMENT_OPERATION_ID_INVALID",
        error: "Missing or invalid operationId",
      });
      return;
    }
    if (typeof message.content !== "string" || message.content.length === 0) {
      send(client.ws, {
        type: "error",
        noteId,
        code: "SUBDOCUMENT_INVALID_CONTENT",
        error: "Missing structure content",
      });
      return;
    }
    const contentBytes = Buffer.byteLength(message.content, "utf8");
    if (contentBytes > maxStructureContentBytes) {
      send(client.ws, {
        type: "error",
        noteId,
        code: "SUBDOCUMENT_STRUCTURE_CONTENT_TOO_LARGE",
        error: `Structure content must not exceed ${maxStructureContentBytes} bytes`,
        details: { maxBytes: maxStructureContentBytes, actualBytes: contentBytes },
      });
      return;
    }

    try {
      const persisted = await subdocuments.applyStructureChange(
        noteId,
        message.content,
        client.userId,
        Number(message.generation),
        message.operationId,
      );
      if (!persisted.replayed) structureChanges += 1;
      knownGenerations.set(noteId, persisted.generation);
      send(client.ws, {
        type: "y:subdoc:structure-ack",
        noteId,
        operationId: persisted.operationId,
        version: persisted.version,
        generation: persisted.generation,
        structureVersion: persisted.structureVersion,
        manifest: persisted.manifest,
        replayed: persisted.replayed,
      });
      invalidateNote(
        noteId,
        persisted.replayed ? "structure-operation-replayed" : "structure-changed",
        persisted.manifest,
      );
      try {
        await publishNoteMutation(noteId, client, persisted.version, persisted.contentText);
      } catch (publishError) {
        console.warn(
          "[postgres-subdocument-ws] structure mutation publish failed:",
          errorMessage(publishError),
        );
      }
    } catch (error) {
      if (
        error instanceof PostgresYjsSubdocumentRuntimeError
        && ["SUBDOCUMENT_GENERATION_CONFLICT", "SUBDOCUMENT_WRITE_CONFLICT"].includes(error.code)
      ) {
        invalidateNote(
          noteId,
          error.code,
          error.details?.currentManifest as PostgresYjsSubdocumentManifest | undefined,
        );
      }
      sendError(client, error, noteId);
    }
  }

  async function handleMessage(client: RuntimeClient, data: RawData): Promise<void> {
    client.lastSeen = Date.now();
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

    const noteId = validId(message.noteId) ? message.noteId : "";
    const sectionId = validId(message.sectionId) ? message.sectionId : "";

    if (message.type === "y:subdoc:join") {
      if (!noteId) {
        send(client.ws, { type: "error", code: "SUBDOCUMENT_NOTE_ID_REQUIRED", error: "Missing noteId" });
        return;
      }
      try {
        await sendState(client, noteId, sectionId || undefined);
      } catch (error) {
        sendError(client, error, noteId, sectionId);
      }
      return;
    }

    if (message.type === "y:subdoc:state") {
      if (!noteId || !sectionId) {
        send(client.ws, {
          type: "error",
          noteId: noteId || null,
          code: "SUBDOCUMENT_SECTION_REQUIRED",
          error: "Missing noteId or sectionId",
        });
        return;
      }
      if (!client.joinedNotes.has(noteId)) {
        send(client.ws, { type: "error", noteId, code: "SUBDOCUMENT_NOT_JOINED", error: "Join the manifest first" });
        return;
      }
      try {
        await sendState(client, noteId, sectionId);
      } catch (error) {
        sendError(client, error, noteId, sectionId);
      }
      return;
    }

    if (message.type === "y:subdoc:leave") {
      if (noteId) removeMembership(client, noteId, sectionId || undefined);
      return;
    }

    if (message.type === "y:subdoc:structure") {
      if (!noteId) {
        send(client.ws, {
          type: "error",
          code: "SUBDOCUMENT_NOTE_ID_REQUIRED",
          error: "Missing noteId",
        });
        return;
      }
      await handleStructureChange(client, message, noteId);
      return;
    }

    if (message.type === "y:subdoc:update") {
      if (!noteId || !sectionId) {
        send(client.ws, {
          type: "error",
          noteId: noteId || null,
          sectionId: sectionId || null,
          code: "SUBDOCUMENT_SECTION_REQUIRED",
          error: "Missing noteId or sectionId",
        });
        return;
      }
      await handleUpdate(client, message, noteId, sectionId);
      return;
    }

    send(client.ws, {
      type: "error",
      noteId: noteId || null,
      sectionId: sectionId || null,
      code: "UNKNOWN_MESSAGE_TYPE",
      error: "Unknown subdocument message type",
    });
  }

  async function handleUpgrade(req: IncomingMessage, socket: any, head: Buffer): Promise<void> {
    try {
      if (!req.url || !wss) return rejectUpgrade(socket, "400 Bad Request");
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const token = url.searchParams.get("token");
      if (!token) return rejectUpgrade(socket);
      const user = await authenticate(token);
      if (!user || !wss) return rejectUpgrade(socket);
      wss.handleUpgrade(req, socket, head, (ws) => {
        const client: RuntimeClient = {
          ws,
          connectionId: randomUUID(),
          userId: user.id,
          username: user.username,
          role: user.role,
          joinedNotes: new Set<string>(),
          joinedSections: new Set<string>(),
          lastSeen: Date.now(),
        };
        clients.set(client.connectionId, client);
        send(ws, {
          type: "connected",
          connectionId: client.connectionId,
          userId: client.userId,
          username: client.username,
          capabilities: [
            "yjs-subdocument-manifest",
            "yjs-subdocument-state",
            "yjs-subdocument-stable-section-write",
            "yjs-subdocument-structure-change",
            "yjs-subdocument-idempotent-structure-operations",
          ],
          pendingCapabilities: [],
        });
        ws.on("message", (raw) => {
          void handleMessage(client, raw).catch((error) => {
            console.warn("[postgres-subdocument-ws] message failed:", errorMessage(error));
            sendError(client, error);
          });
        });
        ws.on("close", () => cleanupClient(client.connectionId));
        ws.on("error", () => cleanupClient(client.connectionId));
      });
    } catch (error) {
      console.warn("[postgres-subdocument-ws] upgrade failed:", errorMessage(error));
      rejectUpgrade(socket);
    }
  }

  function attach(target: Server): void {
    if (server) return;
    server = target;
    wss = new WebSocketServer({ noServer: true });
    capturedUpgradeHandlers = server.listeners("upgrade") as UpgradeHandler[];
    server.removeAllListeners("upgrade");
    dispatcher = (req, socket, head) => {
      let pathname = "";
      try {
        pathname = new URL(req.url || "", `http://${req.headers.host || "localhost"}`).pathname;
      } catch {}
      if (pathname === path) {
        void handleUpgrade(req, socket, head);
        return;
      }
      for (const handler of capturedUpgradeHandlers) handler.call(server, req, socket, head);
    };
    server.on("upgrade", dispatcher);
    heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const [connectionId, client] of clients) {
        if (now - client.lastSeen > clientTimeoutMs) {
          try {
            client.ws.terminate();
          } catch {}
          cleanupClient(connectionId);
        } else {
          send(client.ws, { type: "pong", t: now });
        }
      }
    }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
    console.log(`[postgres-subdocument-ws] stable-section and structure protocol attached at ${path}`);
  }

  async function close(): Promise<void> {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    if (server && dispatcher) {
      server.off("upgrade", dispatcher);
      for (const handler of capturedUpgradeHandlers) server.on("upgrade", handler);
    }
    dispatcher = null;
    capturedUpgradeHandlers = [];
    for (const client of clients.values()) {
      try {
        client.ws.close(1001, "server shutdown");
      } catch {}
    }
    clients.clear();
    noteRooms.clear();
    sectionRooms.clear();
    knownGenerations.clear();
    if (wss) await new Promise<void>((resolve) => wss?.close(() => resolve()));
    wss = null;
    server = null;
  }

  function getStats() {
    let memberships = 0;
    for (const members of sectionRooms.values()) memberships += members.size;
    return {
      attached: Boolean(server),
      clients: clients.size,
      noteRooms: noteRooms.size,
      sectionRooms: sectionRooms.size,
      memberships,
      updates,
      structureChanges,
      invalidations,
    };
  }

  return { attach, close, getStats };
}

export default createPostgresYjsSubdocumentWebsocketRuntime;
