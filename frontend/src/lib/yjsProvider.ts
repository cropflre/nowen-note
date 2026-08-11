/**
 * Phase 3: Y.js Provider（复用自有 WebSocket 通道）
 * ----------------------------------------------------------------
 * 职责：
 *   1. 维护一个 Y.Doc + Awareness，供 CodeMirror 的 yCollab 扩展绑定
 *   2. 监听 Y.Doc / Awareness 的本地 update，通过 realtime 单例发出
 *   3. 监听 realtime 的 y:* 事件，applyUpdate 回本地 Doc/Awareness
 *   4. IndexedDB 持久化：断网/刷新不丢字；按服务器/用户/笔记隔离
 *   5. 断线后根据服务端 stateVector 自动补传本地缺失 update
 *   6. 每次 update 必须收到服务端持久化 ACK 才能进入 saved 状态
 */

import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import { IndexeddbPersistence } from "y-indexeddb";
import { realtime, base64ToUint8 } from "./realtime";
import {
  createYjsOperationId,
  encodeMissingYjsUpdate,
  isYjsUploadReady,
  YjsDurabilityTracker,
  type YjsDurabilitySnapshot,
  type YjsMarkSentOptions,
} from "./yjsDurability";

export interface ProviderUser {
  userId: string;
  username: string;
  color?: string;
}

export type ProviderStatus = "connecting" | "syncing" | "synced" | "disconnected";
export type ProviderDurabilityState = YjsDurabilitySnapshot;

type Listener = (payload: any) => void;

const MAX_UPDATE_BYTES = 1 * 1024 * 1024;
const MAX_PENDING_UPDATES = 500;
const ACK_TIMEOUT_MS = 12_000;
const YJS_IDB_PREFIX = "nowen-y-v2";

function normalizeScopePart(value: string): string {
  return (value || "unknown").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "").toLowerCase();
}

function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "127.0.0.1"
      || u.hostname === "localhost"
      || u.hostname === "::1"
      || u.hostname === "[::1]";
  } catch {
    return false;
  }
}

function getServerScope(): string {
  let server = "";
  try { server = localStorage.getItem("nowen-server-url") || ""; } catch { /* ignore */ }
  const origin = typeof window !== "undefined" && window.location.origin.startsWith("http")
    ? window.location.origin
    : "";
  const isDesktop = typeof window !== "undefined" && !!(window as any).nowenDesktop?.isDesktop;

  if (isDesktop && ((server && isLoopbackUrl(server)) || (!server && origin && isLoopbackUrl(origin)))) {
    return "local-desktop";
  }
  if (server) return normalizeUrl(server);
  if (origin) return normalizeUrl(origin);
  return "same-origin";
}

function getYjsPersistenceName(noteId: string, userId: string): string {
  return [
    YJS_IDB_PREFIX,
    normalizeScopePart(getServerScope()),
    normalizeScopePart(userId),
    normalizeScopePart(noteId),
  ].join("-");
}

export class NowenYjsProvider {
  readonly noteId: string;
  readonly doc: Y.Doc;
  readonly awareness: Awareness;

  private user: ProviderUser;
  private status: ProviderStatus = "connecting";
  private joined = false;
  private destroyed = false;
  private hasEverSynced = false;

  private listeners = new Map<string, Set<Listener>>();
  private unsubscribers: Array<() => void> = [];

  private idbPersistence: IndexeddbPersistence | null = null;
  private idbSynced = false;
  private serverSynced = false;
  private serverStateVector: Uint8Array | null = null;
  private serverPersistedAt: string | null = null;

  /** Memory queue is only an optimization; IndexedDB + state-vector reconciliation is authoritative. */
  private pendingUpdates: Uint8Array[] = [];
  private durability = new YjsDurabilityTracker();
  private ackTimers = new Map<string, number>();

  constructor(noteId: string, user: ProviderUser, existingDoc?: Y.Doc) {
    this.noteId = noteId;
    this.user = user;
    this.doc = existingDoc || new Y.Doc();
    this.awareness = new Awareness(this.doc);

    this.awareness.setLocalState({
      user: {
        id: user.userId,
        name: user.username,
        color: user.color || stringToColor(user.userId),
      },
    });

    this.bindListeners();
    this.initIndexedDb();

    if (realtime.isOpen()) this.sendJoinAndSync();
    else realtime.connect();
  }

  getStatus(): ProviderStatus {
    return this.status;
  }

  getDurabilityState(): ProviderDurabilityState {
    return this.durability.getSnapshot();
  }

  isSyncedOnce(): boolean {
    return this.hasEverSynced;
  }

  requestResync() {
    if (this.destroyed) return;
    this.clearAllAckTimers();
    this.emitDurability(this.durability.markDisconnected());
    this.sendJoinAndSync();
  }

  on(type: "status" | "synced" | "durability", listener: Listener): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);

    if (type === "synced" && this.hasEverSynced) {
      try { listener(true); } catch { /* ignore */ }
    } else if (type === "durability") {
      try { listener(this.getDurabilityState()); } catch { /* ignore */ }
    }
    return () => set!.delete(listener);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearAllAckTimers();
    try {
      const clientIds = [this.awareness.clientID];
      const update = encodeAwarenessUpdate(this.awareness, clientIds);
      realtime.yAwareness(this.noteId, update);
    } catch { /* ignore */ }
    try { realtime.yLeave(this.noteId); } catch {}
    for (const off of this.unsubscribers) {
      try { off(); } catch {}
    }
    this.unsubscribers = [];
    this.awareness.destroy();
    if (this.idbPersistence) {
      try { this.idbPersistence.destroy(); } catch {}
      this.idbPersistence = null;
    }
  }

  private initIndexedDb() {
    try {
      this.idbPersistence = new IndexeddbPersistence(
        getYjsPersistenceName(this.noteId, this.user.userId),
        this.doc,
      );
      this.idbPersistence.once("synced", () => {
        this.idbSynced = true;
        this.maybePushLocalDiff();
        this.maybeFinalizeSyncedStatus();
      });
    } catch (e) {
      console.warn("[yjs-provider] IndexedDB init failed:", e);
      this.idbPersistence = null;
      this.idbSynced = true;
      this.maybePushLocalDiff();
      this.maybeFinalizeSyncedStatus();
    }
  }

  private isLocalPersistenceReady(): boolean {
    return !this.idbPersistence || this.idbSynced;
  }

  private isUploadReady(): boolean {
    return isYjsUploadReady({
      socketOpen: realtime.isOpen(),
      joined: this.joined,
      serverSynced: this.serverSynced,
      localPersistenceReady: this.isLocalPersistenceReady(),
    });
  }

  private maybeFinalizeSyncedStatus() {
    if (!this.serverSynced || !this.isLocalPersistenceReady()) return;
    this.setStatus("synced");
  }

  private bindListeners() {
    const docUpdateHandler = (update: Uint8Array, origin: any) => {
      if (origin === this) return;
      if (this.idbPersistence && origin === this.idbPersistence) return;

      if (update.byteLength > MAX_UPDATE_BYTES) {
        console.warn(`[yjs-provider] local update too large (${update.byteLength}), preserved locally only`);
        this.emitDurability(this.durability.fail(null, "too_large"));
        return;
      }

      this.emitDurability(this.durability.markLocalChange());
      // During join/rejoin the server baseline or IndexedDB baseline may still be
      // incomplete. Queue edits until both are known, then upload one exact diff.
      if (!this.isUploadReady()) {
        this.enqueuePending(update);
        return;
      }
      this.sendDurableUpdate(update, { localChanges: 1 });
    };
    this.doc.on("update", docUpdateHandler);
    this.unsubscribers.push(() => this.doc.off("update", docUpdateHandler));

    const awarenessUpdateHandler = (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: any,
    ) => {
      if (origin === "remote") return;
      const changedClients = added.concat(updated, removed);
      if (changedClients.length === 0 || !realtime.isOpen()) return;
      try {
        const update = encodeAwarenessUpdate(this.awareness, changedClients);
        realtime.yAwareness(this.noteId, update);
      } catch (e) {
        console.warn("[yjs-provider] awareness encode failed:", e);
      }
    };
    this.awareness.on("update", awarenessUpdateHandler);
    this.unsubscribers.push(() => this.awareness.off("update", awarenessUpdateHandler));

    const offSync = realtime.on("y:sync", (msg: any) => {
      if (msg.noteId !== this.noteId) return;
      if (!msg.state) {
        console.warn(`[yjs-provider] y:sync for ${this.noteId} has no state payload`);
        return;
      }
      if (this.destroyed) return;

      try {
        const state = base64ToUint8(msg.state);
        const serverDoc = new Y.Doc();
        try {
          Y.applyUpdate(serverDoc, state);
          this.serverStateVector = Y.encodeStateVector(serverDoc);
        } finally {
          serverDoc.destroy();
        }
        Y.applyUpdate(this.doc, state, this);
        this.serverSynced = true;
        this.serverPersistedAt = typeof msg.persistedAt === "string"
          ? msg.persistedAt
          : new Date().toISOString();
      } catch (e) {
        console.warn("[yjs-provider] applySync failed:", e);
        this.emitDurability(this.durability.fail(null, "sync_invalid"));
        return;
      }

      // Keep the original server->client diff request for compatibility, then
      // independently send the client->server missing diff after IndexedDB is ready.
      this.sendSyncStep1();
      this.maybePushLocalDiff();
      this.maybeFinalizeSyncedStatus();

      try {
        const update = encodeAwarenessUpdate(this.awareness, [this.awareness.clientID]);
        realtime.yAwareness(this.noteId, update);
      } catch {}
    });
    this.unsubscribers.push(offSync);

    const offStep2 = realtime.on("y:sync-step2", (msg: any) => {
      if (msg.noteId !== this.noteId || !msg.update) return;
      try {
        const update = base64ToUint8(msg.update);
        Y.applyUpdate(this.doc, update, this);
      } catch (e) {
        console.warn("[yjs-provider] applyStep2 failed:", e);
      }
    });
    this.unsubscribers.push(offStep2);

    const offUpdate = realtime.on("y:update", (msg: any) => {
      if (msg.noteId !== this.noteId || !msg.update) return;
      try {
        const update = base64ToUint8(msg.update);
        Y.applyUpdate(this.doc, update, this);
      } catch (e) {
        console.warn("[yjs-provider] applyUpdate failed:", e);
      }
    });
    this.unsubscribers.push(offUpdate);

    const offAck = realtime.on("y:ack", (msg: any) => {
      if (msg.noteId !== this.noteId || typeof msg.operationId !== "string") return;
      this.clearAckTimer(msg.operationId);
      const persistedAt = typeof msg.persistedAt === "string"
        ? msg.persistedAt
        : new Date().toISOString();
      this.emitDurability(this.durability.acknowledge(msg.operationId, persistedAt));
    });
    this.unsubscribers.push(offAck);

    const offAwareness = realtime.on("y:awareness", (msg: any) => {
      if (msg.noteId !== this.noteId || !msg.update) return;
      try {
        const update = base64ToUint8(msg.update);
        applyAwarenessUpdate(this.awareness, update, "remote");
      } catch (e) {
        console.warn("[yjs-provider] applyAwareness failed:", e);
      }
    });
    this.unsubscribers.push(offAwareness);

    const offOpen = realtime.on("open", () => {
      if (!this.destroyed) this.sendJoinAndSync();
    });
    this.unsubscribers.push(offOpen);

    const offClose = realtime.on("close", () => {
      if (this.destroyed) return;
      this.joined = false;
      this.serverSynced = false;
      this.serverStateVector = null;
      this.clearAllAckTimers();
      this.emitDurability(this.durability.markDisconnected());
      this.setStatus("disconnected");
    });
    this.unsubscribers.push(offClose);

    const offError = realtime.on("error", (msg: any) => {
      if (msg.noteId !== this.noteId) return;
      const operationId = typeof msg.operationId === "string" ? msg.operationId : null;
      if (operationId) this.clearAckTimer(operationId);
      const code = typeof msg.code === "string" ? msg.code : "server_error";
      this.emitDurability(this.durability.fail(operationId, code));

      // Transient failures remain recoverable from IndexedDB. Rejoin to compare
      // state vectors and resend only the missing diff. Oversize updates require
      // explicit user action and must not loop forever.
      if (code !== "too_large") {
        window.setTimeout(() => {
          if (!this.destroyed) this.requestResync();
        }, 1_000);
      }
    });
    this.unsubscribers.push(offError);
  }

  private sendJoinAndSync() {
    if (this.destroyed) return;
    this.serverSynced = false;
    this.serverStateVector = null;
    this.setStatus("connecting");
    const ok = realtime.yJoin(this.noteId);
    this.joined = ok;
    if (ok) {
      this.setStatus("syncing");
      const joinedAt = Date.now();
      window.setTimeout(() => {
        if (this.destroyed || this.serverSynced) return;
        console.warn(
          `[yjs-provider] ${this.noteId} waiting for y:sync for ${Date.now() - joinedAt}ms`,
        );
      }, 5_000);
    }
  }

  private sendSyncStep1() {
    if (this.destroyed || !this.joined) return;
    try {
      realtime.ySyncStep1(this.noteId, Y.encodeStateVector(this.doc));
    } catch (e) {
      console.warn("[yjs-provider] sendSyncStep1 failed:", e);
    }
  }

  /**
   * Once both server state and IndexedDB state are loaded, compute the exact
   * client-only diff. This is the recovery path for updates created before a
   * refresh, while offline, or before the previous process received an ACK.
   */
  private maybePushLocalDiff() {
    if (this.destroyed || !this.serverSynced || !this.serverStateVector) return;
    if (!this.isLocalPersistenceReady()) return;

    this.pendingUpdates = [];
    let missing: Uint8Array | null = null;
    try {
      missing = encodeMissingYjsUpdate(this.doc, this.serverStateVector);
    } catch (e) {
      console.warn("[yjs-provider] encode local missing diff failed:", e);
      this.emitDurability(this.durability.fail(null, "diff_failed"));
      return;
    }

    if (missing) {
      // IDB-restored changes do not emit normal local update events. Register a
      // synthetic local unit, then declare that this state-vector diff covers
      // every local-only change known by the tracker.
      this.emitDurability(this.durability.markLocalChange());
      this.sendDurableUpdate(missing, { coversAllLocalChanges: true });
      return;
    }

    this.emitDurability(
      this.durability.markServerBaseline(this.serverPersistedAt || new Date().toISOString()),
    );
  }

  private sendDurableUpdate(
    update: Uint8Array,
    options: YjsMarkSentOptions = { localChanges: 1 },
  ) {
    if (update.byteLength > MAX_UPDATE_BYTES) {
      this.emitDurability(this.durability.fail(null, "too_large"));
      return;
    }
    if (!this.isUploadReady()) {
      this.enqueuePending(update);
      return;
    }

    const operationId = createYjsOperationId(this.noteId);
    this.emitDurability(this.durability.markSent(operationId, options));
    const sent = realtime.yUpdate(this.noteId, update, operationId);
    if (!sent) {
      this.enqueuePending(update);
      this.emitDurability(this.durability.markDisconnected());
      return;
    }

    const timer = window.setTimeout(() => {
      if (!this.ackTimers.has(operationId) || this.destroyed) return;
      this.ackTimers.delete(operationId);
      this.emitDurability(this.durability.fail(operationId, "ack_timeout"));
      this.requestResync();
    }, ACK_TIMEOUT_MS);
    this.ackTimers.set(operationId, timer);
  }

  private enqueuePending(update: Uint8Array) {
    if (this.pendingUpdates.length >= MAX_PENDING_UPDATES) {
      try {
        this.pendingUpdates = [Y.mergeUpdates(this.pendingUpdates)];
      } catch {
        this.pendingUpdates = this.pendingUpdates.slice(-Math.floor(MAX_PENDING_UPDATES / 2));
      }
    }
    this.pendingUpdates.push(update);
  }

  /** Backward-compatible fallback when a server does not provide a usable baseline. */
  private flushPendingUpdates() {
    if (this.pendingUpdates.length === 0 || !this.isUploadReady()) return;
    const representedLocalChanges = this.pendingUpdates.length;
    let payload: Uint8Array;
    try {
      payload = this.pendingUpdates.length === 1
        ? this.pendingUpdates[0]
        : Y.mergeUpdates(this.pendingUpdates);
    } catch (e) {
      console.warn("[yjs-provider] mergeUpdates failed:", e);
      return;
    }
    this.pendingUpdates = [];
    this.sendDurableUpdate(payload, { localChanges: representedLocalChanges });
  }

  private clearAckTimer(operationId: string) {
    const timer = this.ackTimers.get(operationId);
    if (timer != null) window.clearTimeout(timer);
    this.ackTimers.delete(operationId);
  }

  private clearAllAckTimers() {
    for (const timer of this.ackTimers.values()) window.clearTimeout(timer);
    this.ackTimers.clear();
  }

  private emitDurability(snapshot: ProviderDurabilityState) {
    const set = this.listeners.get("durability");
    if (set) for (const listener of set) try { listener(snapshot); } catch {}
  }

  private setStatus(next: ProviderStatus) {
    if (this.status === next) return;
    const prev = this.status;
    this.status = next;
    if (typeof window !== "undefined" && (window as any).__NOWEN_DEBUG_Y__) {
      console.debug(`[yjs-provider] status ${prev} → ${next} for ${this.noteId}`);
    }
    const set = this.listeners.get("status");
    if (set) for (const listener of set) try { listener(next); } catch {}
    if (next === "synced") {
      this.hasEverSynced = true;
      const syncedSet = this.listeners.get("synced");
      if (syncedSet) for (const listener of syncedSet) try { listener(true); } catch {}
    }
  }
}

export function stringToColor(s: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue}, 65%, 55%)`;
}
