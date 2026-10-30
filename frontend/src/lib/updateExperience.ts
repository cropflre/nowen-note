export type DesktopUpdatePhase =
  | "idle"
  | "checking"
  | "update-available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "up-to-date"
  | "store-managed"
  | "error";

export interface DesktopUpdateSnapshot {
  status?: string;
  phase?: DesktopUpdatePhase;
  currentVersion?: string;
  version?: string | null;
  releaseName?: string;
  releaseNotes?: string;
  releaseDate?: string;
  fileSize?: number | null;
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  checkedAt?: string | null;
  installOnQuit?: boolean;
  message?: string;
  errorStage?: "check" | "download" | "install" | string | null;
  platform?: string;
  arch?: string;
  manual?: boolean;
}

export const UPDATE_AUTO_CHECK_KEY = "nowen-desktop-update-auto-check";
export const UPDATE_INSTALL_ON_QUIT_KEY = "nowen-desktop-update-install-on-quit";
export const UPDATE_LAST_CHECK_KEY = "nowen-desktop-update-last-check";

export function readBooleanPreference(key: string, fallback: boolean): boolean {
  if (typeof localStorage === "undefined") return fallback;
  const value = localStorage.getItem(key);
  if (value == null) return fallback;
  return value === "true";
}

export function writeBooleanPreference(key: string, value: boolean): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(key, String(value));
}

export function clampUpdatePercent(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(100, Math.max(0, numeric));
}

export function formatUpdateBytes(value: unknown): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[unit]}`;
}

export function compactReleaseNotes(value: unknown, maxLength = 1400): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxLength);
}

export function resolveUpdatePhase(snapshot: DesktopUpdateSnapshot | null): DesktopUpdatePhase {
  if (!snapshot) return "idle";
  if (snapshot.phase) return snapshot.phase;
  switch (snapshot.status) {
    case "checking": return "checking";
    case "available": return "update-available";
    case "downloading": return "downloading";
    case "downloaded": return "downloaded";
    case "preparing-install":
    case "installing": return "installing";
    case "not-available": return "up-to-date";
    case "store-managed": return "store-managed";
    case "error": return "error";
    default: return "idle";
  }
}

export function updateStatusText(snapshot: DesktopUpdateSnapshot | null): string {
  const phase = resolveUpdatePhase(snapshot);
  switch (phase) {
    case "checking": return "正在检查新版本…";
    case "update-available": return `发现新版本 v${snapshot?.version || "?"}`;
    case "downloading": return `正在下载 ${clampUpdatePercent(snapshot?.percent).toFixed(1)}%`;
    case "downloaded": return snapshot?.installOnQuit ? "已下载，退出应用时安装" : "更新已下载完成";
    case "installing": return snapshot?.message || "正在准备安装…";
    case "up-to-date": return "当前已是最新版本";
    case "store-managed": return "更新由 Microsoft Store 管理";
    case "error": return `更新失败：${snapshot?.message || "未知错误"}`;
    default: return "等待检查";
  }
}

export function shouldShowAvailablePrompt(
  snapshot: DesktopUpdateSnapshot | null,
  dismissedVersions: ReadonlySet<string>,
): boolean {
  if (resolveUpdatePhase(snapshot) !== "update-available") return false;
  const version = snapshot?.version?.trim();
  return Boolean(version && !dismissedVersions.has(version));
}
