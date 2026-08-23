import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api.impl";
import { MobileLocalModeRemoteRequestError } from "@/lib/mobileLocalMode";

describe("Android 本地模式远程 API 隔离", () => {
  beforeEach(() => {
    localStorage.clear();
    (window as any).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => "android",
      platform: "android",
    };
  });

  it("未登录时在发出网络请求前拒绝非本地 API", async () => {
    const network = vi.spyOn(globalThis, "fetch");

    await expect(api.getMe()).rejects.toBeInstanceOf(MobileLocalModeRemoteRequestError);
    expect(network).not.toHaveBeenCalled();

    network.mockRestore();
  });
});
