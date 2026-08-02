import * as Y from "yjs";

export type YjsDurabilityStatus = "idle" | "local" | "saving" | "saved" | "error";

export interface YjsDurabilitySnapshot {
  status: YjsDurabilityStatus;
  pendingCount: number;
  dirty: boolean;
  lastPersistedAt: string | null;
  errorCode: string | null;
}

export interface YjsMarkSentOptions {
  /** The operation contains the complete client diff against a server state vector. */
  coversAllLocalChanges?: boolean;
  /** Number of individual local updates represented by this operation. */
  localChanges?: number;
}

export interface YjsUploadReadiness {
  socketOpen: boolean;
  joined: boolean;
  serverSynced: boolean;
  localPersistenceReady: boolean;
}

/**
 * Direct Yjs updates may only leave the client after both baselines are known.
 * Sending while IndexedDB is still replaying can let a newer ACK mask older
 * local-only content that has not been included in any operation yet.
 */
export function isYjsUploadReady(input: YjsUploadReadiness): boolean {
  return input.socketOpen
    && input.joined
    && input.serverSynced
    && input.localPersistenceReady;
}

/**
 * Tracks the difference between "the editor has local content" and
 * "the server confirmed that content is durably stored".
 *
 * Local-only changes and in-flight operations are tracked independently. This
 * prevents an ACK for an older operation from clearing a newer update that was
 * never sent (for example because the socket closed or the update was too large).
 */
export class YjsDurabilityTracker {
  /** operationId -> number of local changes represented by that operation */
  private pending = new Map<string, number>();
  private localOnlyChanges = 0;
  private lastPersistedAt: string | null = null;
  private errorCode: string | null = null;

  getSnapshot(): YjsDurabilitySnapshot {
    const dirty = this.localOnlyChanges > 0 || this.pending.size > 0;
    let status: YjsDurabilityStatus = "idle";
    if (this.errorCode) status = "error";
    else if (this.pending.size > 0) status = "saving";
    else if (this.localOnlyChanges > 0) status = "local";
    else if (this.lastPersistedAt) status = "saved";

    return {
      status,
      pendingCount: this.pending.size,
      dirty,
      lastPersistedAt: this.lastPersistedAt,
      errorCode: this.errorCode,
    };
  }

  markLocalChange(count = 1): YjsDurabilitySnapshot {
    this.localOnlyChanges += Math.max(1, Math.floor(count));
    return this.getSnapshot();
  }

  markSent(
    operationId: string,
    options: YjsMarkSentOptions = {},
  ): YjsDurabilitySnapshot {
    const requested = options.coversAllLocalChanges
      ? this.localOnlyChanges
      : Math.max(1, Math.floor(options.localChanges || 1));
    const represented = options.coversAllLocalChanges
      ? Math.max(1, requested)
      : Math.max(1, Math.min(requested, Math.max(1, this.localOnlyChanges)));

    if (options.coversAllLocalChanges) {
      this.localOnlyChanges = 0;
    } else {
      this.localOnlyChanges = Math.max(0, this.localOnlyChanges - represented);
    }
    this.pending.set(operationId, represented);

    // A full reconciliation (or the final direct local update) supersedes a
    // previous transient error. Keep sticky errors while older local-only data remains.
    if (this.localOnlyChanges === 0) this.errorCode = null;
    return this.getSnapshot();
  }

  acknowledge(operationId: string, persistedAt: string): YjsDurabilitySnapshot {
    if (!this.pending.delete(operationId)) return this.getSnapshot();
    this.lastPersistedAt = persistedAt;
    if (this.localOnlyChanges === 0) this.errorCode = null;
    return this.getSnapshot();
  }

  fail(operationId: string | null | undefined, errorCode: string): YjsDurabilitySnapshot {
    if (operationId) {
      const represented = this.pending.get(operationId);
      if (represented != null) {
        this.localOnlyChanges += represented;
        this.pending.delete(operationId);
      }
    } else {
      // The caller observed content that is not represented by a durable operation.
      this.localOnlyChanges += 1;
    }
    this.errorCode = errorCode;
    return this.getSnapshot();
  }

  /** Pending sends are uncertain after disconnect; the document itself remains in IndexedDB. */
  markDisconnected(): YjsDurabilitySnapshot {
    for (const represented of this.pending.values()) {
      this.localOnlyChanges += represented;
    }
    this.pending.clear();
    this.errorCode = null;
    return this.getSnapshot();
  }

  /** The server state vector proved that the current local document needs no upload. */
  markServerBaseline(persistedAt: string): YjsDurabilitySnapshot {
    this.pending.clear();
    this.localOnlyChanges = 0;
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
