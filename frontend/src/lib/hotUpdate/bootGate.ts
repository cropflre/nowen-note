// 启动时根据本地库的打开结果分流（DCC-013）。抽成纯函数，main.tsx 和测试用同一套判断。
import { NativeDatabaseUpgradeRequiredError } from "../nativeDatabase";

/** 本地库版本比代码新：只显示保护页，不渲染应用、不读写数据。 */
export function bootDatabaseGate(failure: unknown): "database-guard" | "application" {
  return failure instanceof NativeDatabaseUpgradeRequiredError ? "database-guard" : "application";
}

/**
 * 是否向热更新插件确认当前包可用。本地库因为这份代码打不开时不确认，让插件退回安装包自带的版本；
 * 版本过新时显示保护页属于正常状态，照常确认，避免在两个版本之间反复回退。
 */
export function shouldConfirmHotUpdateBundle(failure: unknown): boolean {
  return !failure || failure instanceof NativeDatabaseUpgradeRequiredError;
}
