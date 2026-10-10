// backend/src/sync/realtime.ts
//
// 远端变更通知订阅（阶段 L）。
//
// 为什么放在 Embedded Backend 而不是 renderer：
//   Sync Engine 运行在 Backend 内，只有它知道本地游标、Outbox 状态。
//   renderer 的 WebSocket 连的是**本机** Backend（用于协同编辑等），
//   连不到远端同步服务器。因此引擎必须自己订阅远端通知。
//
// 核心约束（对应用户要求的第二十八条）：
//   WebSocket 只是"服务端序号变了"的通知机制，**不是数据来源**。
//   消息丢失绝不能导致数据丢失 —— 周期 Pull 始终作为兜底。
//
// 因此本模块刻意做得很薄：
//   收到任意通知 → 触发一次同步 → 剩下的全交给 Change Feed。
//   不解析 payload、不做增量 apply、不维护自己的序号。

import { logSyncInfo, logSyncWarn } from "./log";

/** 重连退避节奏，与同步引擎保持一致的量级。 */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];

export interface RealtimeSubscriptionOptions {
  /** 远端服务器地址（http/https，内部转成 ws/wss）。 */
  serverUrl: string;
  token: string;
  /**
   * 收到通知时的回调。
   *
   * 只传 sequence 作为诊断信息；调用方**不应**据此跳过拉取 ——
   * 序号可能因消息乱序或丢失而不连续。
   */
  onNotice: (sequence: number) => void;
  /**
   * WebSocket 实现注入点。
   *
   * Node 18+ 有全局 WebSocket，但测试需要可编程的假实现。
   */
  webSocketImpl?: typeof WebSocket;
  /** 调度器注入点，便于测试断言退避而不真的等待。 */
  scheduler?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
}

/**
 * 远端通知订阅。
 *
 * 生命周期与 SyncEngine 绑定：引擎启动时连接，停止时断开。
 * 连接失败不影响同步 —— 周期 Pull 会照常工作，只是延迟略高。
 */
export class SyncRealtimeSubscription {
  private readonly wsUrl: string;
  private readonly token: string;
  private readonly onNotice: (sequence: number) => void;
  private readonly WebSocketImpl: typeof WebSocket;
  private readonly scheduler: NonNullable<RealtimeSubscriptionOptions["scheduler"]>;

  private socket: WebSocket | null = null;
  private timer: unknown = null;
  private attempt = 0;
  private stopped = true;

  constructor(options: RealtimeSubscriptionOptions) {
    const base = options.serverUrl.replace(/\/+$/, "");
    // http → ws、https → wss。直接字符串替换而不是 new URL：
    // 后者对自签名/非标准端口的 NAS 地址容错更差。
    this.wsUrl = `${base.replace(/^http/i, "ws")}/ws`;
    this.token = options.token;
    this.onNotice = options.onNotice;
    this.WebSocketImpl = options.webSocketImpl ?? (globalThis.WebSocket as typeof WebSocket);
    this.scheduler = options.scheduler ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }

  /** 是否已连上。仅供诊断展示，不能用于判断"数据是否已同步"。 */
  get connected(): boolean {
    return this.socket != null && this.socket.readyState === 1;
  }

  start(): void {
    if (!this.WebSocketImpl) {
      // 运行环境没有 WebSocket：直接放弃订阅。
      // 这不是错误 —— 周期 Pull 足以保证最终一致。
      logSyncWarn("realtime.unavailable", { state: "no-websocket" });
      return;
    }
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    if (this.socket) {
      try {
        // 移除监听再关闭：否则 close 事件会触发重连逻辑。
        this.socket.onclose = null;
        this.socket.onerror = null;
        this.socket.onmessage = null;
        this.socket.close();
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.clearTimer();
    const delay = RECONNECT_DELAYS_MS[
      Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)
    ];
    this.attempt += 1;
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  private connect(): void {
    if (this.stopped) return;

    let socket: WebSocket;
    try {
      // token 走 query 而非 header：浏览器与多数 WS 客户端都不支持
      // 在握手时自定义 header，服务端的 WS 认证也是按 query 实现的。
      socket = new this.WebSocketImpl(
        `${this.wsUrl}?token=${encodeURIComponent(this.token)}`,
      );
    } catch (error) {
      logSyncWarn("realtime.connect-failed", {
        errorCode: (error as Error)?.name || "CONNECT_ERROR",
      });
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;

    socket.onopen = () => {
      // 连上就重置退避：长时间在线后偶发断线不该立刻退到 60s。
      this.attempt = 0;
      logSyncInfo("realtime.connected", { state: "open" });
      // 连接建立本身就意味着"可能错过了离线期间的通知"，
      // 因此立即触发一次同步补齐。
      this.onNotice(0);
    };

    socket.onmessage = (event: MessageEvent) => {
      // 只关心"有变更"这一个事实。
      //
      // 刻意不解析业务内容：把正文放进 WS 会绕过 Change Feed 的
      // 权限校验与顺序保证，也让"消息丢失"从"延迟"升级为"数据不一致"。
      let sequence = 0;
      try {
        const data = typeof event.data === "string" ? JSON.parse(event.data) : null;
        if (!data || data.type !== "sync.changed") return;
        sequence = Number(data.sequence) || 0;
      } catch {
        // 解析失败也触发一次同步：宁可多拉一次，不要漏。
        sequence = 0;
      }
      this.onNotice(sequence);
    };

    socket.onerror = () => {
      // 错误详情不记日志：可能包含 URL（含 token）。
      logSyncWarn("realtime.socket-error", { state: "error" });
    };

    socket.onclose = () => {
      this.socket = null;
      if (!this.stopped) this.scheduleReconnect();
    };
  }
}
