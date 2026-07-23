import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("ServerConnectionCenter account switching", () => {
  it("exposes connection and migration actions from the shared account entry", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "src/components/NavRail.tsx"), "utf8");
    expect(source).toContain("window.dispatchEvent(new Event(SERVER_CONNECTION_CENTER_OPEN_EVENT))");
    expect(source).toContain("连接与账号");
    expect(source).toContain("迁移数据");
    expect(source).not.toContain('aria-label="服务端与迁移中心"');
    expect(source).not.toContain("isDesktopApp() ? getActiveServerProfile() : null");
  });

  it("keeps the dialog task-oriented instead of exposing a permanent migration center", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "src/components/ServerConnectionCenter.tsx"), "utf8");
    expect(source).toContain('<h2 className="font-semibold">连接与账号</h2>');
    expect(source).toContain('type Tab = "profiles" | "migration"');
    expect(source).toContain("直接切换，不迁移");
    expect(source).toContain("迁移本地数据后切换");
    expect(source).not.toContain('"guide"');
    expect(source).not.toContain("服务端与迁移中心");
  });

  it("preserves scoped offline queues and removes profile secrets once on delete", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "src/components/ServerConnectionCenter.tsx"), "utf8");
    expect(source).not.toContain("clearQueue()");
    expect(source).not.toContain("clearLocalIdMap()");
    expect(source.match(/removeProfileCredential\(profile\.id\)/g)).toHaveLength(2);
    expect(source).toContain("stagePendingProfileReauthentication(profile)");
  });

  it("removes the superseded light migration implementation", () => {
    expect(fs.existsSync(path.resolve(process.cwd(), "src/components/MigrationModal.tsx"))).toBe(false);
    expect(fs.existsSync(path.resolve(process.cwd(), "src/lib/migrationEngine.ts"))).toBe(false);
  });
});
