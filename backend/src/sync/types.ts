/**
 * Sync V2 共享契约。
 *
 * 本文件只描述结构，不含任何运行时行为，供后续 Phase 共同引用：
 * - 本地表行类型对应 Local SQLite 的 sync_* 表（Phase 2 落库）；
 * - Protocol 类型对应 /api/sync/v2 的请求与响应（Phase 3 实现）；
 * - Engine 状态对应桌面端同步引擎状态机（Phase 4 实现）。
 *
 * 约定：数据库列为 TEXT 的 JSON 字段在行类型中保持 string，
 * 仅在协议类型中以结构化对象出现，避免序列化边界被隐式跨越。
 */

// ---------------------------------------------------------------------------
// 实体与操作
// ---------------------------------------------------------------------------

/**
 * 第一版同步实体范围，严格限定个人空间核心笔记数据。
 * Task / Diary / MindMap / Workspace 等在后续 Phase 单独接入，
 * 每次扩张都必须补齐 Local CRUD → Outbox → Push → Change Feed → Pull → Apply → Conflict 全链路。
 */
export const SYNC_ENTITY_TYPES = [
  // 第一版：个人知识库核心
  "notebook",
  "note",
  "tag",
  "note_tag",
  "favorite",
  "attachment",
  // 阶段 J：其余个人数据。
  //
  // 每类的冲突策略不同，不能一律套用 note 的 baseVersion 逻辑：
  //   task           可变结构化对象 —— 有 updatedAt 可比，字段级差异都算冲突
  //   task_reminder  时间型附属实体 —— 依附 task，用确定性 upsert
  //   diary          追加型记录     —— 只有 createdAt，内容极少被改
  //   mindmap        版本化文档     —— data 是整份 JSON，必须防覆盖
  "task",
  "task_reminder",
  "diary",
  "mindmap",
] as const;

export type SyncEntityType = (typeof SYNC_ENTITY_TYPES)[number];

export function isSyncEntityType(value: unknown): value is SyncEntityType {
  return typeof value === "string"
    && (SYNC_ENTITY_TYPES as readonly string[]).includes(value);
}

/**
 * 同步操作语义。
 *
 * note_tag / favorite 这类关系型数据的 attach / detach / add / remove
 * 统一表达为 upsert / delete，依赖 mutationId 保证幂等，不额外引入操作类型。
 */
export const SYNC_OPERATIONS = ["upsert", "delete"] as const;

export type SyncOperation = (typeof SYNC_OPERATIONS)[number];

export function isSyncOperation(value: unknown): value is SyncOperation {
  return typeof value === "string"
    && (SYNC_OPERATIONS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// 同步设置
// ---------------------------------------------------------------------------

/**
 * 底层数据模式永远是 LOCAL，"仅此设备" 与 "多设备同步" 只是本开关的两种取值，
 * 业务代码不得出现 device_only / multi_device 之类的数据源分支。
 */
export interface SyncSettings {
  enabled: boolean;
  activeProfileId?: string;
}

// ---------------------------------------------------------------------------
// 本地表行类型（Local SQLite）
// ---------------------------------------------------------------------------

/** 一个远端服务器对应一份同步关系，切换服务器必须新建 Profile 而非改写 serverUrl。 */
export interface SyncProfileRow {
  id: string;
  name: string;
  serverUrl: string;
  remoteUserId: string | null;
  /** SQLite 布尔列 */
  enabled: 0 | 1;
  createdAt: string;
  updatedAt: string;
}

/** deviceId 首次生成后永久保存，不得随进程启动重新生成。 */
export interface SyncDeviceRow {
  id: string;
  profileId: string;
  deviceName: string | null;
  platform: string | null;
  createdAt: string;
  lastSeenAt: string | null;
}

/** 按 (profileId, scopeKey) 记录拉取游标。 */
export interface SyncStateRow {
  profileId: string;
  scopeKey: string;
  lastSequence: number;
  lastSyncAt: string | null;
  lastError: string | null;
}

/**
 * Outbox 状态。
 *
 * 无论重试多少次都不存在 "丢弃" 终态：失败条目保持可重试，
 * 因为其中可能是用户尚未上传的修改。
 */
export type SyncOutboxStatus = "pending" | "inflight" | "failed";

/** 业务写入与 Outbox 写入必须在同一事务内提交，禁止 "保存成功但没写 Outbox"。 */
export interface SyncOutboxRow {
  id: string;
  mutationId: string;
  /** 尚未绑定同步关系时为空，便于关闭同步期间仍然记录变更 */
  profileId: string | null;
  deviceId: string;
  entityType: SyncEntityType;
  entityId: string;
  operation: SyncOperation;
  baseVersion: number | null;
  /** JSON 字符串，delete 操作可为空 */
  payload: string | null;
  status: SyncOutboxStatus;
  retryCount: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
}

/** 幂等台账：同一 mutationId 重复到达只执行一次。 */
export interface SyncAppliedMutationRow {
  mutationId: string;
  deviceId: string;
  appliedAt: string;
}

export type SyncConflictStatus = "unresolved" | "resolved";

/** 冲突必须完整保留三方内容，禁止 Last Write Wins 静默覆盖正文。 */
export interface SyncConflictRow {
  id: string;
  profileId: string;
  entityType: SyncEntityType;
  entityId: string;
  localVersion: number | null;
  remoteVersion: number | null;
  /** 以下三者均为 JSON 字符串 */
  basePayload: string | null;
  localPayload: string | null;
  remotePayload: string | null;
  status: SyncConflictStatus;
  createdAt: string;
  resolvedAt: string | null;
}

// ---------------------------------------------------------------------------
// Engine 状态机
// ---------------------------------------------------------------------------

export type SyncEngineState =
  | "disabled"
  | "idle"
  | "syncing"
  | "offline"
  | "error"
  | "conflict";

export type SyncEnginePhase = "pushing" | "pulling" | "applying";

// ---------------------------------------------------------------------------
// Protocol V2（/api/sync/v2）
// ---------------------------------------------------------------------------

/** GET /api/sync/v2/plan */
export interface SyncPlanResponse {
  serverSequence: number;
  /** 服务端仍可增量供给的最小序号，游标早于此值需回退到 snapshot */
  minAvailableSequence: number;
  resetRequired: boolean;
}

export interface SyncMutation {
  mutationId: string;
  entityType: SyncEntityType;
  entityId: string;
  operation: SyncOperation;
  baseVersion?: number;
  /** 结构化载荷，delete 操作可省略 */
  payload?: Record<string, unknown>;
}

/** POST /api/sync/v2/push */
export interface SyncPushRequest {
  deviceId: string;
  mutations: SyncMutation[];
}

export interface SyncChangeItem {
  sequence: number;
  entityType: SyncEntityType;
  entityId: string;
  operation: SyncOperation;
}

/** GET /api/sync/v2/changes?after= */
export interface SyncChangesResponse {
  serverSequence: number;
  items: SyncChangeItem[];
}

/** POST /api/sync/v2/ack */
export interface SyncAckRequest {
  deviceId: string;
  sequence: number;
}
