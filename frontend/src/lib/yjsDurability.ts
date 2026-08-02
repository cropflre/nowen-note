import * as Y from "yjs";

export type YjsDurabilityStatus = "idle" | "local" | "saving" | "saved" | "error";

export interface YjsDurabilitySnapshot {
  status: YjsDurabilityStatus;
  pendingCount: number;
  dirty: boolean;
  lastPersistedAt: string | null;
  errorCode: string | null;
}

/**
 * Tracks the difference between "the editor has local content" and
 * "the server confirmed that content is durably stored".
 *
 * A WebSocket send is never considered a save. Only a matching y:ack clears
 * dirty state. When the socket drops, pending operations become local-only and
 * are reconciled from the Y.Doc against the server state vector after rejoin.
 */
export class YjsDurabilityTracker {
  private pending = new Set<string>();
  private dirty = false;
  private lastPersistedAt: string | null = null;
  private errorCode: string | null = null;

  getSnapshot(): YjsDurabilitySnapshot {
    let status: YjsDurabilityStatus = "idle";
    if (this.errorCode) status = "error";
    else if (this.pending.size > 0) status = "saving";
    else if (this.dirty) status = "local";
    else if (this.lastPersistedAt) status = "saved";

    return {
      status,
      pendingCount: this.pending.size,
      dirty: this.dirty,
      lastPersistedAt: this.lastPersistedAt,
      errorCode: this.errorCode,
    };
  }

  markLocalChange(): YjsDurabilitySnapshot {
    this.dirty = true;
    this.errorCode = null;
    return this.getSnapshot();
  }

  markSent(operationId: string): YjsDurabilitySnapshot {
    this.pending.add(operationId);
    this.dirty = true;
    this.errorCode = null;
    return this.getSnapshot();
  }

  acknowledge(operationId: string, persistedAt: string): YjsDurabilitySnapshot {
    if (!this.pending.delete(operationId)) return this.getSnapshot();
    this.lastPersistedAt = persistedAt;
    this.errorCode = null;
    if (this.pending.size === 0) this.dirty = false;
    return this.getSnapshot();
  }

  fail(operationId: string | null | undefined, errorCode: string): YjsDurabilitySnapshot {
    if (operationId) this.pending.delete(operationId);
    this.dirty = true;
    this.errorCode = errorCode;
    return this.getSnapshot();
  }

  /** Pending sends are uncertain after disconnect; the document itself remains in IndexedDB. */
  markDisconnected(): YjsDurabilitySnapshot {
    if (this.pending.size > 0) this.dirty = true;
    this.pending.clear();
    this.errorCode = null;
    return this.getSnapshot();
  }

  /** The server state vector proved that the current local document needs no upload. */
  markServerBaseline(persistedAt: string): YjsDurabilitySnapshot {
    this.pending.clear();
    this.dirty = false;
    this.errorCode = null;
    this.lastPersistedAt = persistedAt;
    return this.getSnapshot();
  }
}

export function createYjsOperationId(noteId: string): string {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${noteId}:${random}`;
}

/**
 * Computes exactly the update the server is missing. Yjs encodes an empty diff
 * as a two-byte update, so it is safe to skip payloads of length <= 2.
 */
export function encodeMissingYjsUpdate(
  doc: Y.Doc,
  serverStateVector: Uint8Array,
): Uint8Array | null {
  const update = Y.encodeStateAsUpdate(doc, serverStateVector);
  return update.byteLength <= 2 ? null : update;
}
