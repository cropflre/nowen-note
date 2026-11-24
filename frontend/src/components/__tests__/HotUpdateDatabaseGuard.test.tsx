// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const controller = vi.hoisted(() => ({ check: vi.fn(), apply: vi.fn() }));
vi.mock("@/lib/hotUpdate", () => ({
  getHotUpdateController: () => controller,
  useHotUpdateSnapshot: () => ({ message: "" }),
}));

import HotUpdateDatabaseGuard from "../HotUpdateDatabaseGuard";
import { bootDatabaseGate, shouldConfirmHotUpdateBundle } from "@/lib/hotUpdate/bootGate";
import { NativeDatabaseUpgradeRequiredError } from "@/lib/nativeDatabase";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("DCC-013 热更新回退与本地库版本", () => {
  it("DCC-013: a newer local database boots into the guard page instead of the application", () => {
    expect(bootDatabaseGate(new NativeDatabaseUpgradeRequiredError(14, 13))).toBe("database-guard");
    expect(bootDatabaseGate(new Error("disk full"))).toBe("application");
    expect(bootDatabaseGate(null)).toBe("application");
  });

  it("DCC-013: a bundle that cannot open the database is never confirmed, so the plugin rolls it back", () => {
    expect(shouldConfirmHotUpdateBundle(null)).toBe(true);
    expect(shouldConfirmHotUpdateBundle(new Error("migration crashed"))).toBe(false);
    expect(shouldConfirmHotUpdateBundle(new NativeDatabaseUpgradeRequiredError(14, 13))).toBe(true);
  });

  it("DCC-013: the guard page only offers safe recovery and may retry a blocked newer bundle", async () => {
    controller.check.mockResolvedValue({ phase: "ready" });
    await act(async () => root.render(<HotUpdateDatabaseGuard databaseVersion={14} supportedVersion={13} />));
    const buttons = Array.from(host.querySelectorAll("button")).map((item) => item.textContent?.trim());
    expect(buttons).toEqual(["获取最新版本", "下载最新安装包"]);
    expect(host.textContent).toContain("数据版本 14");
    expect(host.textContent).toContain("完整地保存在本机");
    await act(async () => {
      host.querySelectorAll("button")[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(controller.check).toHaveBeenCalledWith({ manual: true, retryBlocked: true });
    expect(controller.apply).toHaveBeenCalledTimes(1);
  });

  it("DCC-013: without a usable newer bundle the guard keeps the data untouched and does not restart", async () => {
    controller.check.mockResolvedValue({ phase: "up-to-date" });
    await act(async () => root.render(<HotUpdateDatabaseGuard databaseVersion={14} supportedVersion={13} />));
    await act(async () => {
      host.querySelectorAll("button")[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(controller.apply).not.toHaveBeenCalled();
  });
});
