/**
 * Local-first + Optional Sync（Sync V2）统一入口。
 *
 * 统一导出协议、Outbox、Bootstrap、引擎、附件、冲突与多 Scope 权限能力。
 * 所有能力在 Flag 关闭时均不被调用，兼容既有部署。
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
  SYNC_WORKSPACE_SCOPE_PREFIX,
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
  listAuthorizedScopes,
  parseSyncScopeKey,
  resolveAuthorizedScope,
  workspaceScopeKey,
} from "./scope";
export type { SyncScopeAccessStatus, SyncScopeDescriptor } from "./scope";

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

// --- Phase 3：Change Feed V2 与服务端 apply ---

export {
  isChangeFeedSuppressed,
  resetChangeFeedSuppression,
  runChangeFeedSuppressed,
} from "./suppression";

export { applyMutation, applyWithoutFeed } from "./apply";
export type { ApplyMutationInput, ApplyMutationResult } from "./apply";

// --- Phase 4：Desktop Sync Engine ---

export { SyncRemoteClient } from "./remote";
export type {
  FetchLike,
  PushMutationPayload,
  PushResultItem,
  RemoteChanges,
  RemoteCredentials,
  RemotePlan,
  RemotePushResult,
  RemoteSnapshotPage,
} from "./remote";

export {
  coalesceMutations,
  isLocalMutationApplied,
  markLocalMutationApplied,
} from "./push";
export type { CoalescedMutation } from "./push";

export { applyRemoteChanges } from "./applyLocal";
export type {
  ApplyLocalOptions,
  ApplyLocalResult,
  RemoteEntityPayload,
} from "./applyLocal";

export { SyncEngine } from "./engine";
export type { SyncEngineOptions, SyncEngineStatus } from "./engine";

// --- Phase 5-12 ---

export {
  applyConflictResolution,
  fillRemotePayload,
  forkConflictVersion,
  toConflictDetail,
} from "./resolve";
export type {
  ConflictDetail,
  ConflictResolution,
  ResolveConflictInput,
} from "./resolve";

export { notifySyncChanged, setSyncBroadcaster } from "./notify";
export type { SyncChangedNotice, UserBroadcaster } from "./notify";

export {
  isLocallyReadable,
  listPendingDownloads,
  listPendingUploads,
  markAttachmentDownloaded,
  markUploadFailed,
  markUploaded,
  markUploading,
  nextUploadDelayMs,
  promoteLocalAttachments,
  recoverStuckUploads,
  registerLocalAttachment,
  registerRemoteAttachment,
  summarizeAttachmentSync,
} from "./attachments";
export type {
  AttachmentSyncRow,
  AttachmentSyncStatus,
  AttachmentSyncSummary,
} from "./attachments";

export {
  PLANNED_SYNC_ENTITIES,
  SYNC_ENTITY_CAPABILITIES,
  WORKSPACE_OFFLINE_BLOCKERS,
  assertEntitySyncReady,
  assertPersonalScopeOnly,
  isEntitySyncReady,
  isWorkspaceOfflineEditingEnabled,
  missingCapabilities,
} from "./entities";
export type { EntityCapability } from "./entities";

// --- 运行时接线 ---

export {
  clearRemoteCredential,
  createRemoteClientForProfile,
  getRemoteCredential,
  hasRemoteCredential,
  saveRemoteCredential,
} from "./credentials";

export {
  getActiveEngine,
  getActiveEngineInfo,
  notifyNetworkOnline,
  reconcileSyncEngine,
  stopSyncEngine,
  triggerSyncNow,
} from "./runtime";

// --- 阶段 A/B/C：身份与队列语义 ---

export {
  disableAllProfiles,
  getActiveProfile,
  switchActiveProfile,
} from "./profile";

export {
  ensureInstallationDevice,
  getInstallationDeviceId,
  listProfileDevices,
} from "./device";

// --- 阶段 D：Bootstrap / Reconcile ---

export {
  getBootstrapProgress,
  isBootstrapReady,
  isLocalEmpty,
  readLocalState,
  reconcile,
  resetBootstrap,
  runBootstrap,
} from "./bootstrap";
export type {
  BootstrapOptions,
  BootstrapProgress,
  BootstrapStatus,
  ReconcilePlan,
} from "./bootstrap";

// --- 阶段 E/H：Lite 迁移与附件二进制 ---

export {
  getLiteMigrationProgress,
  isLiteMigrationComplete,
  resetLiteMigration,
  runLiteMigration,
} from "./liteMigration";
export type {
  LiteMigrationOptions,
  LiteMigrationProgress,
  LiteMigrationStage,
  LiteVerification,
} from "./liteMigration";

export {
  SyncBlobClient,
  pullAttachmentBlobs,
  pushAttachmentBlobs,
} from "./blob";
export type { BlobClientOptions, BlobTransferResult } from "./blob";

export { markBootstrapReady } from "./bootstrap";
export { createBlobClientForProfile } from "./credentials";
export { classifyHttpStatus } from "./errors";

// --- 阶段 L：远端变更通知订阅 ---

export { SyncRealtimeSubscription } from "./realtime";
export type { RealtimeSubscriptionOptions } from "./realtime";
