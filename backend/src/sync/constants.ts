/**
 * Sync V2 常量。
 *
 * 集中定义协议路径、表名与重试节奏，避免后续 Phase 在多处硬编码字符串
 * 导致 Server 与 Client 对不齐。本文件不含运行时行为。
 */

/**
 * Sync V2 协议前缀。
 *
 * 与 /api/offline-sync（V1）并存：V1 仍被已发布客户端使用，不得改动或摘除。
 */
export const SYNC_V2_BASE_PATH = "/api/sync/v2";

/**
 * 附件二进制通道路径（阶段 H）。
 *
 * 与 metadata 分离：metadata 走 push/pull 的 JSON 协议，
 * 二进制走这里的裸字节流。base64 会膨胀 33%，而附件是同步流量的主要来源。
 */
export const SYNC_V2_BLOB_PATH = `${SYNC_V2_BASE_PATH}/blob`;

/** Sync V2 端点（相对 SYNC_V2_BASE_PATH）。 */
export const SYNC_V2_ROUTES = {
  plan: "/plan",
  push: "/push",
  changes: "/changes",
  ack: "/ack",
  snapshot: "/snapshot",
} as const;

/**
 * 本地同步状态表名（Phase 2 由新增 migration 创建）。
 *
 * 正式同步状态必须落 SQLite：前端 localStorage 版 offlineQueue 无法保证
 * 与业务写入同事务提交，不能作为 Sync Outbox。
 */
export const SYNC_TABLES = {
  profiles: "sync_profiles",
  devices: "sync_devices",
  state: "sync_state",
  outbox: "sync_outbox",
  appliedMutations: "sync_applied_mutations",
  conflicts: "sync_conflicts",
  changesV2: "sync_changes_v2",
} as const;

/**
 * 个人空间作用域键。
 *
 * 第一版只同步个人知识库，Workspace 作用域在 Phase 12 单独设计，
 * 届时复用 V1 的 scope / accessFingerprint 思路。
 */
export const SYNC_PERSONAL_SCOPE_KEY = "personal";

/**
 * 退避重试节奏（毫秒）。
 *
 * 超出数组长度后固定使用最后一档，绝不因为"重试次数用尽"删除 Outbox 条目——
 * 其中可能是用户唯一一份未上传的修改。
 */
export const SYNC_RETRY_BACKOFF_MS = [
  1_000,
  2_000,
  5_000,
  10_000,
  30_000,
  60_000,
  300_000,
] as const;

/** 按重试次数取退避间隔，次数越界时返回最后一档。 */
export function syncRetryDelayMs(retryCount: number): number {
  if (!Number.isFinite(retryCount) || retryCount <= 0) {
    return SYNC_RETRY_BACKOFF_MS[0];
  }
  const index = Math.min(Math.floor(retryCount), SYNC_RETRY_BACKOFF_MS.length - 1);
  return SYNC_RETRY_BACKOFF_MS[index];
}

/** Snapshot 必须分页，避免把整个知识库塞进单个 JSON 响应。 */
export const SYNC_SNAPSHOT_PAGE_SIZE = 200;
export const SYNC_SNAPSHOT_MAX_PAGE_SIZE = 500;

/** 单次 Push 的 mutation 上限，防止超大请求打爆服务端事务。 */
export const SYNC_PUSH_MAX_MUTATIONS = 200;

/** 增量拉取单页上限，与 V1 的 CHANGE_PAGE_SIZE 保持同量级。 */
export const SYNC_CHANGES_PAGE_SIZE = 500;

/** 日志前缀：诊断同步问题时可直接按此过滤。 */
export const SYNC_LOG_PREFIX = "[sync-v2]";
