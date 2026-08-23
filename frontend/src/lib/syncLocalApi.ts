import { getBaseUrl } from "@/lib/api";
import { fetchWithAuthRefresh, getAccessToken } from "@/lib/authSession";

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
  authorized: boolean;
  authorizationState: "missing" | "ready" | "expired";
  engineRunning: boolean;
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
    scopeKey?: string;
    entityType: string;
    entityId: string;
    operation: string;
    status: string;
    retryCount: number;
    lastError: string | null;
    createdAt: string;
  }>;
  scopes?: SyncScopeStatus[];
}

export interface SyncScopeStatus {
  profileId: string;
  scopeKey: string;
  workspaceId: string | null;
  workspaceName: string | null;
  role: string | null;
  canWrite: 0 | 1;
  accessFingerprint: string;
  accessStatus: "active" | "replan_required" | "access_revoked";
  pendingMutations: number;
  conflictCount: number;
  updatedAt: string;
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

export type SyncLocalAdminAdapter = <T>(path:string,init?:RequestInit)=>Promise<T>;
let nativeAdminAdapter:SyncLocalAdminAdapter|null=null;

export function setSyncLocalAdminAdapter(adapter:SyncLocalAdminAdapter|null):void {
  nativeAdminAdapter=adapter;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if(nativeAdminAdapter)return nativeAdminAdapter<T>(path,init);
  const baseUrl = getBaseUrl();
  const token = getAccessToken();
  const response = await fetchWithAuthRefresh(`${baseUrl}/sync/local${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers || {}),
    },
    cache: "no-store",
  }, baseUrl);

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
  /**
   * 远端访问令牌。
   *
   * 不传时后端只保存服务器信息、不写凭据，引擎会停在"等待授权"状态。
   * 这允许 UI 分两步走：先填地址，再登录换 token。
   */
  token?: string;
}): Promise<{
  mode: SyncMode;
  profile: SyncProfileSummary;
  deviceId: string;
  authorized: boolean;
  engineRunning: boolean;
  message: string;
}> {
  return request("/settings/server", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export type SyncServerLoginResult =
  | {
      requiresTwoFactor: true;
      ticket: string;
      username: string;
    }
  | {
      requiresTwoFactor?: false;
      mode: SyncMode;
      profile: SyncProfileSummary;
      deviceId: string;
      authorized: true;
      engineRunning: boolean;
      bootstrapRequired: boolean;
      message: string;
    };

/** 登录远端账号；密码只用于本次请求，后端仅持久化换得的 Token。 */
export function loginSyncServer(input: {
  serverUrl: string;
  username?: string;
  password?: string;
  ticket?: string;
  code?: string;
}): Promise<SyncServerLoginResult> {
  return request("/settings/server/login", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export interface SyncBootstrapProgress {
  status: "pending" | "preparing" | "pulling" | "reconciling" | "pushing" | "verifying" | "ready" | "failed";
  sequence: number | null;
  cursor: string | null;
  error: string | null;
  pulled: number;
  pushed: number;
  conflicts: number;
  engineRunning?: boolean;
}

export function startSyncBootstrap(): Promise<SyncBootstrapProgress> {
  return request("/bootstrap", { method: "POST" });
}

/** 同步引擎实时状态，供状态指示器轮询（比 diagnostics 轻量得多）。 */
export interface SyncEngineSnapshot {
  running: boolean;
  state: "disabled" | "idle" | "syncing" | "offline" | "error" | "conflict";
  phase?: "pushing" | "pulling" | "applying" | null;
  pendingCount?: number;
  conflictCount?: number;
  lastPushAt?: string | null;
  lastPullAt?: string | null;
  lastError?: string | null;
  /** 恒为 true：本地永远是权威数据源，UI 不应因同步异常显示"保存失败"。 */
  localAuthoritative: boolean;
}

export function fetchSyncEngineStatus(): Promise<SyncEngineSnapshot> {
  return request<SyncEngineSnapshot>("/engine");
}

/**
 * 立即同步一次。
 *
 * engineRunning=false 不是错误：用户可能选择了"仅此设备"，
 * 此时笔记已保存在本机（RULE 2）。
 */
export function triggerSyncNow(): Promise<{
  engineRunning: boolean;
  status?: SyncEngineSnapshot;
  message?: string;
}> {
  return request("/sync-now", { method: "POST" });
}

/**
 * 探测 Sync V2 是否可用。
 *
 * 用于决定是否显示同步入口。Flag 关闭是默认状态，不该显示任何
 * 同步相关 UI，也不该弹错误。
 */
export async function probeSyncV2Available(): Promise<boolean> {
  try {
    await fetchSyncSettings();
    return true;
  } catch (error) {
    if (error instanceof SyncV2DisabledError) return false;
    // 其他错误（网络、500）说明端点存在但出了问题，
    // 仍应显示入口，让用户能看到诊断信息。
    return true;
  }
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

export function fetchSyncScopes(): Promise<{ items: SyncScopeStatus[] }> {
  return request("/scopes");
}

export function exportSyncScope(scopeKey: string): Promise<Record<string, unknown>> {
  return request(`/scopes/${encodeURIComponent(scopeKey)}/export`);
}

export function copySyncScopeToPersonal(scopeKey: string): Promise<{
  copied: { notebooks: number; notes: number; attachments: number; tasks: number };
  message: string;
}> {
  return request(`/scopes/${encodeURIComponent(scopeKey)}/copy-to-personal`, {
    method: "POST",
  });
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
