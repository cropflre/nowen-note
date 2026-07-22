import type { DesktopUpdateSnapshot } from "@/lib/updateExperience";

export const DESKTOP_RELEASES_URL = "https://github.com/cropflre/nowen-note/releases";

const MISSING_ASSET_PATTERN = /(?:\b404\b|not[ -]?found|does not exist|no such file|asset[^\n]*(?:missing|不存在)|更新文件[^\n]*未正确发布)/i;

export function isMissingUpdateAssetFailure(snapshot: DesktopUpdateSnapshot | null | undefined): boolean {
  if (!snapshot || snapshot.errorStage !== "download") return false;
  return MISSING_ASSET_PATTERN.test(String(snapshot.message || ""));
}

export function describeMissingUpdateAsset(snapshot: DesktopUpdateSnapshot | null | undefined): string {
  const current = snapshot?.currentVersion ? `v${snapshot.currentVersion}` : "当前版本";
  const target = snapshot?.version ? `v${snapshot.version}` : "目标版本";
  return `已检测到 ${target}，但 Release 中缺少更新元数据引用的安装包。${current} 可继续安全使用，请前往下载页手动安装。`;
}
