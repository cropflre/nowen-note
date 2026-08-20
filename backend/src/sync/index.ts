/**
 * Local-first + Optional Sync（Sync V2）统一入口。
 *
 * Phase 0 提供契约与基础设施：
 * - flag / types / constants / errors / context / log。
 *
 * Phase 2 追加本地同步状态的读写层（migration v81 建表）：
 * - outbox：mutation 入队，强制与业务写入同事务；
 * - device：稳定 deviceId；
 * - profile：同步关系与拉取游标；
 * - conflict：三方内容台账。
 *
 * 仍未实现真实同步行为（push / pull / apply / engine 在后续 Phase）。
 * 所有能力在 Flag 关闭时均不被调用，现有用户完全无感。
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

// --- Phase 2：本地同步状态读写层 ---

export {
  countPendingMutations,
  enqueueMutation,
  listPendingMutations,
  markMutationFailed,
  markMutationInflight,
  markMutationSynced,
  recoverInflightMutations,
  withMutation,
} from "./outbox";
export type { EnqueueMutationInput } from "./outbox";

export { ensureDevice, getDevice, touchDevice } from "./device";
export type { EnsureDeviceInput } from "./device";

export {
  advanceSyncState,
  createProfile,
  disableProfile,
  findProfileByServer,
  getProfile,
  getSyncState,
  listProfiles,
  recordSyncError,
  resetSyncState,
  setProfileEnabled,
  setProfileRemoteUser,
} from "./profile";
export type { CreateProfileInput } from "./profile";

export {
  countUnresolvedConflicts,
  getConflict,
  listUnresolvedConflicts,
  recordConflict,
  resolveConflict,
} from "./conflict";
export type { RecordConflictInput } from "./conflict";
