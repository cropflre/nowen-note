/**
 * Local-first + Optional Sync（Sync V2）总开关。
 *
 * Phase 0 的唯一职责是隔离尚未启用的改造代码：
 * - 生产默认关闭，开发阶段需显式设置 NOWEN_LOCAL_FIRST_SYNC_V2=1；
 * - 开关关闭时，所有调用方必须保持 Offline Sync V1 行为完全不变；
 * - 取值严格匹配，避免配置拼写（如 TRUE / yes）意外开启改造路径。
 */
export function isLocalFirstSyncV2Enabled(
  value = process.env.NOWEN_LOCAL_FIRST_SYNC_V2,
): boolean {
  return value === "1" || value === "true";
}
