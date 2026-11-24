// 是否接受一个已验签清单的纯判断，和平台、网络、插件都无关，便于单测覆盖每条规则。
import type { HotUpdateManifest, HotUpdateTarget } from "./envelope";

export type HotUpdateSkipReason =
  | "target-mismatch"
  | "runtime-mismatch"
  | "stale-sequence"
  | "revoked"
  | "blocked"
  | "not-newer"
  | "already-pending";

export type HotUpdateDecision = { action: "download" } | { action: "skip"; reason: HotUpdateSkipReason };

export interface HotUpdateDecisionInput {
  manifest: HotUpdateManifest;
  target: HotUpdateTarget;
  /** 安装包的壳指纹；必须完全相等 */
  runtimeVersion: string;
  /** 当前正在运行的网页包版本（__APP_VERSION__） */
  currentVersion: string;
  /** 见过的最大 sequence；更小的清单视为重放，防止降级 */
  maxSequence: number;
  /** 插件回退后屏蔽的包 */
  blockedBundleIds: readonly string[];
  /** 已下载、等待重启生效的包 */
  pendingBundleId?: string | null;
}

function parseVersion(value: string): [number, number, number] | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** 比较 X.Y.Z；格式不对的版本当作最低。 */
export function compareHotUpdateVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

export function decideHotUpdate(input: HotUpdateDecisionInput): HotUpdateDecision {
  const { manifest } = input;
  if (manifest.target !== input.target) return { action: "skip", reason: "target-mismatch" };
  if (manifest.runtimeVersion !== input.runtimeVersion) return { action: "skip", reason: "runtime-mismatch" };
  if (manifest.sequence < input.maxSequence) return { action: "skip", reason: "stale-sequence" };
  if (manifest.revokedBundleIds.includes(manifest.bundleId)) return { action: "skip", reason: "revoked" };
  if (input.blockedBundleIds.includes(manifest.bundleId)) return { action: "skip", reason: "blocked" };
  if (compareHotUpdateVersions(manifest.version, input.currentVersion) <= 0) return { action: "skip", reason: "not-newer" };
  if (input.pendingBundleId === manifest.bundleId) return { action: "skip", reason: "already-pending" };
  return { action: "download" };
}

/** 当前生效的热更新包被撤回：需要退回安装包自带的版本。安装包自带版本（null）不会被撤回。 */
export function isCurrentBundleRevoked(manifest: HotUpdateManifest, currentBundleId: string | null): boolean {
  return currentBundleId !== null && manifest.revokedBundleIds.includes(currentBundleId);
}

export function describeSkip(reason: HotUpdateSkipReason): string {
  switch (reason) {
    case "not-newer":
    case "already-pending":
      return "当前已是最新版本";
    case "runtime-mismatch":
    case "target-mismatch":
      return "新版本需要安装新的安装包";
    case "blocked":
      return "上次更新启动失败，已跳过这个版本";
    case "revoked":
      return "这个版本已被撤回";
    case "stale-sequence":
      return "收到的版本信息比已知的旧，已忽略";
  }
}
