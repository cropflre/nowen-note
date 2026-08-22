import type { SyncEntityType } from "./types";

/**
 * 同步实体注册表（Phase 11 + Phase 12）。
 *
 * 解决的问题：每新增一个实体都要完整实现七个环节，
 * 只做上传就等于把数据单向推走——其他设备的修改永远不会回来，
 * 删除也不会传播。这类"半接入"是同步系统最常见的数据丢失来源。
 *
 * 因此把清单显式化，并在代码里强制校验：
 *
 *   Local CRUD → Outbox → Push → Server Change Feed → Pull → Apply → Conflict
 *
 * 任何实体缺任一环节都不允许启用同步。
 */

export interface EntityCapability {
  entityType: SyncEntityType | string;
  /** 本地增删改查已就绪 */
  localCrud: boolean;
  /** 业务写入与 mutation 入队在同一事务内 */
  outbox: boolean;
  /** 客户端可推送该实体 */
  push: boolean;
  /** 服务端 Change Feed 覆盖该实体（触发器已安装） */
  changeFeed: boolean;
  /** 客户端可拉取该实体的变更 */
  pull: boolean;
  /** 客户端可把远端变更写入本地 */
  apply: boolean;
  /** 具备明确的冲突策略（哪怕是"关系型实体靠幂等，不需要版本比较"） */
  conflictStrategy: boolean;
}

/**
 * 第一版实体能力表。
 *
 * 六类个人知识库核心数据全链路就绪。
 * note 是唯一带版本冲突检测的实体，因为只有它承载正文；
 * 关系型实体（note_tag / favorite）靠 mutationId 幂等即可保证一致，
 * 这本身就是一种明确的冲突策略，不是遗漏。
 */
export const SYNC_ENTITY_CAPABILITIES: EntityCapability[] = [
  {
    entityType: "notebook",
    localCrud: true, outbox: true, push: true, changeFeed: true,
    pull: true, apply: true, conflictStrategy: true,
  },
  {
    entityType: "note",
    localCrud: true, outbox: true, push: true, changeFeed: true,
    pull: true, apply: true, conflictStrategy: true,
  },
  {
    entityType: "tag",
    localCrud: true, outbox: true, push: true, changeFeed: true,
    pull: true, apply: true, conflictStrategy: true,
  },
  {
    entityType: "note_tag",
    localCrud: true, outbox: true, push: true, changeFeed: true,
    pull: true, apply: true, conflictStrategy: true,
  },
  {
    entityType: "favorite",
    localCrud: true, outbox: true, push: true, changeFeed: true,
    pull: true, apply: true, conflictStrategy: true,
  },
  {
    entityType: "attachment",
    localCrud: true, outbox: true, push: true, changeFeed: true,
    pull: true, apply: true, conflictStrategy: true,
  },
];

/**
 * 后续 Phase 的候选实体。
 *
 * 全部标为未就绪，且**必须**逐个补齐七个环节才能加入上表。
 * 这里显式列出来的目的是防止"顺手接一个上传就上线"。
 */
export const PLANNED_SYNC_ENTITIES: EntityCapability[] = [
  {
    entityType: "task",
    localCrud: true, outbox: false, push: false, changeFeed: false,
    pull: false, apply: false, conflictStrategy: false,
  },
  {
    entityType: "diary",
    localCrud: true, outbox: false, push: false, changeFeed: false,
    pull: false, apply: false, conflictStrategy: false,
  },
  {
    entityType: "mindmap",
    localCrud: true, outbox: false, push: false, changeFeed: false,
    pull: false, apply: false, conflictStrategy: false,
  },
  {
    entityType: "habit",
    localCrud: true, outbox: false, push: false, changeFeed: false,
    pull: false, apply: false, conflictStrategy: false,
  },
];

const REQUIRED_KEYS: Array<keyof EntityCapability> = [
  "localCrud", "outbox", "push", "changeFeed", "pull", "apply", "conflictStrategy",
];

export function missingCapabilities(capability: EntityCapability): string[] {
  return REQUIRED_KEYS.filter((key) => capability[key] !== true).map(String);
}

export function isEntitySyncReady(capability: EntityCapability): boolean {
  return missingCapabilities(capability).length === 0;
}

/**
 * 校验某实体是否可以启用同步。
 *
 * 在实体接入同步的入口处调用，把"只做了上传"这类错误挡在上线之前，
 * 而不是等用户丢了数据才发现。
 */
export function assertEntitySyncReady(entityType: string): void {
  const capability = SYNC_ENTITY_CAPABILITIES.find((item) => item.entityType === entityType);
  if (!capability) {
    const planned = PLANNED_SYNC_ENTITIES.find((item) => item.entityType === entityType);
    if (planned) {
      throw new Error(
        `[sync-v2] ${entityType} 尚未完成同步接入，缺少：${missingCapabilities(planned).join("、")}`,
      );
    }
    throw new Error(`[sync-v2] ${entityType} 不在同步范围内`);
  }
  const missing = missingCapabilities(capability);
  if (missing.length > 0) {
    throw new Error(`[sync-v2] ${entityType} 同步链路不完整，缺少：${missing.join("、")}`);
  }
}

// ---------------------------------------------------------------------------
// Workspace 离线能力
// ---------------------------------------------------------------------------

/**
 * v1.5.0 已通过独立 Scope 游标、权限指纹、逐实体 ACL、撤权冻结、
 * 本地副本导出/复制和待推送保护关闭原有阻塞项。保留导出仅为兼容
 * 依赖旧版能力探测的调用方。
 */
export const WORKSPACE_OFFLINE_BLOCKERS = [] as const;

/**
 * Workspace 是否允许离线编辑。
 *
 * 保留成函数以兼容既有能力探测入口。
 */
export function isWorkspaceOfflineEditingEnabled(): boolean {
  return true;
}

/**
 * @deprecated v1.5.0 起 Workspace 已由 Scope 层授权，此兼容入口不再拦截。
 */
export function assertPersonalScopeOnly(_workspaceId: string | null | undefined): void {
  // Scope 授权由 resolveAuthorizedScope / assertSyncMutationAccess 统一执行。
}
