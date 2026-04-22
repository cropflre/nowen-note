/**
 * Phase 2: 实时协作 WebSocket 客户端
 *
 * 职责：
 *   - 与后端 /ws 建立单例连接（自动重连、指数退避）
 *   - 维护房间订阅，断线重连后自动恢复
 *   - 提供 EventTarget 风格的订阅/广播，业务层用 on()/off() 消费
 *   - 对外暴露 presence/editing/cursor/subscribe 四类客户端消息
 *
 * 设计取舍：
 *   - 不使用 socket.io 等重量级库，自己实现够用即可
 *   - 所有消息走 JSON，不做二进制压缩（20 人规模足够）
 *   - Presence 走服务端权威（Hub 汇总后广播），客户端只发 intent
 */

type Listener = (payload: any) => void;

const WS_PATH = "/ws";
const RECONNECT_MIN_DELAY = 1000;
const RECONNECT_MAX_DELAY = 30_000;
const HEARTBEAT_INTERVAL_MS = 25_000; // 略短于后端 30s，保证活跃

class RealtimeClient {
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private subscribedRooms = new Set<string>();
  private pendingSubs = new Set<string>();
  private connectionId: string | null = null;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private reconnectAttempts = 0;
  private manualClosed = false;
  private connecting = false;
  /** 最近一次 presence intent，重连后自动重放 */
  private lastPresence: { noteId: string | null; editing: boolean } = {
    noteId: null,
    editing: false,
  };

  /**
   * 解析 WebSocket URL：
   *   - 优先用自定义 server URL（nowen-server-url）
   *   - 否则根据当前页面 origin 推断
   */
  private resolveWsUrl(): string | null {
    const token = localStorage.getItem("nowen-token");
    if (!token) return null;

    const serverUrl = localStorage.getItem("nowen-server-url");
    let origin: string;
    if (serverUrl) {
      origin = serverUrl.replace(/\/+$/, "");
    } else if (typeof window !== "undefined") {
      origin = window.location.origin;
    } else {
      return null;
    }
    const wsOrigin = origin.replace(/^http/, "ws");
    return `${wsOrigin}${WS_PATH}?token=${encodeURIComponent(token)}`;
  }

  connect() {
    if (this.connecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) return;
    const url = this.resolveWsUrl();
    if (!url) return;

    this.manualClosed = false;
    this.connecting = true;
    try {
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.addEventListener("open", () => {
        this.connecting = false;
        this.reconnectAttempts = 0;
        // 重订所有房间
        for (const room of this.subscribedRooms) {
          this.sendRaw({ type: "subscribe", room });
        }
        // 重放 presence
        if (this.lastPresence.noteId) {
          this.sendRaw({
            type: "presence",
            noteId: this.lastPresence.noteId,
            editing: this.lastPresence.editing,
          });
        }
        this.startHeartbeat();
        this.emit("open", {});
      });

      ws.addEventListener("message", (ev) => {
        let msg: any;
        try {
          msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
        } catch {
          return;
        }
        if (!msg || typeof msg !== "object") return;
        // connected 是第一个消息，保存 connectionId
        if (msg.type === "connected" && typeof msg.connectionId === "string") {
          this.connectionId = msg.connectionId;
        }
        // 服务器强制踢下线（账号被禁用/删除、密码被重置、会话被吊销）
        // 立即清本地 token 并刷新；emit 出去以便业务层可选择展示 toast。
        if (msg.type === "force-logout") {
          this.emit("force-logout", msg);
          this.manualClosed = true;
          try { this.ws?.close(); } catch {}
          if (typeof window !== "undefined") {
            // L10: 广播给其他 tab 一起下线（这里避免 import api.ts 产生循环依赖，手动内联 broadcast）
            try {
              localStorage.removeItem("nowen-token");
              localStorage.setItem("nowen-logout-broadcast", `${Date.now()}|force-logout`);
              localStorage.removeItem("nowen-logout-broadcast");
            } catch {}
            // 给 UI 一点时间显示 toast（业务层订阅 force-logout 可展示原因）
            setTimeout(() => {
              try { window.location.reload(); } catch {}
            }, 300);
          }
          return;
        }
        this.emit(msg.type, msg);
      });

      ws.addEventListener("close", () => {
        this.connecting = false;
        this.connectionId = null;
        this.stopHeartbeat();
        this.emit("close", {});
        if (!this.manualClosed) this.scheduleReconnect();
      });

      ws.addEventListener("error", () => {
        // onclose 会随后触发，走同一条重连路径
      });
    } catch {
      this.connecting = false;
      this.scheduleReconnect();
    }
  }

  disconnect() {
    this.manualClosed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.subscribedRooms.clear();
    this.pendingSubs.clear();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this.manualClosed) return;
    this.reconnectAttempts++;
    const delay = Math.min(
      RECONNECT_MAX_DELAY,
      RECONNECT_MIN_DELAY * 2 ** Math.min(this.reconnectAttempts, 5),
    );
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      this.sendRaw({ type: "ping" });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private sendRaw(msg: any) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {}
  }

  /** 是否已连接（注意：断线期间也返回 false） */
  isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  getConnectionId(): string | null {
    return this.connectionId;
  }

  /** 订阅房间：note:<id> 或 workspace:<id> */
  subscribe(room: string) {
    if (this.subscribedRooms.has(room)) return;
    this.subscribedRooms.add(room);
    if (this.isOpen()) {
      this.sendRaw({ type: "subscribe", room });
    } else {
      this.connect();
    }
  }

  unsubscribe(room: string) {
    if (!this.subscribedRooms.has(room)) return;
    this.subscribedRooms.delete(room);
    if (this.isOpen()) {
      this.sendRaw({ type: "unsubscribe", room });
    }
  }

  /** 声明当前在看哪篇笔记，是否处于编辑态 */
  setPresence(noteId: string | null, editing = false) {
    this.lastPresence = { noteId, editing };
    if (this.isOpen()) {
      this.sendRaw({ type: "presence", noteId, editing });
    } else {
      this.connect();
    }
  }

  /** 仅更新编辑态（不切换笔记） */
  setEditing(noteId: string, editing: boolean) {
    this.lastPresence = { ...this.lastPresence, editing };
    if (this.isOpen()) {
      this.sendRaw({ type: "editing", noteId, editing });
    }
  }

  sendCursor(noteId: string, cursor: { line?: number; ch?: number; selection?: string }) {
    if (this.isOpen()) {
      this.sendRaw({ type: "cursor", noteId, cursor });
    }
  }

  // -------- Phase 3: Y.js CRDT 消息 --------
  /** 订阅某笔记的 CRDT 房间；返回布尔表示是否已发出（未连通时返回 false，由调用方稍后重试） */
  yJoin(noteId: string): boolean {
    if (!this.isOpen()) {
      this.connect();
      return false;
    }
    this.sendRaw({ type: "y:join", noteId });
    return true;
  }

  yLeave(noteId: string): void {
    if (!this.isOpen()) return;
    this.sendRaw({ type: "y:leave", noteId });
  }

  /** 发送 Y update（二进制 → base64） */
  yUpdate(noteId: string, update: Uint8Array): void {
    if (!this.isOpen()) return;
    this.sendRaw({ type: "y:update", noteId, update: uint8ToBase64(update) });
  }

  /** 发送 awareness update */
  yAwareness(noteId: string, update: Uint8Array): void {
    if (!this.isOpen()) return;
    this.sendRaw({ type: "y:awareness", noteId, update: uint8ToBase64(update) });
  }

  /** P2-#6：双向 sync 第一步——发送本地 stateVector，服务端返回 diff */
  ySyncStep1(noteId: string, stateVector: Uint8Array): void {
    if (!this.isOpen()) return;
    this.sendRaw({
      type: "y:sync-step1",
      noteId,
      stateVector: uint8ToBase64(stateVector),
    });
  }

  // -------- 事件订阅 --------
  on(type: string, listener: Listener): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
    return () => this.off(type, listener);
  }

  off(type: string, listener: Listener) {
    const set = this.listeners.get(type);
    if (set) {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(type);
    }
  }

  private emit(type: string, payload: any) {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const l of set) {
      try { l(payload); } catch (e) { console.error("[realtime] listener error:", e); }
    }
  }
}

// 单例
export const realtime = new RealtimeClient();

// 页面卸载时主动关闭，避免后端堆积连接
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    realtime.disconnect();
  });
}

// --------- Phase 3: Base64 <-> Uint8Array（浏览器环境） ---------
export function uint8ToBase64(u8: Uint8Array): string {
  // 分块避免 call stack overflow（大 update 情况）
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < u8.length; i += CHUNK) {
    const chunk = u8.subarray(i, i + CHUNK);
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

export function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const len = binary.length;
  const u8 = new Uint8Array(len);
  for (let i = 0; i < len; i++) u8[i] = binary.charCodeAt(i);
  return u8;
}
