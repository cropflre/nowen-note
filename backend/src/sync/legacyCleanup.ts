// backend/src/sync/legacyCleanup.ts
//
// Phase 13 清理清单（**仅清单，不执行删除**）。
//
// 用户明确要求跳过 Phase 13，理由充分：原始需求第四十六条写了
// "只有当 Desktop Local-first / Sync V2 / Lite Migration / Clipper Local /
// Mobile Local-first 全部稳定后才允许逐步删除""禁止提前删除兼容代码"。
//
// 当前 Lite 迁移和 Mobile Native 实现已经具备，但尚未经过发布后的稳定性
// 观察与存量客户端迁移确认。此刻删除 legacy 仍会让两类用户直接失联：
//   - 已发布的 Lite-only 安装包用户（他们的数据在远端，本地库是空的）
//   - 尚未完成迁移的 Lite 用户（切到 local 会看到空知识库）
//
// 因此本文件把清理项固化为可检查的清单，等前置条件真正满足后再执行。

export interface CleanupItem {
  /** 待清理的目标 */
  target: string;
  /** 位置 */
  location: string;
  /** 必须先满足什么条件 */
  precondition: string;
  /** 提前删除的后果 */
  risk: string;
}

/**
 * 清理前必须全部满足的前置条件。
 *
 * 每一项都要有真实上线验证，不能靠"代码写完了"就算。
 */
export const CLEANUP_PRECONDITIONS = {
  desktopLocalFirstStable: false,
  syncV2Stable: false,
  /** Lite → Local 的真实数据搬迁与完整性校验 */
  liteMigrationShipped: false,
  clipperLocalShipped: false,
  /** Mobile Native 本地数据库已实现，并完成发布与存量数据迁移验证 */
  mobileLocalFirstShipped: false,
} as const;

export const LEGACY_CLEANUP_PLAN: CleanupItem[] = [
  {
    target: 'settings.mode / settings.remoteUrl（"full" | "lite"）',
    location: "electron/settings.js",
    precondition: "全部 Lite 用户完成迁移，且不再需要回滚到旧版本客户端",
    risk: "旧版本客户端读不到 mode 会退回默认 full，Lite 用户看到空知识库",
  },
  {
    target: "switchToFull / switchToLite / changeRemoteServer",
    location: "electron/main.js",
    precondition: "同步设置页（Phase 7）已完全替代模式切换入口",
    risk: "Lite 用户失去更换服务器的能力，且无法回到本地模式",
  },
  {
    target: "isLiteOnlyBuild / builder.lite.config.js",
    location: "electron/main.js, electron/builder.lite*.config.js",
    precondition: "停止发布 Lite-only 安装包，且存量用户已升级到完整版",
    risk: "已安装 Lite 包的用户升级后无法启动（缺少内置后端）",
  },
  {
    target: "clearWebStorage 在模式切换时清 IndexedDB",
    location: "electron/main.js",
    precondition: "同步服务器切换改为只清 Remote Auth / Sync Session",
    risk: "会连带清掉本地未同步数据——违反 RULE 4",
  },
  {
    target: "Offline Queue V1（localStorage 版）",
    location: "frontend/src/lib/offlineQueue.ts",
    precondition: "所有写入路径改走 sync_outbox，且存量队列已排空",
    risk: "用户 localStorage 里尚未上传的修改会永久丢失",
  },
  {
    target: "Offline Sync V1 不再使用的部分",
    location: "backend/src/routes/offline-sync.ts, backend/src/db/offlineSyncMigration.ts (v66)",
    precondition: "所有客户端升级到 Sync V2；v66 触发器需保留至确认无旧客户端",
    risk: "已发布客户端的离线同步立即失效；触发器删除后 feed 断档不可恢复",
  },
  {
    target: "localStore.ts / offlineRead.ts 的 Cache 语义",
    location: "frontend/src/lib/localStore.ts, offlineRead.ts",
    precondition: "Mobile Native 已稳定发布，Web 端也不再依赖 Cache fallback",
    risk: "Web/旧移动端失去断网缓存与升级迁移来源",
  },
  {
    target: "Clipper 的 serverUrl + token 直连远端路径",
    location: "packages/nowen-clipper/src/lib/api.ts",
    precondition: "本地通道（localChannel.ts）在三大浏览器验证通过",
    risk: "没装桌面端、只用 Web 版的用户完全无法剪藏",
  },
];

/** 是否满足全部前置条件。当前恒为 false。 */
export function isLegacyCleanupAllowed(): boolean {
  return Object.values(CLEANUP_PRECONDITIONS).every(Boolean);
}

/** 尚未满足的前置条件。 */
export function pendingCleanupPreconditions(): string[] {
  return Object.entries(CLEANUP_PRECONDITIONS)
    .filter(([, ready]) => !ready)
    .map(([key]) => key);
}

/**
 * 清理前的守卫。
 *
 * 未来真要执行清理时先调用它，把"提前删除兼容代码"挡在门外。
 */
export function assertLegacyCleanupAllowed(): void {
  const pending = pendingCleanupPreconditions();
  if (pending.length > 0) {
    throw new Error(
      `[sync-v2] 禁止提前删除兼容代码，未满足前置条件：${pending.join("、")}`,
    );
  }
}
