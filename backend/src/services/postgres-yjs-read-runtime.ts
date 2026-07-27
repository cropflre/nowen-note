import * as Y from "yjs";

import type { DatabaseAdapter } from "../db/adapters/types";

interface SnapshotRow {
  snapshotBlob: unknown;
  updatesMergedTo: number;
}

interface UpdateRow {
  id: number;
  updateBlob: unknown;
}

interface NoteSeedRow {
  content: string | null;
  contentText: string | null;
  contentFormat: string | null;
}

type RoomSource = "snapshot" | "updates" | "seed" | "empty";

interface ReadRoom {
  noteId: string;
  doc: Y.Doc;
  members: Set<string>;
  idleTimer: NodeJS.Timeout | null;
  source: RoomSource;
  replayedUpdates: number;
  loadWarnings: string[];
}

export interface PostgresYjsReadRuntimeOptions {
  idleTimeoutMs?: number;
  maxStateVectorBytes?: number;
  maxAwarenessBytes?: number;
}

export class PostgresYjsReadRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PostgresYjsReadRuntimeError";
  }
}

export interface PostgresYjsReadRuntime {
  join(noteId: string, connectionId: string): Promise<{
    stateBase64: string;
    source: RoomSource;
    replayedUpdates: number;
    warnings: string[];
  }>;
  leave(noteId: string, connectionId: string): void;
  syncStep1(noteId: string, connectionId: string, stateVectorBase64: string): string;
  validateAwareness(noteId: string, connectionId: string, updateBase64: string): string;
  hasJoined(noteId: string, connectionId: string): boolean;
  getMembers(noteId: string): string[];
  closeConnection(connectionId: string): void;
  destroyNote(noteId: string): void;
  close(): Promise<void>;
  getStats(): {
    rooms: number;
    connections: number;
    loadingRooms: number;
    seededRooms: number;
    replayedUpdates: number;
  };
}

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_STATE_VECTOR_BYTES = 64 * 1024;
const DEFAULT_MAX_AWARENESS_BYTES = 256 * 1024;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new PostgresYjsReadRuntimeError("YJS_INVALID_STORED_BINARY", "Stored Yjs binary is invalid");
}

function encodeBase64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function decodeBase64(value: string, maxBytes: number, code: string): Uint8Array {
  const input = typeof value === "string" ? value.trim() : "";
  if (!input || input.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input)) {
    throw new PostgresYjsReadRuntimeError(code, "Invalid base64 payload");
  }
  const buffer = Buffer.from(input, "base64");
  const canonical = buffer.toString("base64").replace(/=+$/u, "");
  if (canonical !== input.replace(/=+$/u, "")) {
    throw new PostgresYjsReadRuntimeError(code, "Invalid base64 payload");
  }
  if (buffer.byteLength > maxBytes) {
    throw new PostgresYjsReadRuntimeError(code, `Payload exceeds ${maxBytes} bytes`);
  }
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function inferSeed(row: NoteSeedRow): string {
  const content = row.content || "";
  const contentText = row.contentText || "";
  const format = row.contentFormat || "markdown";
  if (format === "tiptap-json") return contentText;
  const trimmed = content.trim();
  if (trimmed.startsWith("{") && /"type"\s*:/u.test(trimmed)) return contentText;
  return content || contentText;
}

export function createPostgresYjsReadRuntime(
  adapter: DatabaseAdapter,
  options: PostgresYjsReadRuntimeOptions = {},
): PostgresYjsReadRuntime {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maxStateVectorBytes = options.maxStateVectorBytes ?? DEFAULT_MAX_STATE_VECTOR_BYTES;
  const maxAwarenessBytes = options.maxAwarenessBytes ?? DEFAULT_MAX_AWARENESS_BYTES;
  const rooms = new Map<string, ReadRoom>();
  const loadingRooms = new Map<string, Promise<ReadRoom>>();
  const epochs = new Map<string, number>();
  let closed = false;

  function currentEpoch(noteId: string): number {
    return epochs.get(noteId) ?? 0;
  }

  async function loadRoom(noteId: string): Promise<ReadRoom> {
    const seed = await adapter.queryOne<NoteSeedRow>(
      `SELECT content, "contentText" AS "contentText", "contentFormat" AS "contentFormat"
         FROM notes WHERE id = ?`,
      [noteId],
    );
    if (!seed) {
      throw new PostgresYjsReadRuntimeError("YJS_NOTE_NOT_FOUND", "Note not found");
    }

    const doc = new Y.Doc();
    const warnings: string[] = [];
    let source: RoomSource = "empty";
    let replayedUpdates = 0;
    let mergedTo = 0;

    const snapshot = await adapter.queryOne<SnapshotRow>(
      `SELECT snapshot_blob AS "snapshotBlob", "updatesMergedTo" AS "updatesMergedTo"
         FROM note_ysnapshots WHERE "noteId" = ?`,
      [noteId],
    );
    if (snapshot) {
      mergedTo = Number(snapshot.updatesMergedTo) || 0;
      try {
        Y.applyUpdate(doc, toUint8Array(snapshot.snapshotBlob));
        source = "snapshot";
      } catch (error) {
        warnings.push(`snapshot replay failed: ${errorMessage(error)}`);
        mergedTo = 0;
      }
    }

    const updates = await adapter.queryMany<UpdateRow>(
      `SELECT id, update_blob AS "updateBlob"
         FROM note_yupdates
        WHERE "noteId" = ? AND id > ?
        ORDER BY id ASC`,
      [noteId, mergedTo],
    );
    for (const row of updates) {
      try {
        Y.applyUpdate(doc, toUint8Array(row.updateBlob));
        replayedUpdates += 1;
        if (source === "empty") source = "updates";
      } catch (error) {
        warnings.push(`update ${row.id} replay failed: ${errorMessage(error)}`);
      }
    }

    const ytext = doc.getText("content");
    if (ytext.length === 0) {
      const fallback = inferSeed(seed);
      if (fallback) {
        ytext.insert(0, fallback);
        if (source === "empty") source = "seed";
      }
    }

    return {
      noteId,
      doc,
      members: new Set<string>(),
      idleTimer: null,
      source,
      replayedUpdates,
      loadWarnings: warnings,
    };
  }

  async function getOrLoadRoom(noteId: string): Promise<ReadRoom> {
    if (closed) throw new PostgresYjsReadRuntimeError("YJS_RUNTIME_CLOSED", "Yjs runtime is closed");
    const existing = rooms.get(noteId);
    if (existing) {
      if (existing.idleTimer) {
        clearTimeout(existing.idleTimer);
        existing.idleTimer = null;
      }
      return existing;
    }
    const pending = loadingRooms.get(noteId);
    if (pending) return pending;

    const epoch = currentEpoch(noteId);
    const promise = loadRoom(noteId).then((room) => {
      if (closed || currentEpoch(noteId) !== epoch) {
        room.doc.destroy();
        throw new PostgresYjsReadRuntimeError("YJS_ROOM_INVALIDATED", "Yjs room was invalidated");
      }
      rooms.set(noteId, room);
      return room;
    }).finally(() => {
      if (loadingRooms.get(noteId) === promise) loadingRooms.delete(noteId);
    });
    loadingRooms.set(noteId, promise);
    return promise;
  }

  function scheduleIdleDestroy(room: ReadRoom): void {
    if (room.members.size > 0 || room.idleTimer) return;
    room.idleTimer = setTimeout(() => {
      room.idleTimer = null;
      if (room.members.size > 0 || rooms.get(room.noteId) !== room) return;
      room.doc.destroy();
      rooms.delete(room.noteId);
    }, idleTimeoutMs);
    room.idleTimer.unref?.();
  }

  async function join(noteId: string, connectionId: string) {
    const room = await getOrLoadRoom(noteId);
    if (room.idleTimer) {
      clearTimeout(room.idleTimer);
      room.idleTimer = null;
    }
    room.members.add(connectionId);
    return {
      stateBase64: encodeBase64(Y.encodeStateAsUpdate(room.doc)),
      source: room.source,
      replayedUpdates: room.replayedUpdates,
      warnings: [...room.loadWarnings],
    };
  }

  function leave(noteId: string, connectionId: string): void {
    const room = rooms.get(noteId);
    if (!room) return;
    room.members.delete(connectionId);
    scheduleIdleDestroy(room);
  }

  function requireJoined(noteId: string, connectionId: string): ReadRoom {
    const room = rooms.get(noteId);
    if (!room || !room.members.has(connectionId)) {
      throw new PostgresYjsReadRuntimeError("YJS_NOT_JOINED", "Yjs room has not been joined");
    }
    return room;
  }

  function syncStep1(noteId: string, connectionId: string, stateVectorBase64: string): string {
    const room = requireJoined(noteId, connectionId);
    const stateVector = decodeBase64(
      stateVectorBase64,
      maxStateVectorBytes,
      "YJS_INVALID_STATE_VECTOR",
    );
    try {
      return encodeBase64(Y.encodeStateAsUpdate(room.doc, stateVector));
    } catch (error) {
      throw new PostgresYjsReadRuntimeError(
        "YJS_SYNC_FAILED",
        `Yjs state-vector diff failed: ${errorMessage(error)}`,
      );
    }
  }

  function validateAwareness(noteId: string, connectionId: string, updateBase64: string): string {
    requireJoined(noteId, connectionId);
    return encodeBase64(decodeBase64(
      updateBase64,
      maxAwarenessBytes,
      "YJS_INVALID_AWARENESS",
    ));
  }

  function hasJoined(noteId: string, connectionId: string): boolean {
    return rooms.get(noteId)?.members.has(connectionId) ?? false;
  }

  function getMembers(noteId: string): string[] {
    return Array.from(rooms.get(noteId)?.members ?? []);
  }

  function closeConnection(connectionId: string): void {
    for (const room of rooms.values()) {
      if (!room.members.delete(connectionId)) continue;
      scheduleIdleDestroy(room);
    }
  }

  function destroyNote(noteId: string): void {
    epochs.set(noteId, currentEpoch(noteId) + 1);
    const room = rooms.get(noteId);
    if (!room) return;
    if (room.idleTimer) clearTimeout(room.idleTimer);
    room.doc.destroy();
    rooms.delete(noteId);
  }

  async function close(): Promise<void> {
    closed = true;
    for (const noteId of new Set([...rooms.keys(), ...loadingRooms.keys()])) {
      epochs.set(noteId, currentEpoch(noteId) + 1);
    }
    const pending = Array.from(loadingRooms.values());
    await Promise.allSettled(pending);
    for (const room of rooms.values()) {
      if (room.idleTimer) clearTimeout(room.idleTimer);
      room.doc.destroy();
    }
    rooms.clear();
    loadingRooms.clear();
  }

  function getStats() {
    const connections = new Set<string>();
    let seededRooms = 0;
    let replayedUpdates = 0;
    for (const room of rooms.values()) {
      for (const connectionId of room.members) connections.add(connectionId);
      if (room.source === "seed") seededRooms += 1;
      replayedUpdates += room.replayedUpdates;
    }
    return {
      rooms: rooms.size,
      connections: connections.size,
      loadingRooms: loadingRooms.size,
      seededRooms,
      replayedUpdates,
    };
  }

  return {
    join,
    leave,
    syncStep1,
    validateAwareness,
    hasJoined,
    getMembers,
    closeConnection,
    destroyNote,
    close,
    getStats,
  };
}

export default createPostgresYjsReadRuntime;
