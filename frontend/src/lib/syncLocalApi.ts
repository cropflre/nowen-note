import { getBaseUrl } from "@/lib/api";

/**
 * Sync V2 本地管理 API 客户端（Phase 7）。
 *
 * 全部打向 localhost 上的 Embedded Backend —— renderer 永远不直接访问
 * Remote Server，Remote URL 只有 Sync Engine 会用。
 *
 * 产品层不暴露 Full / Lite / SQLite / Server Mode 这些实现概念，
 * 用户只需要理解一件事：是否同步。
 */

export type SyncMode = "device-only" | "server";

export interface SyncProfileSummary {
  id: string;
  name: string;
  serverUrl: string;
  enabled: boolean;
  createdAt?: string;
}

export interface SyncSettingsResponse {
  mode: SyncMode;
  activeProfile: SyncProfileSummary | null;
  profiles: SyncProfileSummary[];
}

export interface SyncDiagnostics {
  profileId: string | null;
  serverUrl: string | null;
  deviceId: string | null;
  lastSeenAt: string | null;
  localCursor: number;
  lastSyncAt: string | null;
  lastError: string | null;
  pendingMutations: number;
  conflictCount: number;
  pendingSample: Array<{
    entityType: string;
    entityId: string;
    operation: string;
    status: string;
    retryCount: number;
    lastError: string | null;
    createdAt: string;
  }>;
}

export interface ConflictSummary {
  id: string;
  entityType: string;
  entityId: string;
  localVersion: number | null;
  remoteVersion: number | null;
  createdAt: string;
  diffFields: string[];
  localTitle: string | null;
  remoteTitle: string | null;
}

export interface ConflictDetail extends ConflictSummary {
  status: string;
  resolvedAt: string | null;
  base: Record<string, unknown> | null;
  local: Record<string, unknown> | null;
  remote: Record<string, unknown> | null;
}

export type ConflictResolution = "keep-local" | "keep-remote" | "manual";

/**
 * Sync V2 未启用时后端返回 404。
 *
 * 这不是错误——它是默认状态。调用方应据此隐藏同步 UI，
 * 而不是弹错误提示打扰用户。
 */
export class SyncV2DisabledError extends Error {
  constructor() {
    super("Sync V2 未启用");
    this.name = "SyncV2DisabledError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${getBaseUrl()}/sync/local${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers || {}),
    },
    cache: "no-store",
  });

  if (response.status === 404) {
    let code = "";
    try { code = ((await response.clone().json()) as any)?.code || ""; } catch { /* ignore */ }
    if (code === "SYNC_V2_DISABLED") throw new SyncV2DisabledError();
  }
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const data = await response.json() as any;
      if (data?.error) message = String(data.error);
    } catch { /* 保留默认信息 */ }
    throw new Error(message);
  }
  return await response.json() as T;
}

export function fetchSyncSettings(): Promise<SyncSettingsResponse> {
  return request<SyncSettingsResponse>("/settings");
}

/**
 * 连接到一台 Nowen Server。
 *
 * 后端保证：不会改写既有 Profile 的地址，换服务器一律新建 Profile，
 * 且**不会删除任何本地数据**。
 */
export function connectSyncServer(input: {
  serverUrl: string;
  name?: string;
  remoteUserId?: string;
}): Promise<{ mode: SyncMode; profile: SyncProfileSummary; deviceId: string }> {
  return request("/settings/server", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** 关闭同步。本地数据一个字都不会删除。 */
export function disableSync(): Promise<{
  mode: SyncMode;
  retainedPendingMutations: number;
  message: string;
}> {
  return request("/settings/disable", { method: "POST" });
}

export function fetchSyncDiagnostics(): Promise<SyncDiagnostics> {
  return request<SyncDiagnostics>("/diagnostics");
}

export function fetchConflicts(): Promise<{ total: number; items: ConflictSummary[] }> {
  return request("/conflicts");
}

export function fetchConflictDetail(id: string): Promise<ConflictDetail> {
  return request<ConflictDetail>(`/conflicts/${encodeURIComponent(id)}`);
}

export function resolveConflict(
  id: string,
  input: {
    resolution: ConflictResolution;
    mergedPayload?: Record<string, unknown>;
    deviceId?: string;
  },
): Promise<{ conflictId: string; resolution: ConflictResolution; remainingConflicts: number }> {
  return request(`/conflicts/${encodeURIComponent(id)}/resolve`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * 把冲突的某一方另存为新笔记。
 *
 * 仅在用户显式点击时调用——系统绝不自动生成冲突副本，
 * 那会让知识树被大量重复条目淹没。
 */
export function forkConflict(
  id: string,
  side: "local" | "remote",
  deviceId?: string,
): Promise<{ noteId: string }> {
  return request(`/conflicts/${encodeURIComponent(id)}/fork`, {
    method: "POST",
    body: JSON.stringify({ side, deviceId }),
  });
}
