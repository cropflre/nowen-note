import type Database from "better-sqlite3";
import {
  SYNC_PERSONAL_SCOPE_KEY,
  SYNC_PUSH_MAX_MUTATIONS,
  syncRetryDelayMs,
} from "./constants";
import { SyncError, isRetryableSyncError, isSyncErrorCode } from "./errors";
import {
  pullAttachmentBlobs,
  pushAttachmentBlobs,
  type SyncBlobClient,
} from "./blob";
import { logSyncError, logSyncInfo, logSyncWarn } from "./log";
import {
  advanceSyncState,
  getProfile,
  getSyncState,
  recordSyncError,
  resetSyncState,
} from "./profile";
import {
  countPendingMutations,
  listPendingMutations,
  markMutationFailed,
  markMutationInflight,
  markMutationSynced,
  recoverInflightMutations,
} from "./outbox";
import { coalesceMutations, markLocalMutationApplied } from "./push";
import { applyRemoteChanges } from "./applyLocal";
import type { RemoteEntityPayload } from "./applyLocal";
import { recordConflict } from "./conflict";
import { countUnresolvedConflicts } from "./conflict";
import type { SyncRemoteClient } from "./remote";
import type { SyncEnginePhase, SyncEngineState } from "./types";
import type { SyncScopeDescriptor } from "./scope";
import {
  listWorkspaceScopeStates,
  markWorkspaceScopeActive,
  markWorkspaceScopeRevoked,
  refreshWorkspaceScopeStates,
} from "./workspaceScopes";
import { runWithOutboxSuppressed } from "./context";
import { runChangeFeedSuppressed } from "./suppression";

/**
 * Desktop Sync Engine。
 *
 * 运行在 Embedded Backend 内，不在 React renderer 里——
 * renderer 永远只访问 localhost，Remote URL 只有本引擎会用。
 *
 * 一轮同步的顺序固定为 Push → Pull → Apply → ACK：
 * 先把本地修改推上去，再拉远端变更，这样本地内容不会被自己的旧版本覆盖。
 *
 * 状态机：
 *   disabled  未配置或用户关闭同步
 *   idle      空闲，等待下一轮
 *   syncing   正在同步（细分 pushing / pulling / applying）
 *   offline   网络不可用，Outbox 原样保留
 *   error     远端异常或授权失效，同步暂停但本地完全可用
 *   conflict  存在未解决冲突，需要用户介入
 */

export interface SyncEngineStatus {
  state: SyncEngineState;
  phase: SyncEnginePhase | null;
  profileId: string | null;
  deviceId: string | null;
  localCursor: number;
  remoteSequence: number;
  pendingMutations: number;
  conflictCount: number;
  lastPushAt: string | null;
  lastPullAt: string | null;
  lastError: string | null;
  retryCount: number;
  scopes: ReturnType<typeof listWorkspaceScopeStates>;
}

export interface SyncEngineOptions {
  db: Database.Database;
  profileId: string;
  deviceId: string;
  userId: string;
  client: SyncRemoteClient;
  /**
   * 附件二进制通道客户端。
   *
   * 可选：缺失时元数据同步照常工作，只是附件二进制不传输。
   * 这样部署在受限环境（无对象存储/带宽紧张）也能先跑起正文同步。
   */
  blobClient?: SyncBlobClient | null;
  /** 周期同步间隔；0 表示只在被显式触发时同步。 */
  intervalMs?: number;
  /** 允许测试注入定时器控制。 */
  scheduler?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
}

const DEFAULT_INTERVAL_MS = 60_000;

export class SyncEngine {
  private state: SyncEngineState = "idle";
  private phase: SyncEnginePhase | null = null;
  private running = false;
  /**
   * 是否已被显式停止（stop() 或 Profile 停用）。
   *
   * 与 state 分开：state 是"当前同步健康度"，会随网络/授权变化；
   * stopped 是"用户意图"，只有 start() 能清除。
   * 二者混用会导致一次网络故障把引擎永久关停。
   */
  private stopped = false;
  private timer: unknown = null;
  private retryCount = 0;
  private lastPushAt: string | null = null;
  private lastPullAt: string | null = null;
  private lastError: string | null = null;
  private remoteSequence = 0;
  /** 一轮同步进行中又收到触发时置位，结束后立即再跑一轮。 */
  private rerunRequested = false;

  private readonly db: Database.Database;
  private readonly profileId: string;
  private readonly deviceId: string;
  private readonly userId: string;
  private readonly client: SyncRemoteClient;
  private readonly blobClient: SyncBlobClient | null;
  private readonly intervalMs: number;
  private readonly scheduler: NonNullable<SyncEngineOptions["scheduler"]>;

  constructor(options: SyncEngineOptions) {
    this.db = options.db;
    this.profileId = options.profileId;
    this.deviceId = options.deviceId;
    this.userId = options.userId;
    this.client = options.client;
    this.blobClient = options.blobClient ?? null;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.scheduler = options.scheduler ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    };
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  /**
   * 启动引擎。
   *
   * 第一件事是复位 inflight：上次进程若在推送中被强杀，
   * 那些条目会永久停留在 inflight，之后再也不会被取出。
   * 重复推送是安全的——服务端按 mutationId 幂等。
   */
  start(): void {
    const recovered = recoverInflightMutations(this.db);
    if (recovered > 0) {
      logSyncWarn("engine.recovered-inflight", {
        profileId: this.profileId,
        deviceId: this.deviceId,
        pendingCount: recovered,
      });
    }
    this.stopped = false;
    this.state = "idle";
    this.scheduleNext(0);
  }

  /**
   * 停止引擎。
   *
   * 只停调度，**不动任何本地数据**：笔记、附件、未同步的 Outbox、
   * 冲突记录全部原样保留。这是"关闭同步不等于删除数据"的落地点。
   */
  stop(): void {
    if (this.timer !== null) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = null;
    }
    this.stopped = true;
    this.state = "disabled";
    this.phase = null;
  }

  /** 网络恢复时立即触发一轮，不必等周期到点。 */
  notifyNetworkOnline(): void {
    if (this.stopped) return;
    this.scheduleNext(0);
  }

  private scheduleNext(delayMs: number): void {
    if (this.timer !== null) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = null;
    }
    // 已停止就不再排程，否则 stop() 之后仍会被残留定时器唤醒。
    if (this.stopped) return;
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = null;
      void this.syncOnce();
    }, delayMs);
  }

  // -------------------------------------------------------------------------
  // 状态查询（设置页诊断信息）
  // -------------------------------------------------------------------------

  getStatus(): SyncEngineStatus {
    const conflicts = countUnresolvedConflicts(this.db,this.profileId);
    const cursor = getSyncState(this.db, this.profileId, SYNC_PERSONAL_SCOPE_KEY);
    return {
      // 有未解决冲突时对外呈现 conflict，让用户知道需要介入；
      // 但引擎本身仍然继续同步其他实体。
      state: conflicts > 0 && this.state === "idle" ? "conflict" : this.state,
      phase: this.phase,
      profileId: this.profileId,
      deviceId: this.deviceId,
      localCursor: cursor?.lastSequence ?? 0,
      remoteSequence: this.remoteSequence,
      pendingMutations: countPendingMutations(this.db,this.profileId),
      conflictCount: conflicts,
      lastPushAt: this.lastPushAt,
      lastPullAt: this.lastPullAt,
      lastError: this.lastError,
      retryCount: this.retryCount,
      scopes: listWorkspaceScopeStates(this.db, this.profileId),
    };
  }

  // -------------------------------------------------------------------------
  // 一轮同步
  // -------------------------------------------------------------------------

  /**
   * 执行一轮 Push → Pull → ACK。
   *
   * 是否允许同步由 **Profile 是否启用** 决定，而不是"调度器有没有跑起来"。
   * 否则手动触发（如用户点"立即同步"、网络恢复回调）就必须先 start()，
   * 很容易漏调而表现为"点了没反应"。
   *
   * 并发保护：同一时刻只允许一轮。重入请求记为 rerunRequested，
   * 结束后立刻补跑，避免"用户刚编辑完却要等一整个周期"。
   */
  async syncOnce(): Promise<SyncEngineStatus> {
    if (this.stopped) return this.getStatus();
    if (this.running) {
      this.rerunRequested = true;
      return this.getStatus();
    }

    const profile = getProfile(this.db, this.profileId);
    if (!profile || profile.enabled !== 1) {
      // Profile 被停用或删除：停止调度，但绝不清理本地数据。
      this.stop();
      return this.getStatus();
    }

    this.running = true;
    this.state = "syncing";
    const startedAt = Date.now();

    try {
      const descriptors = await this.client.listScopes();
      const states = refreshWorkspaceScopeStates(this.db,this.profileId,descriptors,this.userId);
      for (const descriptor of descriptors) {
        const local = states.find((item) => item.scopeKey === descriptor.scopeKey);
        if (!local || local.accessStatus === "access_revoked") continue;
        try {
          if (local.accessStatus === "replan_required") {
            await this.runSnapshotRebuild(descriptor);
            markWorkspaceScopeActive(
              this.db,
              this.profileId,
              descriptor.scopeKey,
              descriptor.accessFingerprint,
            );
          }
          await this.runPush(descriptor);
          await this.runPull(descriptor);
          // 附件二进制放在最后：它耗时最长且不影响正文一致性。
          await this.runBlobs(descriptor);
        } catch (error: any) {
          if (error?.code === "ACCESS_REVOKED" || error?.code === "SCOPE_FORBIDDEN") {
            markWorkspaceScopeRevoked(this.db,this.profileId,descriptor.scopeKey,this.userId);
            continue;
          }
          throw error;
        }
      }

      this.state = "idle";
      this.lastError = null;
      this.retryCount = 0;
      logSyncInfo("engine.cycle-done", {
        profileId: this.profileId,
        deviceId: this.deviceId,
        durationMs: Date.now() - startedAt,
        pendingCount: countPendingMutations(this.db,this.profileId),
        conflictCount: countUnresolvedConflicts(this.db,this.profileId),
      });
      this.scheduleNextAfterSuccess();
    } catch (error: any) {
      this.handleCycleError(error);
    } finally {
      this.running = false;
      this.phase = null;
      if (this.rerunRequested) {
        this.rerunRequested = false;
        this.scheduleNext(0);
      }
    }

    return this.getStatus();
  }

  private scheduleNextAfterSuccess(): void {
    if (this.intervalMs > 0) this.scheduleNext(this.intervalMs);
  }

  /**
   * 分类处理一轮失败。
   *
   * 关键点：无论哪种失败，本地数据与 Outbox 都保持原样。
   * 同步失败只是"等待同步"，绝不是"保存失败"。
   */
  private handleCycleError(error: any): void {
    const code = isSyncErrorCode(error?.code)
      ? error.code
      : "SERVER_ERROR";
    this.lastError = code;
    recordSyncError(this.db, this.profileId, code, SYNC_PERSONAL_SCOPE_KEY);

    if (code === "NETWORK_UNAVAILABLE") {
      // 离线不是错误状态：本地照常工作，等网络回来。
      this.state = "offline";
      this.retryCount += 1;
      logSyncInfo("engine.offline", {
        profileId: this.profileId,
        retryCount: this.retryCount,
        pendingCount: countPendingMutations(this.db,this.profileId),
      });
      this.scheduleNext(syncRetryDelayMs(this.retryCount));
      return;
    }

    if (code === "AUTH_EXPIRED") {
      // 凭据失效只暂停同步，不影响本地读写；重试也没用，等用户重新授权。
      this.state = "error";
      logSyncWarn("engine.auth-expired", { profileId: this.profileId, errorCode: code });
      return;
    }

    this.state = "error";
    this.retryCount += 1;
    logSyncError("engine.cycle-failed", {
      profileId: this.profileId,
      errorCode: code,
      retryCount: this.retryCount,
    });
    if (isRetryableSyncError(code)) {
      this.scheduleNext(syncRetryDelayMs(this.retryCount));
    }
  }

  // -------------------------------------------------------------------------
  // Push
  // -------------------------------------------------------------------------

  /**
   * 传输附件二进制。
   *
   * 与元数据分开且**失败不抛出**：附件传不上去不该让整轮同步进入 error 状态，
   * 用户的笔记正文已经同步成功了。失败只累加 retryCount，下轮继续。
   *
   * blobClient 缺失（未配置或测试未注入）时静默跳过，
   * 保证元数据同步在任何情况下都能独立工作。
   */
  private async runBlobs(scope: SyncScopeDescriptor): Promise<void> {
    if (!this.blobClient) return;
    this.phase = "applying";
    try {
      await pushAttachmentBlobs(this.db, this.blobClient, { scopeKey: scope.scopeKey });
      await pullAttachmentBlobs(this.db, this.blobClient, { scopeKey: scope.scopeKey });
    } catch (error) {
      // 只记日志：附件是次要通道，不能污染整轮同步的状态判定。
      logSyncWarn("engine.blob-cycle-failed", {
        profileId: this.profileId,
        errorCode: error instanceof SyncError ? error.code : "SERVER_ERROR",
      });
    }
  }

  private async runPush(scope: SyncScopeDescriptor): Promise<void> {
    this.phase = "pushing";

    const rows = listPendingMutations(
      this.db,
      SYNC_PUSH_MAX_MUTATIONS,
      this.profileId,
      scope.scopeKey,
    );
    if (rows.length === 0) return;

    const batch = coalesceMutations(rows);
    for (const mutation of batch) {
      markMutationInflight(this.db, mutation.mutationId);
      for (const superseded of mutation.supersededIds) {
        markMutationInflight(this.db, superseded);
      }
    }

    let response;
    try {
      response = await this.client.push(
        this.deviceId,
        batch.map(({ supersededIds: _ignored, ...payload }) => payload),
        scope.scopeKey,
      );
    } catch (error) {
      // 请求失败（断网、超时、服务端异常）时必须把 inflight 退回 pending。
      // 否则这些条目在本次进程内再也不会被取出——只有重启才能恢复，
      // 表现为"断网后即使网络恢复也永远不再上传"。
      recoverInflightMutations(this.db);
      throw error;
    }
    this.remoteSequence = response.serverSequence;
    this.lastPushAt = new Date().toISOString();

    const bySupersede = new Map(batch.map((m) => [m.mutationId, m.supersededIds]));

    for (const result of response.results) {
      const superseded = bySupersede.get(result.mutationId) || [];

      if (result.status === "applied" || result.status === "duplicate") {
        // 出队：这是唯一允许删除 Outbox 条目的路径。
        markLocalMutationApplied(this.db, result.mutationId, this.deviceId);
        markMutationSynced(this.db, result.mutationId);
        for (const id of superseded) markMutationSynced(this.db, id);
        continue;
      }

      if (result.code === "VERSION_CONFLICT") {
        this.recordPushConflict(
          result.mutationId,result.serverVersion,result.serverPayload,rows,scope.scopeKey,
        );
        // 冲突条目出队：它已经转入冲突台账，继续重试只会反复失败。
        // 本地内容仍在库里，两个版本都可恢复。
        markMutationSynced(this.db, result.mutationId);
        for (const id of superseded) markMutationSynced(this.db, id);
        continue;
      }

      // 其它失败保留在 Outbox 等待重试；retryCount 只增不删。
      markMutationFailed(this.db, result.mutationId, result.code || "SERVER_ERROR");
      for (const id of superseded) {
        markMutationFailed(this.db, id, result.code || "SERVER_ERROR");
      }
    }

    // 兜底：服务端若漏回某些 mutation 的结果（部分响应、协议不一致），
    // 对应条目会留在 inflight 而永不重试。统一退回 pending，
    // 重复推送由 mutationId 幂等保证安全。
    recoverInflightMutations(this.db);
  }

  /**
   * 把 push 冲突落入冲突台账。
   *
   * 必须同时保留本地 payload 与服务端当前内容，否则用户无法恢复其中一方。
   */
  private recordPushConflict(
    mutationId: string,
    serverVersion: number | undefined,
    serverPayload: Record<string,unknown> | undefined,
    rows: ReturnType<typeof listPendingMutations>,
    scopeKey: string,
  ): void {
    const source = rows.find((row) => row.mutationId === mutationId);
    if (!source) return;

    let localPayload: Record<string, unknown> | null = null;
    try {
      localPayload = source.payload ? JSON.parse(source.payload) : null;
    } catch {
      localPayload = null;
    }

    recordConflict(this.db, {
      profileId: this.profileId,
      scopeKey,
      entityType: source.entityType,
      entityId: source.entityId,
      localVersion: source.baseVersion,
      remoteVersion: serverVersion ?? null,
      localPayload,
      remotePayload: serverPayload ?? (serverVersion === undefined ? null : {version:serverVersion}),
    });

    logSyncWarn("engine.conflict", {
      profileId: this.profileId,
      entityType: source.entityType,
      entityId: source.entityId,
      errorCode: "VERSION_CONFLICT",
    });
  }

  // -------------------------------------------------------------------------
  // Pull + Apply + ACK
  // -------------------------------------------------------------------------

  private async runPull(scope: SyncScopeDescriptor): Promise<void> {
    this.phase = "pulling";

    const cursor = getSyncState(this.db, this.profileId, scope.scopeKey);
    let after = cursor?.lastSequence ?? 0;

    const changes = await this.client.changes(after, undefined, scope.scopeKey);
    this.remoteSequence = changes.serverSequence;
    this.lastPullAt = new Date().toISOString();

    if (changes.resetRequired) {
      // 游标太旧，增量已被清理。复位游标走 snapshot 重建；
      // 只清游标，不动本地数据与 Outbox。
      logSyncWarn("engine.reset-required", {
        profileId: this.profileId,
        pullSequence: after,
      });
      resetSyncState(this.db, this.profileId, scope.scopeKey);
      await this.runSnapshotRebuild(scope);
      return;
    }

    if (changes.items.length === 0) {
      // 无变更也要推进游标，避免下次重复扫描同一段序号。
      advanceSyncState(this.db, this.profileId, changes.nextSequence, scope.scopeKey);
      await this.client.ack(this.deviceId, changes.nextSequence, scope.scopeKey);
      return;
    }

    // Change Feed 只给"哪些实体变了"，完整内容通过 snapshot 单点拉取。
    // 这样协议不必在 feed 里塞正文，也避免历史变更累积成巨大响应。
    this.phase = "applying";
    const payloads = await this.fetchEntityPayloads(changes.items, scope);
    const result = applyRemoteChanges(this.db,payloads,{
      userId:this.userId,scopeKey:scope.scopeKey,workspaceId:scope.workspaceId,
    });
    this.restoreParentLinks(payloads,scope);

    for (const conflict of result.pendingConflicts) {
      // 本地有未推送修改，远端也变了：登记冲突，两侧都保留。
      recordConflict(this.db, {
        profileId: this.profileId,
        scopeKey: scope.scopeKey,
        entityType: conflict.entityType,
        entityId: conflict.entityId,
        remotePayload: conflict.payload ?? null,
        localPayload: this.readLocalSnapshot(conflict, scope),
      });
    }

    advanceSyncState(this.db, this.profileId, changes.nextSequence, scope.scopeKey);
    await this.client.ack(this.deviceId, changes.nextSequence, scope.scopeKey);

    logSyncInfo("engine.pull-applied", {
      profileId: this.profileId,
      pullSequence: changes.nextSequence,
      applyCount: result.applied,
      conflictCount: result.pendingConflicts.length,
    });

    // 服务端还有更多变更时立即续拉，不必等下个周期。
    if (changes.hasMore) this.rerunRequested = true;
  }

  /**
   * 按 Change Feed 条目取回实体内容。
   *
   * delete 不需要内容；upsert 通过 snapshot 精确定位。
   * 这里逐类批量拉取，避免为每条变更单独发一次请求。
   */
  private async fetchEntityPayloads(
    items: Array<{ entityType: string; entityId: string; operation: string }>,
    scope: SyncScopeDescriptor,
  ): Promise<RemoteEntityPayload[]> {
    const deletions: RemoteEntityPayload[] = [];
    const wanted = new Set<string>();

    for (const item of items) {
      if (item.operation === "delete") {
        deletions.push({
          entityType: item.entityType as RemoteEntityPayload["entityType"],
          entityId: item.entityId,
          operation: "delete",
        });
        continue;
      }
      wanted.add(`${item.entityType}\u0000${item.entityId}`);
    }

    if (wanted.size === 0) return deletions;

    // 遍历 snapshot，挑出本轮需要的实体。
    const upserts: RemoteEntityPayload[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const page = await this.client.snapshot(cursor, 0, undefined, scope.scopeKey);
      for (const entry of page.items) {
        const key = `${entry.entityType}\u0000${entry.entityId}`;
        if (!wanted.has(key)) continue;
        upserts.push({
          entityType: entry.entityType,
          entityId: entry.entityId,
          operation: "upsert",
          payload: entry.payload,
        });
        wanted.delete(key);
      }
      cursor = page.nextCursor;
      guard += 1;
      // 需要的实体都拿到就提前结束，不必翻完整个知识库。
      if (wanted.size === 0) break;
    } while (cursor && guard < 1000);

    if (wanted.size > 0) {
      throw new SyncError(
        "SERVER_ERROR",
        `Snapshot 未返回 ${wanted.size} 个 Change Feed upsert payload，禁止推进同步游标`,
      );
    }

    // 先应用 upsert 再应用 delete：
    // 同一轮里若既有创建又有删除，删除应当是最终状态。
    return [...upserts, ...deletions];
  }

  /** 读取本地当前内容，作为冲突的 local 一方留存。 */
  private readLocalSnapshot(
    item: RemoteEntityPayload,
    scope: SyncScopeDescriptor,
  ): Record<string, unknown> | null {
    if (item.entityType !== "note") return null;
    const row = this.db.prepare(`
      SELECT id, title, content, contentText, version, updatedAt
      FROM notes WHERE id = ? AND workspaceId IS ? AND (? IS NOT NULL OR userId = ?)
    `).get(item.entityId, scope.workspaceId, scope.workspaceId, this.userId) as
      | Record<string, unknown>
      | undefined;
    return row || null;
  }

  /**
   * Snapshot 全量重建。
   *
   * 只在服务端明确要求 reset 时执行。逐页应用，
   * 期间同样抑制 Outbox，避免把远端内容当成本地修改推回去。
   */
  private async runSnapshotRebuild(scope: SyncScopeDescriptor): Promise<void> {
    this.phase = "applying";
    let cursor: string | null = null;
    let snapshotSequence = 0;
    let guard = 0;
    let applied = 0;
    const seen = new Map<string,Set<string>>();
    const parentLinks:RemoteEntityPayload[] = [];

    do {
      const page = await this.client.snapshot(
        cursor,
        snapshotSequence,
        undefined,
        scope.scopeKey,
      );
      if (snapshotSequence === 0) snapshotSequence = page.snapshotSequence;
      for (const entry of page.items) {
        const ids=seen.get(entry.entityType) || new Set<string>();
        ids.add(entry.entityId);
        seen.set(entry.entityType,ids);
        if (entry.entityType === "notebook" || entry.entityType === "task") {
          parentLinks.push({
            entityType:entry.entityType,
            entityId:entry.entityId,
            operation:"upsert",
            payload:entry.payload,
          });
        }
      }

      const result = applyRemoteChanges(
        this.db,
        page.items.map((entry) => ({
          entityType: entry.entityType,
          entityId: entry.entityId,
          operation: "upsert" as const,
          payload: entry.payload,
        })),
        { userId:this.userId,scopeKey:scope.scopeKey,workspaceId:scope.workspaceId },
      );
      applied += result.applied;

      cursor = page.nextCursor;
      guard += 1;
    } while (cursor && guard < 1000);

    if (cursor) throw new SyncError("SERVER_ERROR","Snapshot 分页超过安全上限");
    this.restoreParentLinks(parentLinks,scope);
    if (scope.workspaceId) this.pruneWorkspaceSnapshot(scope,seen);

    // 重建完成后游标落在 snapshot 时间点，之后继续增量。
    advanceSyncState(this.db, this.profileId, snapshotSequence, scope.scopeKey);
    await this.client.ack(this.deviceId, snapshotSequence, scope.scopeKey);

    logSyncInfo("engine.snapshot-rebuilt", {
      profileId: this.profileId,
      pullSequence: snapshotSequence,
      applyCount: applied,
    });
  }

  private restoreParentLinks(items:RemoteEntityPayload[],scope:SyncScopeDescriptor):void {
    const links=items.filter((item)=>item.operation === "upsert"
      && (item.entityType === "notebook" || item.entityType === "task")
      && typeof item.payload?.parentId === "string");
    if (!links.length) return;
    runWithOutboxSuppressed(()=>runChangeFeedSuppressed(this.db,()=>this.db.transaction(()=>{
      for(const item of links){
        const table=item.entityType === "notebook" ? "notebooks" : "tasks";
        const parentId=String(item.payload!.parentId);
        const parent=this.db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND workspaceId IS ?`)
          .get(parentId,scope.workspaceId);
        if(parent)this.db.prepare(`UPDATE ${table} SET parentId=? WHERE id=? AND workspaceId IS ?`)
          .run(parentId,item.entityId,scope.workspaceId);
      }
    })()));
  }

  private pruneWorkspaceSnapshot(scope:SyncScopeDescriptor,seen:Map<string,Set<string>>):void {
    const removeMissing=(table:string,entityType:string,extra="")=>{
      const ids=[...(seen.get(entityType) || [])];
      const placeholders=ids.map(()=>"?").join(",");
      this.db.prepare(`DELETE FROM ${table} WHERE workspaceId=?
        ${ids.length ? `AND id NOT IN (${placeholders})` : ""}
        AND NOT EXISTS (SELECT 1 FROM sync_outbox o WHERE o.profileId=? AND o.scopeKey=?
          AND o.entityType=? AND o.entityId=${table}.id AND o.status IN ('pending','inflight','failed'))
        ${extra}`).run(scope.workspaceId,...ids,this.profileId,scope.scopeKey,entityType);
    };
    const removeComposite=(table:string,entityType:string,idSql:string,scopeSql:string)=>{
      const ids=[...(seen.get(entityType) || [])];
      const placeholders=ids.map(()=>"?").join(",");
      this.db.prepare(`DELETE FROM ${table} WHERE ${scopeSql}
        ${ids.length ? `AND (${idSql}) NOT IN (${placeholders})` : ""}
        AND NOT EXISTS (SELECT 1 FROM sync_outbox o WHERE o.profileId=? AND o.scopeKey=?
          AND o.entityType=? AND o.entityId=(${idSql}) AND o.status IN ('pending','inflight','failed'))`)
        .run(scope.workspaceId,...ids,this.profileId,scope.scopeKey,entityType);
    };
    runWithOutboxSuppressed(()=>runChangeFeedSuppressed(this.db,()=>this.db.transaction(()=>{
      removeMissing("attachments","attachment");
      removeComposite("favorites","favorite","favorites.userId || ':' || favorites.noteId","favorites.workspaceId=?");
      removeComposite("note_tags","note_tag","note_tags.noteId || ':' || note_tags.tagId","note_tags.noteId IN (SELECT id FROM notes WHERE workspaceId=?)");
      removeComposite("task_reminders","task_reminder","task_reminders.id","task_reminders.taskId IN (SELECT id FROM tasks WHERE workspaceId=?)");
      removeMissing("tasks","task");
      removeMissing("diaries","diary");
      removeMissing("mindmaps","mindmap");
      removeMissing("notes","note");
      removeMissing("notebooks","notebook","AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.notebookId=notebooks.id)");
      removeMissing("tags","tag","AND NOT EXISTS (SELECT 1 FROM note_tags nt WHERE nt.tagId=tags.id)");
    })()));
  }
}
