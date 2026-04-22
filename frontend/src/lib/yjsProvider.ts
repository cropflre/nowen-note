/**
 * Phase 3: Y.js Provider（复用自有 WebSocket 通道）
 * ----------------------------------------------------------------
 * 职责：
 *   1. 维护一个 Y.Doc + Awareness，供 CodeMirror 的 yCollab 扩展绑定
 *   2. 监听 Y.Doc / Awareness 的本地 update，通过 realtime 单例发出
 *   3. 监听 realtime 的 y:* 事件，applyUpdate 回本地 Doc/Awareness
 *   4. P1-#1 IndexedDB 持久化：断网/刷新不丢字
 *   5. P1-#5 pending 队列：WS 断开期间产生的 update 缓存，重连后批量发送
 *   6. P2-#6 双向 sync：join 后发 stateVector 给服务端，换取服务端侧的 diff
 *
 * 生命周期：
 *   - new NowenYjsProvider(noteId, user) → 连通后 y:join → y:sync-step1
 *   - destroy() → 发 y:leave + 清理 listener + 关闭 IndexedDB（可选）
 */

import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import { IndexeddbPersistence } from "y-indexeddb";
import { realtime } from "./realtime";
import { base64ToUint8 } from "./realtime";

export interface ProviderUser {
  userId: string;
  username: string;
  color?: string;
}

export type ProviderStatus = "connecting" | "syncing" | "synced" | "disconnected";

type Listener = (payload: any) => void;

/** P1-#10 对齐后端：前端也设一个上限，避免无意义的请求 */
const MAX_UPDATE_BYTES = 1 * 1024 * 1024;
/** P1-#5 pending 队列最大条数，溢出合并 */
const MAX_PENDING_UPDATES = 500;

export class NowenYjsProvider {
  readonly noteId: string;
  readonly doc: Y.Doc;
  readonly awareness: Awareness;

  private user: ProviderUser;
  private status: ProviderStatus = "connecting";
  private joined = false;
  private destroyed = false;
  /**
   * 幂等 synced 标记：一旦进入过 synced 状态就永久为 true。
   * 作用：消除"订阅 synced 事件时已经 synced"的时序漏洞——
   *   订阅者在 `on("synced", ...)` 之后，若本 flag 已为 true，立即补发一次回调。
   * 这是比 useYDoc 那层 backfill 更彻底的保险：覆盖任何订阅时机。
   */
  private hasEverSynced = false;

  private listeners = new Map<string, Set<Listener>>();
  private unsubscribers: Array<() => void> = [];

  /** P1-#1 IndexedDB 持久化层 */
  private idbPersistence: IndexeddbPersistence | null = null;
  private idbSynced = false;

  /** P1-#5 WS 断开期间积累的 update（Uint8Array 原始二进制） */
  private pendingUpdates: Uint8Array[] = [];

  constructor(noteId: string, user: ProviderUser, existingDoc?: Y.Doc) {
    this.noteId = noteId;
    this.user = user;
    this.doc = existingDoc || new Y.Doc();
    // Y.Doc 的 clientID 默认随机（Math.floor(Math.random() * max)），无需手动设置——
    // P0-#4：不要把 userId 哈希成 clientID，那会让多标签页的 clientID 相同。
    this.awareness = new Awareness(this.doc);

    // 设置本地 awareness state（用户颜色/名字）
    this.awareness.setLocalState({
      user: {
        id: user.userId,
        name: user.username,
        color: user.color || stringToColor(user.userId),
      },
    });

    this.bindListeners();
    this.initIndexedDb();

    // 若已连通立刻 join，否则会在 open 事件触发时补发
    if (realtime.isOpen()) {
      this.sendJoinAndSync();
    } else {
      realtime.connect();
    }
  }

  getStatus(): ProviderStatus {
    return this.status;
  }

  /** 是否曾经完成过一次 synced（幂等）。UI 应据此判定"能否安全读 yDoc"。 */
  isSyncedOnce(): boolean {
    return this.hasEverSynced;
  }

  on(type: "status" | "synced", listener: Listener): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
    // 幂等回放：订阅 synced 事件时若已经同步过，立即补发一次
    if (type === "synced" && this.hasEverSynced) {
      try { listener(true); } catch { /* ignore */ }
    }
    return () => set!.delete(listener);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      // 通知对端：本端退出 awareness
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
    // 关闭 IndexedDB（保留数据，只释放连接）
    if (this.idbPersistence) {
      try { this.idbPersistence.destroy(); } catch {}
      this.idbPersistence = null;
    }
    // 注意：Y.Doc 通常由调用方创建并持有，不在这里 destroy，避免重复使用时崩溃
  }

  // ------------------------------------------------------------
  // P1-#1 IndexedDB 持久化
  // ------------------------------------------------------------

  private initIndexedDb() {
    try {
      // IndexedDB 的 name 不能包含笔记ID之外的太多噪音，用固定前缀 + noteId
      this.idbPersistence = new IndexeddbPersistence(`nowen-y-${this.noteId}`, this.doc);
      this.idbPersistence.once("synced", () => {
        this.idbSynced = true;
        // IDB 里可能有"本地新增但尚未 push 到服务端"的 update；如果此时 WS 已通，触发一次 sync-step1
        if (realtime.isOpen() && this.joined) {
          this.sendSyncStep1();
        }
      });
    } catch (e) {
      console.warn("[yjs-provider] IndexedDB init failed:", e);
      this.idbPersistence = null;
    }
  }

  // ------------------------------------------------------------
  // 内部：事件绑定
  // ------------------------------------------------------------

  private bindListeners() {
    // 本地 Y.Doc update → 发到服务端（或缓存到 pending）
    const docUpdateHandler = (update: Uint8Array, origin: any) => {
      // origin 是 this 时表示是从服务端 apply 回来的，不回发
      // origin 是 idbPersistence（IDB 首次加载）时也不回发——等 synced 后统一 sync-step1
      if (origin === this) return;
      if (this.idbPersistence && origin === this.idbPersistence) return;
      if (update.byteLength > MAX_UPDATE_BYTES) {
        console.warn(`[yjs-provider] local update too large (${update.byteLength}), dropped`);
        return;
      }
      if (!realtime.isOpen() || !this.joined) {
        // P1-#5 积压到 pending
        this.enqueuePending(update);
        return;
      }
      realtime.yUpdate(this.noteId, update);
    };
    this.doc.on("update", docUpdateHandler);
    this.unsubscribers.push(() => this.doc.off("update", docUpdateHandler));

    // 本地 Awareness update → 发到服务端
    const awarenessUpdateHandler = (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: any,
    ) => {
      if (origin === "remote") return;
      const changedClients = added.concat(updated, removed);
      if (changedClients.length === 0) return;
      if (!realtime.isOpen()) return;
      try {
        const update = encodeAwarenessUpdate(this.awareness, changedClients);
        realtime.yAwareness(this.noteId, update);
      } catch (e) {
        console.warn("[yjs-provider] awareness encode failed:", e);
      }
    };
    this.awareness.on("update", awarenessUpdateHandler);
    this.unsubscribers.push(() => this.awareness.off("update", awarenessUpdateHandler));

    // realtime 事件：y:sync（初次全量同步）
    const offSync = realtime.on("y:sync", (msg: any) => {
      // 诊断日志：用于排查 "collabSynced 永远 false" 的死状态
      // noteId 不匹配是正常的（同一 realtime 单例被多个 provider 共享）
      if (msg.noteId !== this.noteId) {
        if (typeof window !== "undefined" && (window as any).__NOWEN_DEBUG_Y__) {
          console.debug(
            `[yjs-provider] y:sync ignored (noteId mismatch): got=${msg.noteId}, me=${this.noteId}`,
          );
        }
        return;
      }
      if (!msg.state) {
        console.warn(
          `[yjs-provider] y:sync for ${this.noteId} has no state payload, staying in syncing`,
          msg,
        );
        return;
      }
      if (this.destroyed) {
        console.warn(
          `[yjs-provider] y:sync arrived AFTER destroy for ${this.noteId}`,
        );
        return;
      }
      console.debug(`[yjs-provider] y:sync OK for ${this.noteId}, applying state & entering synced`);
      try {
        const state = base64ToUint8(msg.state);
        Y.applyUpdate(this.doc, state, this);
      } catch (e) {
        console.warn("[yjs-provider] applySync failed:", e);
      }
      // 全量同步完后，若本地有服务端未见过的 update（IDB 恢复的），需要 sync-step1 让服务端主动获取
      // 我们采用更简单的双向：本地 update listener 已经在 apply 时 echo 到服务端
      //   → 这里只需立刻发一次 sync-step1 请求 missing diff
      this.sendSyncStep1();
      // 同时 flush pending
      this.flushPendingUpdates();
      this.setStatus("synced");
      // 同步完毕后发一次本端 awareness 让别人看到自己
      try {
        const update = encodeAwarenessUpdate(this.awareness, [this.awareness.clientID]);
        realtime.yAwareness(this.noteId, update);
      } catch {}
    });
    this.unsubscribers.push(offSync);

    // P2-#6：y:sync-step2（服务端返回的增量，客户端 apply）
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

    // 远程 y:update（其它客户端的增量）
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

    // 连接恢复后重新 join（服务端会再次发 y:sync）
    const offOpen = realtime.on("open", () => {
      if (this.destroyed) return;
      this.sendJoinAndSync();
    });
    this.unsubscribers.push(offOpen);

    const offClose = realtime.on("close", () => {
      if (this.destroyed) return;
      this.joined = false;
      this.setStatus("disconnected");
    });
    this.unsubscribers.push(offClose);

    // 服务端返回的 error 事件——如果是 too_large 给出反馈
    const offError = realtime.on("error", (msg: any) => {
      if (msg.noteId !== this.noteId) return;
      if (msg.code === "too_large") {
        console.warn(`[yjs-provider] server rejected oversize update for ${this.noteId}`);
      }
    });
    this.unsubscribers.push(offError);
  }

  private sendJoinAndSync() {
    if (this.destroyed) return;
    this.setStatus("connecting");
    const ok = realtime.yJoin(this.noteId);
    this.joined = ok;
    if (ok) {
      console.debug(`[yjs-provider] y:join sent for ${this.noteId}, waiting for y:sync`);
      // y:sync 会由服务端自动推送；此处不需额外动作
      this.setStatus("syncing");
      // 诊断：5 秒后仍未 synced 就告警，便于发现"死状态"
      const joinedAt = Date.now();
      window.setTimeout(() => {
        if (this.destroyed || this.hasEverSynced) return;
        console.warn(
          `[yjs-provider] ⚠️ STUCK: ${this.noteId} has been waiting for y:sync for ${Date.now() - joinedAt}ms (still in status="${this.status}"). ` +
          `Possible causes: (1) backend never replied y:sync, (2) WS message lost, (3) realtime event dispatcher dropped the message. ` +
          `Set window.__NOWEN_DEBUG_Y__=true and open DevTools → Network → WS → Messages to inspect frames.`,
        );
      }, 5000);
    } else {
      console.warn(
        `[yjs-provider] y:join NOT sent (realtime not open) for ${this.noteId}; will retry on 'open' event`,
      );
    }
  }

  /** 发送本地 stateVector，请求服务端侧的 diff（双向 sync 必要步骤） */
  private sendSyncStep1() {
    if (this.destroyed || !this.joined) return;
    try {
      const sv = Y.encodeStateVector(this.doc);
      realtime.ySyncStep1(this.noteId, sv);
    } catch (e) {
      console.warn("[yjs-provider] sendSyncStep1 failed:", e);
    }
  }

  // ------------------------------------------------------------
  // P1-#5 pending 队列
  // ------------------------------------------------------------

  private enqueuePending(update: Uint8Array) {
    // 溢出保护：超过上限时把老的合并成一个（Y.js 支持 mergeUpdates）
    if (this.pendingUpdates.length >= MAX_PENDING_UPDATES) {
      try {
        const merged = Y.mergeUpdates(this.pendingUpdates);
        this.pendingUpdates = [merged];
      } catch {
        // 合并失败就丢弃老的，至少保留最近的
        this.pendingUpdates = this.pendingUpdates.slice(-MAX_PENDING_UPDATES / 2);
      }
    }
    this.pendingUpdates.push(update);
  }

  private flushPendingUpdates() {
    if (this.pendingUpdates.length === 0) return;
    if (!realtime.isOpen() || !this.joined) return;
    // 合并成一条发送，减少 frame 数
    let payload: Uint8Array;
    try {
      payload = this.pendingUpdates.length === 1
        ? this.pendingUpdates[0]
        : Y.mergeUpdates(this.pendingUpdates);
    } catch (e) {
      console.warn("[yjs-provider] mergeUpdates failed:", e);
      // 降级：逐条发送
      for (const u of this.pendingUpdates) {
        if (u.byteLength <= MAX_UPDATE_BYTES) {
          realtime.yUpdate(this.noteId, u);
        }
      }
      this.pendingUpdates = [];
      return;
    }
    if (payload.byteLength > MAX_UPDATE_BYTES) {
      // 合并后仍然超限——这不应该发生，丢弃并记录
      console.warn(
        `[yjs-provider] merged pending payload too large (${payload.byteLength}), dropped`,
      );
      this.pendingUpdates = [];
      return;
    }
    realtime.yUpdate(this.noteId, payload);
    this.pendingUpdates = [];
  }

  private setStatus(next: ProviderStatus) {
    if (this.status === next) return;
    const prev = this.status;
    this.status = next;
    if (typeof window !== "undefined" && (window as any).__NOWEN_DEBUG_Y__) {
      console.debug(
        `[yjs-provider] status ${prev} → ${next} for ${this.noteId}`,
      );
    }
    const set = this.listeners.get("status");
    if (set) for (const l of set) try { l(next); } catch {}
    if (next === "synced") {
      this.hasEverSynced = true;
      console.debug(`[yjs-provider] emitting 'synced' event for ${this.noteId} (listener count=${this.listeners.get("synced")?.size ?? 0})`);
      const syncedSet = this.listeners.get("synced");
      if (syncedSet) for (const l of syncedSet) try { l(true); } catch {}
    }
  }
}

// ---- P3-#15 工具：用户 id → 稳定颜色（HSL，无限不撞色） ----
export function stringToColor(s: string): string {
  // 32-bit FNV-1a，比简单乘加分布更均匀
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  const hue = hash % 360;
  // 固定饱和度/明度，保证暗色/亮色背景都可读
  return `hsl(${hue}, 65%, 55%)`;
}
