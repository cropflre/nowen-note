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
});
