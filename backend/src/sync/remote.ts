import { SYNC_V2_BASE_PATH, SYNC_V2_ROUTES } from "./constants";
import { SyncError } from "./errors";
import type {
  SyncChangeItem,
  SyncEntityType,
  SyncOperation,
} from "./types";

/**
 * Sync V2 远端客户端。
 *
 * 只负责"把请求打到远端并归类错误"，不碰本地数据库。
 * 之所以严格区分错误类别：Engine 要据此决定是继续重试、暂停同步，
 * 还是进入冲突流程。任何情况下这些失败都不得升级为"保存失败"——
 * 本地写入早已成功。
 */

export interface RemoteCredentials {
  serverUrl: string;
  /** 远端访问令牌。过期时同步暂停，本地读写不受影响。 */
  token: string;
}

export interface RemotePlan {
  serverSequence: number;
  minAvailableSequence: number;
  resetRequired: boolean;
  notebookCount: number;
  noteCount: number;
  tagCount: number;
}

export interface RemoteChanges {
  serverSequence: number;
  nextSequence: number;
  hasMore: boolean;
  resetRequired: boolean;
  items: SyncChangeItem[];
}

export interface RemoteSnapshotPage {
  snapshotSequence: number;
  hasMore: boolean;
  nextCursor: string | null;
  items: Array<{
    entityType: SyncEntityType;
    entityId: string;
    payload: Record<string, unknown>;
  }>;
}

export interface PushMutationPayload {
  mutationId: string;
  entityType: SyncEntityType;
  entityId: string;
  operation: SyncOperation;
  baseVersion?: number;
  payload?: Record<string, unknown>;
}

export interface PushResultItem {
  mutationId: string;
  status: "applied" | "duplicate" | "conflict";
  version?: number;
  code?: string;
  serverVersion?: number;
  error?: string;
}

export interface RemotePushResult {
  serverSequence: number;
  results: PushResultItem[];
}

/** 允许测试注入，避免真实网络。 */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<any>;
  text: () => Promise<string>;
}>;

const DEFAULT_TIMEOUT_MS = 30_000;

function joinUrl(serverUrl: string, route: string, query = ""): string {
  const base = serverUrl.replace(/\/+$/, "");
  return `${base}${SYNC_V2_BASE_PATH}${route}${query}`;
}

export class SyncRemoteClient {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(
    private readonly credentials: RemoteCredentials,
    options: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
  ) {
    this.fetchImpl = options.fetchImpl
      ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * 统一请求入口。
   *
   * 错误分类是这里最重要的职责：
   * - 网络层异常 / 超时 → NETWORK_UNAVAILABLE（可重试）
   * - 401 / 403        → AUTH_EXPIRED（暂停同步，等重新授权）
   * - 404              → 远端未启用 V2，按服务端错误处理，避免误判为"数据不存在"
   * - 5xx              → SERVER_ERROR（可重试）
   * - 其它 4xx         → INVALID_PAYLOAD（重发同样会失败，不该无脑轮询）
   */
  private async request<T>(
    route: string,
    init: { method: string; query?: string; body?: unknown },
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetchImpl(
        joinUrl(this.credentials.serverUrl, route, init.query || ""),
        {
          method: init.method,
          headers: {
            Authorization: `Bearer ${this.credentials.token}`,
            ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: controller.signal,
        },
      );
    } catch (error: any) {
      // AbortError 与 DNS/连接失败都归为网络不可用：都应该继续重试。
      throw new SyncError("NETWORK_UNAVAILABLE", error?.message || "网络请求失败");
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new SyncError("AUTH_EXPIRED", `远端拒绝访问（${response.status}）`);
      }
      if (response.status >= 500 || response.status === 404) {
        throw new SyncError("SERVER_ERROR", `远端返回 ${response.status}`);
      }
      throw new SyncError("INVALID_PAYLOAD", `远端返回 ${response.status}`);
    }

    try {
      return await response.json() as T;
    } catch {
      throw new SyncError("SERVER_ERROR", "远端响应不是合法 JSON");
    }
  }

  plan(after: number): Promise<RemotePlan> {
    return this.request<RemotePlan>(SYNC_V2_ROUTES.plan, {
      method: "GET",
      query: `?after=${encodeURIComponent(String(after))}`,
    });
  }

  changes(after: number, limit?: number): Promise<RemoteChanges> {
    const query = limit
      ? `?after=${encodeURIComponent(String(after))}&limit=${limit}`
      : `?after=${encodeURIComponent(String(after))}`;
    return this.request<RemoteChanges>(SYNC_V2_ROUTES.changes, { method: "GET", query });
  }

  snapshot(cursor: string | null, snapshotSequence: number, limit?: number): Promise<RemoteSnapshotPage> {
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    if (snapshotSequence > 0) params.set("snapshotSequence", String(snapshotSequence));
    if (limit) params.set("limit", String(limit));
    const query = params.toString() ? `?${params.toString()}` : "";
    return this.request<RemoteSnapshotPage>(SYNC_V2_ROUTES.snapshot, { method: "GET", query });
  }

  push(deviceId: string, mutations: PushMutationPayload[]): Promise<RemotePushResult> {
    return this.request<RemotePushResult>(SYNC_V2_ROUTES.push, {
      method: "POST",
      body: { deviceId, mutations },
    });
  }

  ack(deviceId: string, sequence: number): Promise<{ lastSequence: number }> {
    return this.request<{ lastSequence: number }>(SYNC_V2_ROUTES.ack, {
      method: "POST",
      body: { deviceId, sequence },
    });
  }
}
