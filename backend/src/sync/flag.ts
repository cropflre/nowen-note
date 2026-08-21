/**
 * Local-first + Optional Sync（Sync V2）总开关。
 *
 * ## 默认开启，仅作紧急停用开关（阶段 P）
 *
 * Phase 0～阶段 J 期间这是开发闸门，默认关闭以隔离未完成的改造代码。
 * 现在链路已完整（个人数据十类实体全部走通 CRUD → Outbox → Push →
 * Change Feed → Pull → Conflict → Retry → Crash Recovery），
 * Local-first 就是桌面端的默认架构，不该再需要用户配环境变量才能用。
 *
 * 如果继续默认关闭，正式版用户打开设置会看到"当前版本尚未开启多设备同步"，
 * 而功能其实已经发布 —— 这属于把内部开发状态泄漏给了用户。
 *
 * 因此改为：
 *   未设置        → 开启（正式默认）
 *   "0" / "false" → 关闭（部署方或用户主动停用）
 *   其它值        → 开启
 *
 * 保留停用能力的理由：
 *   - 线上一旦发现同步侧的数据安全问题，运维需要能立刻止损，
 *     而不是等一个新版本发布；
 *   - 自托管用户可能只想要单机使用，不希望 Backend 起同步相关的后台任务；
 *   - Docker / NAS 部署方需要一个统一的关闭入口。
 *
 * 关闭时的语义（与 Phase 0 一致，未改变）：
 *   - /api/sync/v2 全部端点返回 404，不存在"半启用"状态；
 *   - 不产生 active SyncProfile，因此触发器闸门恒为 0，不写 Outbox；
 *   - Offline Sync V1（/api/offline-sync）行为完全不变，已发布客户端不受影响；
 *   - **本地数据一个字都不动** —— 关闭同步不等于删除数据。
 */
export function isLocalFirstSyncV2Enabled(
  value = process.env.NOWEN_LOCAL_FIRST_SYNC_V2,
): boolean {
  // 严格匹配停用值：避免 "no" / "off" / "disabled" 这类拼写被误判为开启，
  // 也避免空字符串（例如 docker-compose 里写了 KEY= 但没给值）意外关闭。
  if (value === "0" || value === "false") return false;
  return true;
}

/**
 * 是否被显式停用。
 *
 * 供诊断接口区分"用户主动关了"与"默认开着"，
 * 便于用户反馈时判断是不是配置问题。
 */
export function isLocalFirstSyncV2ExplicitlyDisabled(
  value = process.env.NOWEN_LOCAL_FIRST_SYNC_V2,
): boolean {
  return value === "0" || value === "false";
}
