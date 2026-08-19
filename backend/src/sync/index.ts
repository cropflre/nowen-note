/**
 * Local-first + Optional Sync（Sync V2）统一入口。
 *
 * Phase 0 只提供契约与基础设施，不含任何运行时同步行为：
 * - flag：总开关，默认关闭，关闭时必须保持 Offline Sync V1 行为不变；
 * - types：本地表行 / 协议 / 引擎状态的共享结构；
 * - constants：路径、表名、退避节奏；
 * - errors：错误分类与可重试判定；
 * - context：outbox 抑制上下文（防同步回环）；
 * - log：结构化安全日志。
 *
 * 后续 Phase 在此目录内补 device / profile / outbox / push / pull / apply /
 * conflict / engine，均不得绕过本模块另立一套契约。
 */

export { isLocalFirstSyncV2Enabled } from "./flag";

export {
  SYNC_ENTITY_TYPES,
  SYNC_OPERATIONS,
  isSyncEntityType,
  isSyncOperation,
} from "./types";

export type {
  SyncAckRequest,
  SyncAppliedMutationRow,
  SyncChangeItem,
  SyncChangesResponse,
  SyncConflictRow,
  SyncConflictStatus,
  SyncDeviceRow,
  SyncEnginePhase,
  SyncEngineState,
  SyncEntityType,
  SyncMutation,
  SyncOperation,
  SyncOutboxRow,
  SyncOutboxStatus,
  SyncProfileRow,
  SyncPushRequest,
  SyncPlanResponse,
  SyncSettings,
  SyncStateRow,
} from "./types";

export {
  SYNC_CHANGES_PAGE_SIZE,
  SYNC_LOG_PREFIX,
  SYNC_PERSONAL_SCOPE_KEY,
  SYNC_PUSH_MAX_MUTATIONS,
  SYNC_RETRY_BACKOFF_MS,
  SYNC_SNAPSHOT_MAX_PAGE_SIZE,
  SYNC_SNAPSHOT_PAGE_SIZE,
  SYNC_TABLES,
  SYNC_V2_BASE_PATH,
  SYNC_V2_ROUTES,
  syncRetryDelayMs,
} from "./constants";

export {
  SYNC_ERROR_CODES,
  SyncError,
  isRetryableSyncError,
  isSyncErrorCode,
} from "./errors";
export type { SyncErrorCode } from "./errors";

export {
  assertNotOutboxSuppressed,
  isOutboxSuppressed,
  runWithOutboxSuppressed,
} from "./context";

export {
  formatSyncLog,
  logSyncError,
  logSyncInfo,
  logSyncWarn,
} from "./log";
export type { SyncLogFields } from "./log";
