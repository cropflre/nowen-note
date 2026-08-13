import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("已移除的连接与迁移功能", () => {
  it("不再暴露连接与迁移入口或全局连接中心", () => {
    const navRailSource = readSource("src/components/NavRail.tsx");
    const mainSource = readSource("src/main.tsx");
    const loginSource = readSource("src/components/LoginPage.tsx");

    expect(navRailSource).not.toContain("连接与账号");
    expect(navRailSource).not.toContain("迁移数据");
    expect(navRailSource).not.toContain("连接 NAS / 云端");
    expect(navRailSource).not.toContain("SERVER_CONNECTION_CENTER_OPEN_EVENT");
    expect(mainSource).not.toContain("ServerConnectionCenter");
    expect(loginSource).not.toContain("profileCredentialVault");
    expect(loginSource).not.toContain("PendingProfileReauthentication");
  });

  it("删除连接中心及其专用客户端模块", () => {
    for (const relativePath of [
      "src/components/ServerConnectionCenter.tsx",
      "src/lib/serverProfiles.ts",
      "src/lib/profileCredentialVault.ts",
      "src/lib/serverMigrationV2.ts",
    ]) {
      expect(fs.existsSync(path.resolve(process.cwd(), relativePath))).toBe(false);
    }
  });

  it("删除侧栏账号弹层并保留退出和本地恢复能力", () => {
    const navRailSource = readSource("src/components/NavRail.tsx");
    const dataManagerSource = readSource("src/components/DataManager.tsx");

    expect(navRailSource).not.toContain("accountMenuOpen");
    expect(navRailSource).not.toContain("sidebar.accountMenu");
    expect(navRailSource).not.toContain("当前服务器");
    expect(navRailSource).not.toContain("handleDesktopResetLocalAuth");
    expect(navRailSource).toContain("const handleLogout = useCallback");
    expect(navRailSource).toContain("onClick={handleLogout}");
    expect(navRailSource).toContain("handleDesktopCloudButton");
    expect(dataManagerSource).toContain("resetDesktopLocalAuth");
  });

  it("版本冲突不再出现在数据管理同步卡片中", () => {
    const dataManagerSource = readSource("src/components/DataManager.tsx");
    const editorSource = readSource("src/components/EditorPane.tsx");
    const syncRuntimeSource = readSource("src/components/OfflineSyncRuntime.tsx");
    const syncEngineSource = readSource("src/lib/syncEngine.ts");

    expect(dataManagerSource).not.toContain("待处理冲突");
    expect(dataManagerSource).not.toContain("版本冲突待人工处理");
    expect(dataManagerSource).not.toContain("版本冲突未自动覆盖");
    expect(dataManagerSource).toContain("summary.pending - summary.versionConflicts");
    expect(editorSource).not.toContain("offlineQueue:conflict");
    expect(editorSource).not.toContain("offlineVersionConflict");
    expect(fs.existsSync(path.resolve(process.cwd(), "src/components/common/OfflineIndicator.tsx"))).toBe(false);
    expect(syncRuntimeSource).not.toContain("处理冲突");
    expect(syncRuntimeSource).not.toContain("请选择保留此设备内容");
    expect(syncRuntimeSource).not.toContain("NOTE_CONFLICT_AUTO_RESOLVED_EVENT");
    expect(editorSource).toContain("NOTE_CONFLICT_AUTO_RESOLVED_EVENT");
    expect(editorSource).toContain("handleAutoResolvedConflict");
    expect(editorSource).toContain("persistPendingConflictSnapshot");
    expect(editorSource).toContain("editorHandle.discardPending?.()");
    expect(editorSource).toContain("preserveNoteSyncConflictSnapshot");
    expect(syncEngineSource).not.toContain("请在同步状态面板处理");
  });
});
